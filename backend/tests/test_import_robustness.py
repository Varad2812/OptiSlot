"""Import robustness: header row anywhere, best sheet, CSV, many files, low-confidence mappings."""
from __future__ import annotations

import io

import openpyxl
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas import ImportSummary
from engine.pipeline import run
from tests.helpers import HEADERS, row
from xio.reader import auto_map, read_table

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def mdb_rows(prefix="T", cable="CB-1", n=12, io_="AI", size=12):
    return [row(f"{prefix}-{p}", io_, cable, p, size) for p in range(1, n + 1)]


def book(sheets: dict[str, list[list[str]]]) -> bytes:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, grid in sheets.items():
        ws = wb.create_sheet(name)
        for r in grid:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def grid(rows, headers=HEADERS, above=0):
    return [["Project VIT — IO list", "rev 3"] + [""] * 3 for _ in range(above)] + [list(headers)] + [[r.get(h, "") for h in headers] for r in rows]


def test_header_row_anywhere_in_the_first_20_rows():
    data = book({"MDB": grid(mdb_rows(), above=14)})
    t = read_table(data)
    assert t.header_row == 15 and len(t.rows) == 12
    assert run(data, filename="x.xlsx").kpis.allocated == 12


def test_multi_sheet_picks_the_best_mapping():
    decoy = [["Tag Number", "Status"], ["T-1", "New"], ["T-2", "New"]] + [["T-%d" % i, "New"] for i in range(3, 40)]
    data = book({"Cover": [["Project VIT"], ["Rev A"]], "Tags only": decoy, "Real IO list": grid(mdb_rows())})
    t = read_table(data)
    assert t.sheet == "Real IO list" and any("Tags only" in n for n in t.notes)
    assert run(data, filename="x.xlsx").kpis.allocated == 12


@pytest.mark.parametrize("delim", [",", ";", "\t", "|"])
def test_csv_is_accepted(delim):
    lines = [delim.join(HEADERS)] + [delim.join(r.get(h, "") for h in HEADERS) for r in mdb_rows()]
    out = run("\n".join(lines).encode("utf-8-sig"), filename="mdb.csv")
    assert out.table.sheet == "CSV" and out.kpis.allocated == 12


def test_unusual_header_names_are_flagged_for_confirmation():
    headers = ["Item Tag" if h == "Tag Number" else h for h in HEADERS]
    m = {x.field: x for x in auto_map(headers)}
    assert m["tag"].source == "Item Tag" and m["tag"].confidence < 0.7 and m["tag"].needs_confirmation
    assert not m["io_type"].needs_confirmation and m["io_type"].confidence == 1.0
    assert not any(x.needs_confirmation for x in auto_map(HEADERS))
    # an explicit override is a confirmation
    assert not {x.field: x for x in auto_map(headers, {"tag": "Item Tag"})}["tag"].needs_confirmation


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_import_response_flags_low_confidence_fields(client):
    headers = ["Item Tag" if h == "Tag Number" else h for h in HEADERS]
    data = book({"MDB": grid([{**r, "Item Tag": r["Tag Number"]} for r in mdb_rows()], headers)})
    pid = "lowconf"
    client.post("/api/projects/demo/import", files={"file": ("lowconf.xlsx", data, XLSX)})
    s = ImportSummary.model_validate(client.post("/api/projects/demo/import", files={"file": ("lowconf.xlsx", data, XLSX)}).json())
    assert s.needs_confirmation == ["tag"] and next(m for m in s.mapping if m.field == "tag").needs_confirmation
    assert s.live_rows == 12 and any("Sheet 'MDB'" in n for n in s.notes)
    restore(client)


def restore(client):
    from tests.test_api import MDB
    client.post("/api/projects/demo/import", files={"file": ("Sample.xlsx", MDB.read_bytes(), XLSX)})


def test_many_files_are_merged_with_duplicate_detection(client):
    a = book({"MDB": grid(mdb_rows("A", "CB-A") + mdb_rows("DUP", "CB-D", 2, "DI", 2))})
    # second file: other column names, one tag that is also in file A
    alt = ["TagNo" if h == "Tag Number" else "IO Type" if h == "I/O Type Name" else h for h in HEADERS]
    rows_b = mdb_rows("B", "CB-B") + [row("DUP-1", "DI", "CB-X", 1, 2)]
    b = book({"IO list": grid([{**r, "TagNo": r["Tag Number"], "IO Type": r["I/O Type Name"]} for r in rows_b], alt)})
    r = client.post("/api/projects/demo/import", files=[("files", ("A.xlsx", a, XLSX)), ("files", ("B.xlsx", b, XLSX))])
    assert r.status_code == 200, r.text
    s = ImportSummary.model_validate(r.json())
    assert s.rows == 14 + 13 and any("Merged from 2 file" in n for n in s.notes)
    alloc = client.get("/api/projects/demo/allocation").json()
    dup = [t for t in alloc["tqs"] if t["category"] == "Duplicate tag across files"]
    assert dup and "A.xlsx" in dup[0]["message"] and "B.xlsx" in dup[0]["message"]
    assert alloc["report"]["verdict"] == "PASS" and alloc["kpis"]["allocated"] == 12 + 2 + 12
    restore(client)


def test_unreadable_upload_is_rejected_and_keeps_the_project(client):
    before = client.get("/api/projects/demo/allocation").json()["certificate"]["output_sha256"]
    r = client.post("/api/projects/demo/import", files={"file": ("junk.xlsx", b"\x89PNG" + bytes(100), XLSX)})
    assert r.status_code == 422
    r = client.post("/api/projects/demo/import", files=[("files", ("A.xlsx", book({"MDB": grid(mdb_rows())}), XLSX)),
                                                         ("files", ("bad.xlsx", b"nope", XLSX))])
    assert r.status_code == 422 and "bad.xlsx" in r.json()["detail"]
    assert client.get("/api/projects/demo/allocation").json()["certificate"]["output_sha256"] == before
