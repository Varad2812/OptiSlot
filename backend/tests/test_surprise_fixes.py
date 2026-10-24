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
