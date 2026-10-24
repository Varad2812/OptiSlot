"""Regression tests from the adversarial MDB: engine and verifier must agree on a cable's home, and the scoreboard,
blank-status and alarm-overflow TQs must be honest."""
from __future__ import annotations

from pathlib import Path

from engine.pipeline import run
from tests.helpers import row, table
from verify.checks import verify_rows

FIXTURE = Path(__file__).parent / "fixtures" / "OptiSlot_Adversarial_MDB.xlsx"


def verified(out):
    return verify_rows(out.rows, out.signals, out.rules.rs, out.settings, out.tqs)


def placed_cabinet(out, tag: str) -> str | None:
    key = tag.replace(" ", "")
    return next((r["Electronic/ Marshalling Cabinet"] for r in out.rows
                 if r["Tag Name"].replace(" ", "") == key and r["Tag Status"] in ("Field", "Cabinet Alarm")), None)


def test_adversarial_mdb_passes_every_check():
    out = run(FIXTURE)
    rep = verified(out)
    assert rep.verdict == "PASS" and rep.violations == 0
    assert rep.checks_total == 21 and rep.checks_passed == 21
    assert next(c for c in rep.checks if c.id == "C10").failed == 0
    assert len(out.quarantine) == 7                      # exactly the seven deliberately broken rows


def test_blank_area_row_inherits_its_cables_cabinet():
    out = run(FIXTURE)
    row49 = next(s for s in out.signals if s.row == 49)
    assert row49.area == "-" and not row49.quarantined
    cab = placed_cabinet(out, row49.tag)
    assert cab == placed_cabinet(out, "320-LT   -20363") and cab.startswith("P30-DCM-32001-")        # same cable 320-CE-0040
    proj = next(t for t in out.tqs if t.category == "Unmapped area")
    assert proj.id == "TQ-PROJ-001" and proj.severity == "low" and 49 in proj.rows
    cbl = next(t for t in out.tqs if t.category == "Cable spans domains")
    assert 49 in cbl.rows and "row 49" in cbl.message and "no usable room/area" in cbl.message and "PIB-30|RA 320-01" in cbl.message


def test_cable_with_conflicting_areas_stays_together_and_verifies():
    rows = [row(f"T-{p}", "AI", "CB-1", p, 12, area="RA 320-01" if p != 3 else "RA 410-02") for p in range(1, 13)]
    rows += [row(f"U-{p}", "AI", "CB-2", p, 12, area="RA 410-02") for p in range(1, 13)]
    out = run(None, table=table(rows))
    rep = verified(out)
    assert rep.verdict == "PASS", [v.message for c in rep.checks for v in c.violations]
    cabs = {placed_cabinet(out, f"T-{p}") for p in range(1, 13)}
    assert len(cabs) == 1                                  # the cable lands together, in the majority domain
    cbl = next(t for t in out.tqs if t.category == "Cable spans domains")
    assert "2 controller domains" in cbl.message and "most of its rows" in cbl.message


def test_first_row_with_blank_area_does_not_decide_the_cables_domain():
    rows = [row("T-1", "AI", "CB-1", 1, 12, area="")] + [row(f"T-{p}", "AI", "CB-1", p, 12) for p in range(2, 13)]
    out = run(None, table=table(rows))
    assert verified(out).verdict == "PASS"
    assert placed_cabinet(out, "T-1") == placed_cabinet(out, "T-2") and "32001" in placed_cabinet(out, "T-1")


def test_c10_still_catches_a_signal_in_the_wrong_cabinet():
    out = run(FIXTURE)
    rows = [dict(r) for r in out.rows]
    victim = next(r for r in rows if r["Tag Name"].replace(" ", "") == "320-LT-20363")
    victim["Electronic/ Marshalling Cabinet"] = "P24-DCM-50002-01"
    rep = verify_rows(rows, out.signals, out.rules.rs, out.settings, out.tqs)
    assert rep.verdict == "FAIL" and any(c.id == "C10" and c.failed for c in rep.checks)


def test_blank_status_raises_one_low_tq_and_still_allocates():
    rows = [row(f"T-{p}", "AI", "CB-1", p, 12, status="" if p in (2, 5) else "New") for p in range(1, 13)]
    out = run(None, table=table(rows))
    tqs = [t for t in out.tqs if t.category == "Status blank"]
    assert len(tqs) == 1 and tqs[0].severity == "low" and tqs[0].rows == [3, 6]       # MDB rows (header is row 1)
    assert tqs[0].message.startswith("Status blank — treated as New")
    assert out.kpis.allocated == 12 and verified(out).verdict == "PASS"
    assert not any(t.category == "Status blank" for t in run(None, table=table(rows[:1] + [row("T-9", "AI", "CB-1", 9, 12)])).tqs)


def test_adversarial_kpis_separate_placed_from_accounted():
    k = run(FIXTURE).kpis
    assert (k.signals, k.allocated, k.unallocated_with_tq) == (188, 181, 7)
    assert k.allocated_pct == round(100 * 181 / 188, 1) < 100.0           # placed: never 100 % while rows are quarantined
    assert k.accounted_pct == 100.0                                        # accounted for: a slot or a TQ for every live signal


def test_cabinet_alarm_overflow_is_one_tq_per_cabinet():
    rows = [row(f"XA-{i}", "DI", "Internal Wiring", None, spec="-") for i in range(1, 111)] + [row(f"PT-{i}", "AI", "CB-1", i, 12) for i in range(1, 13)]
    out = run(None, table=table(rows))
    ovf = [t for t in out.tqs if t.category == "Cabinet alarm overflow"]
    assert len(ovf) == 1 and ovf[0].severity == "high" and len(ovf[0].rows) == 14
    assert "14 alarms not allocated" in ovf[0].message and "baseplates 2, 3, 4, 5, 6, 7, 8 also reserved" in ovf[0].message
    assert len({q.tq_id for q in out.quarantine if q.reason.startswith("no room")}) == 1
