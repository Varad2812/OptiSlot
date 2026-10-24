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
