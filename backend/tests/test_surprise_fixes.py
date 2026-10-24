"""Regressions found by tests/fuzz_surprise.py (seed 20261024): each case is the smallest input that used to fail."""
from __future__ import annotations

from engine.pipeline import run
from tests.helpers import row, table
from verify.checks import verify_rows


def verified(out):
    return verify_rows(out.rows, out.signals, out.rules.rs, out.settings, out.tqs)


def alarm(tag: str, room: str, area: str):
    return row(tag, "DI", "Internal Wiring", None, 1, room=room, area=area, equipment="P24-DCM-50002-01", spec="-")


def test_room_and_area_spelling_do_not_split_a_controller_domain():
    rows = [row(f"T-{p}", "AI", "CB-1", p, 12, room="PIB-24" if p % 2 else "pib-24 ", area="RA 500-02" if p % 3 else "ra  500-02")
            for p in range(1, 13)]
    rows += [alarm("500-EJA-1-T", "PIB-24", "RA 500-02"), alarm("500-eja-1-ac", "pib-24", "RA 500-02"),
             alarm("500-EJA-1-DC", " PIB-24", "Ra 500-02")]
    out = run(None, table=table(rows))
    assert {s.domain for s in out.signals if s.live} == {"PIB-24|RA 500-02"}
    assert not [t for t in out.tqs if t.category == "Cable spans domains"]
    rep = verified(out)
    assert rep.verdict == "PASS", [(c.id, v.message) for c in rep.checks for v in c.violations]
    alarms = [r for r in out.rows if r["Tag Status"] == "Cabinet Alarm"]
    assert len(alarms) == 3 and {r["Electronic/ Marshalling Cabinet"] for r in alarms} == {"P24-DCM-50002-01"}


def csv_bytes(rows, titles, delimiter=";"):
    from tests.helpers import HEADERS
    lines = [*titles, delimiter.join(HEADERS)]
    lines += [delimiter.join(r.get(h, "") for h in HEADERS) for r in rows]
    return "\r\n".join(lines).encode("latin-1", errors="replace")


def test_semicolon_csv_with_title_rows_above_the_header_is_read():
    from xio.reader import read_table
    rows = [row(f"T-{p}", "AI", "CB-1", p, 12) for p in range(1, 13)]
    data = csv_bytes(rows, ["PROJECT 4471 — IO LIST", "", "Rev A;2026-10-24;Issued for design", "Confidential"])
    t = read_table(data, filename="io.csv")
    assert t.header_row == 5 and "Tag Number" in t.headers and len(t.rows) == 12
    out = run(data, filename="io.csv")
    assert out.kpis.allocated == 12 and not [t for t in out.tqs if t.category.startswith("SYS-")]
    assert verified(out).verdict == "PASS"


def test_spare_slots_take_their_cabinets_unit_not_the_domains_first_signal():
    from app.schemas import ProjectSettings
    rows = []
    for c in range(1, 31):                                       # 30 cables of 12 pairs → two cabinets in one domain
        for p in range(1, 13):
            r = row(f"U{c:02d}-{p:02d}", "AI", f"CB-{c:02d}", p, 12)
            r["WBS"] = "320" if c <= 15 else "500"           # the domain mixes units; the second cabinet only has unit 500
            rows.append(r)
    out = run(None, settings=ProjectSettings(cpsat_enabled=False), table=table(rows))
    cabs = {r["Electronic/ Marshalling Cabinet"] for r in out.rows if r["Tag Status"] == "Field"}
    assert len(cabs) == 2
    rep = verified(out)
    assert rep.verdict == "PASS", [(c.id, v.message) for c in rep.checks for v in c.violations][:3]
    second = sorted(cabs)[1]
    assert {r["Unit"] for r in out.rows if r["Electronic/ Marshalling Cabinet"] == second and r["Tag Status"] == "Spare Slot"} == {"500"}


# ───────────────────────────── pair spellings (app.pairs is shared by the normaliser and the verifier) ─────────────────────────────

import pytest

ACCEPTED = [("Pair 3", 3), ("PAIR  3", 3), ("pair 3", 3), ("P3", 3), ("p3", 3), ("P-3", 3), ("Pair-3", 3), ("Pair_3", 3),
            ("Pair No. 3", 3), ("pair no 3", 3), ("PR3", 3), ("pr 3", 3), ("#3", 3), ("3", 3), ("03", 3), ("3.0", 3), ("3,0", 3),
            ("  Pair 3  ", 3), (" P3\t", 3), ("Pair #10", 10), ("Triad 1", 1), ("12", 12), ("24.00", 24)]
REJECTED = ["3-5", "3 - 5", "3,5", "3.5", "3.50", "3/4", "3 4", "3:0", "1:0", "0", "00", "Pair 0", "-3", "Pair -3", "P -3", "-1",
            "Pair", "P", "abc", "Pair X", "3a", "a3b", "Pair 3 and 4", "12345", "Pair 3.5", "٣", "3.0.0", "--"]


@pytest.mark.parametrize("text,n", ACCEPTED)
def test_pair_spellings_parse_to_the_pair_number(text, n):
    from engine.normalise import parse_pair
    from verify.checks import _pair
    assert parse_pair(text) == n and _pair(text) == n               # the normaliser and the verifier agree


@pytest.mark.parametrize("text", REJECTED)
def test_ambiguous_pair_text_is_never_guessed(text):
    from engine.normalise import parse_pair
    from verify.checks import _pair
    assert parse_pair(text) is None and _pair(text) is None


@pytest.mark.parametrize("text", ["3-5", "3.5", "0", "-3", "Pair", "3/4", "Pair 3 and 4"])
def test_rejected_pair_is_quarantined_with_an_unreadable_pair_tq_and_the_rest_still_allocates(text):
    rows = [row(f"T-{p}", "AI", "CB-1", p, 12) for p in range(1, 13)]
    rows[4]["Pair Number"] = text
    out = run(None, table=table(rows))
    bad = next(s for s in out.signals if s.tag == "T-5")
    assert bad.quarantined and bad.pair is None
    tq = next(t for t in out.tqs if t.category == "Unreadable pair")
    assert tq.rows == [bad.row] and tq.tags == ["T-5"] and text in tq.message
    assert out.kpis.allocated == 11 and verified(out).verdict == "PASS"


def test_accepted_spelling_is_placed_on_its_own_pair_and_verifies():
    spell = ["P{n}", "Pair-{n}", "Pair_{n}", "PR{n}", "#{n}", "{n}.0", "{n},0", "{n:02d}", "Pair No. {n}", "p-{n}", "Pair {n}", "{n}"]
    rows = [row(f"T-{p}", "AI", "CB-1", None, 12) for p in range(1, 13)]
    for p, r in enumerate(rows, start=1):
        r["Pair Number"] = spell[p - 1].format(n=p)
    out = run(None, table=table(rows))
    assert out.kpis.allocated == 12 and not [t for t in out.tqs if t.category in ("Unreadable pair", "Missing pair")]
    assert [s.pair for s in sorted(out.signals, key=lambda s: s.row)] == list(range(1, 13))
    field = {r["Tag Name"]: r for r in out.rows if r["Tag Status"] == "Field"}
    assert [field[f"T-{p}"]["Field Cable Pair"] for p in range(1, 13)] == [spell[p - 1].format(n=p) for p in range(1, 13)]   # written as in the MDB
    assert verified(out).verdict == "PASS"


def test_pair_larger_than_the_cable_still_raises_the_existing_tq():
    rows = [row(f"T-{p}", "AI", "CB-1", None, 12) for p in range(1, 4)]
    for r, text in zip(rows, ["P3", "Pair-13", "5.0"]):
        r["Pair Number"] = text
    out = run(None, table=table(rows))
    tq = next(t for t in out.tqs if t.category == "Pair exceeds cable size")
    assert tq.tags == ["T-2"] and out.kpis.allocated == 2


def test_drill_b_with_only_the_pair_spelling_changed_places_exactly_what_it_placed_before(tmp_path):
    import re
    from pathlib import Path

    import openpyxl
    from xio.reader import read_table

    src = Path(__file__).resolve().parents[2] / "data" / "drills" / "drill_B_title_rows_blank_rows_junk.xlsx"
    base = run(src)
    t = read_table(src)
    ph = next(m.source for m in base.mapping if m.field == "pair")
    spell = ["P{n}", "Pair-{n}", "{n}.0", "PR{n}", "#{n}", "Pair_{n}", "{n},0", "P-{n}", "{n}", "Pair No. {n}"]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(t.headers)
    for k, (_, rec) in enumerate(t.rows):
        m = re.fullmatch(r"(?i)pair\s+(\d+)", rec.get(ph, ""))
        if m:
            rec = {**rec, ph: spell[k % len(spell)].format(n=int(m.group(1)))}       # junk ("1:0", "Pair 99", blank) stays as it was
        ws.append([rec.get(h, "") for h in t.headers])
    dst = tmp_path / "drill_b_spelled.xlsx"
    wb.save(dst)
    out = run(dst)
    assert base.kpis.allocated > 150
    assert out.kpis.allocated == base.kpis.allocated and out.kpis.signals == base.kpis.signals
    unreadable = [q for q in out.quarantine if "unreadable" in q.reason]
    assert len(unreadable) == len([q for q in base.quarantine if "unreadable" in q.reason])     # only the deliberate junk row
    assert verified(out).verdict == "PASS"
