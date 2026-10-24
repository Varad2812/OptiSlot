"""Part numbers, remark text and IO-order fallbacks live in the rule set / catalogue — never in engine or verifier code."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.schemas import ProjectSettings
from engine.pipeline import run
from engine.rules import Rules, load_ruleset
from verify.checks import verify_rows

ROOT = Path(__file__).resolve().parents[2]
MDB = (ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx").read_bytes()
FAST = ProjectSettings(cpsat_enabled=False)


def _rule(rs, rid):
    return next(r for r in rs.rules if r.id == rid)


def _verify(out, rs):
    return verify_rows(out.rows, out.signals, rs, out.settings, out.tqs)


def test_no_part_numbers_in_engine_or_verifier_code():
    base = ROOT / "backend"
    files = [*base.glob("engine/*.py"), *base.glob("verify/*.py"), *base.glob("xio/*.py"), base / "app" / "schemas.py",
             base / "app" / "service.py", base / "app" / "sandbox.py", base / "app" / "placement.py"]
    skip = {"drills.py"}
    hits = [(f.name, i + 1, m.group(0)) for f in files if f.name not in skip
            for i, line in enumerate(f.read_text().splitlines()) for m in re.finditer(r"\bSE\d{4}[A-Z0-9]*\b", line)]
    assert not hits, hits
    for f in files:
        txt = f.read_text()
        assert "Internal Cabinet Alarm" not in txt and "CHARM PROTECTION" not in txt, f.name


@pytest.fixture(scope="module")
def base():
    rs = load_ruleset()
    return rs, run(MDB, rs, FAST)


def test_spare_slot_hardware_comes_from_the_hardware_map(base):
    rs = load_ruleset()
    _rule(rs, "r-hw").params["spare_slot"] = {"charm": "COVER-X", "tb": "SE4502"}   # not the catalogue's cover
    out = run(MDB, rs, FAST)
    spare = [s for s in out.alloc.slots if s.status == "Spare Slot"]
    assert spare and {(s.charm, s.tb) for s in spare} == {("COVER-X", "SE4502")}
    assert _verify(out, rs).violations == 0            # the verifier read the same data


def test_verifier_flags_spare_slot_hardware_that_disagrees_with_the_map(base):
    rs, out = base
    rs2 = rs.model_copy(deep=True)
    _rule(rs2, "r-hw").params["spare_slot"] = {"charm": "COVER-X", "tb": "SE4501"}
    rep = verify_rows(out.rows, out.signals, rs2, out.settings, out.tqs)
    assert rep.violations > 0 and rep.verdict == "FAIL"


def test_spare_slot_falls_back_to_the_catalogue(base):
    rs = load_ruleset()
    _rule(rs, "r-hw").params.pop("spare_slot")
    out = run(MDB, rs, FAST)
    assert {(s.charm, s.tb) for s in out.alloc.slots if s.status == "Spare Slot"} == {("SE6103", "SE4501")}
    assert _verify(out, rs).violations == 0


def test_review_exemption_is_data(base):
    """DO hardware conflict TQ: raised for standard-DO alarm outputs, never for hardware listed in `exempt_charms`."""
    rs, out = base
    assert any(t.category == "DO hardware conflict" for t in out.tqs)
    rs2 = rs.model_copy(deep=True)
    p = _rule(rs2, "r-hw").params
    p["review"]["exempt_charms"] = [p["rows"][-1]["charm"]]            # exempt the standard DO charm too
    out2 = run(MDB, rs2, FAST)
    assert not any(t.category == "DO hardware conflict" for t in out2.tqs)


def test_alarm_remark_text_comes_from_the_rule(base):
    rs = load_ruleset()
    _rule(rs, "r-alarm-bp").params["remarks"] = "Panel alarm (rule text)."
    out = run(MDB, rs, FAST)
    alarms = [s for s in out.alloc.slots if s.status == "Cabinet Alarm"]
    assert alarms and {s.remarks for s in alarms} == {"Panel alarm (rule text)."}
    rs2 = load_ruleset()
    _rule(rs2, "r-alarm-bp").params.pop("remarks")
    out2 = run(MDB, rs2, FAST)
    assert {s.remarks for s in out2.alloc.slots if s.status == "Cabinet Alarm"} == {"-"}     # no invented text


def test_io_order_needs_no_fallback_list(base):
    """Without an io_type_map rule the wired-spare pass still runs (IO order comes from the hardware map)."""
    rs = load_ruleset()
    rs.rules = [r for r in rs.rules if r.type != "io_type_map"]
    out = run(MDB, rs, FAST)
    assert Rules(rs).io_types() == ["AIR", "AOR", "DIR", "DOR"]        # from the hardware-map rows
    assert out.kpis.wired_spares > 0
    assert _verify(out, rs).violations == 0


def test_unknown_do_tq_words_the_hardware_from_the_map():
    rs = load_ruleset()
    p = _rule(rs, "r-hw").params
    p["rows"][-1]["charm"] = "SE4301T02"           # the "unknown instrument" fallback row now uses another part
    for r in p["rows"]:
        if r["when"].get("instrument_type") == "@high_current_do":
            r["charm"], r["tb"] = "SE4303T03", "SE4502"
    rows = [{"Tag Number": "T-1", "Instrument Type": "UZV", "Status": "New", "I/O Type Name": "DO", "Signal Type": "-",
             "Signal Level": "-", "Multi-cable / Cable": "12PX", "Multipair Cable No.": "C-1", "Pair Number": "Pair 1"}]
    from tests.helpers import HEADERS, table
    out = run(MDB, rs, FAST, table=table(rows, HEADERS))
    t = next(t for t in out.tqs if t.category == "Unknown DO type")
    assert "SE4301T02" in t.message and "SE4501" in t.message
    assert any("SE4303T03" in f.label and "SE4502" in f.label for f in t.fix_options)
