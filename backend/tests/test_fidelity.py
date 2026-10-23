"""Column fidelity vs the reference, the terminal table (C20) and IS / NON-IS segregation (rule r-is, check C07.2)."""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.drafting import _templates
from engine.pipeline import run
from engine.rules import load_ruleset
from tests.helpers import row, table, with_strategy
from tests.test_verify import claims
from verify.checks import verify_rows

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import fidelity  # noqa: E402

MDB = ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx"
REF = ROOT / "data" / "Sample_IO_Allocation_VIT_v2_1.xlsx"


def verify(out, rs=None):
    return verify_rows(out.rows, out.signals, rs or out.rules.rs, out.settings, out.tqs, claims=claims(out))


def check(rep, cid):
    return next(c for c in rep.checks if c.id == cid)


def ruleset(**is_params):
    rs = load_ruleset()
    r = next(r for r in rs.rules if r.id == "r-is")
    r.params.update(is_params)
    return rs


def is_by_baseplate(out) -> dict[tuple, set[str]]:
    fams: dict[tuple, set[str]] = defaultdict(set)
    for r in out.rows:
        if r["Tag Status"] in ("Field", "Wired Spare"):
            fams[(r["CIOC/CSLS Name"], r["Baseplate"])].add(r["NON-IS / IS"])
    return fams


# ───────────────────────────── fidelity on the sample ─────────────────────────────

@pytest.fixture(scope="module")
def fid():
    return fidelity.compare(run(MDB).rows, fidelity.read_reference(REF))


@pytest.mark.parametrize("col", ["CHARM TB1", "CHARM TB2", "CHARM TB3", "Signal Type", "Signal Level", "NON-IS / IS",
                                 "Equipment Name", "Service Description", "Location", "HW Loop Typical",
                                 "Instrument type", "Loop Name", "DSTName", "CHARM Type", "CHARM TB Part No"])
def test_column_matches_reference(fid, col):
    s = fid["columns"][col]
    assert s["match"] == s["total"], s["mismatches"][:5]


def test_fidelity_floor(fid):
    assert fid["common"] >= 188 and fid["cells_pct"] >= 97.8


def test_cabinet_alarm_remarks_follow_the_rule(fid):
    """Only alarms on 'Internal Wiring' carry the remark; system-cabinet alarms on real cables do not."""
    alarms = {r["Tag Name"] for r in fidelity.read_reference(REF) if r["Tag Status"] == "Cabinet Alarm"}
    assert len(alarms) == 12
    assert not [m for m in fid["columns"]["Remarks"]["mismatches"] if m["tag"] in alarms]


# ───────────────────────────── terminal table (C20) ─────────────────────────────

def test_terminals_learned_rows():
    rows = [row("T-1", "AI", "C-1", 1, 6, sig="RTD", level="3-Wire"), row("T-2", "AI", "C-1", 2, 6, level="4-Wire"),
            row("T-3", "AO", "C-1", 3, 6), row("T-4", "DI", "C-1", 4, 6, sig="-", level="Voltfree-contact"),
            row("T-5", "DO", "C-2", 1, 2, sig="-", level="Volt-contact", inst="XYV"),
            row("T-6", "DO", "C-2", 2, 2, sig="-", level="Volt-contact", inst="XA"),
            row("T-7", "AI", "C-3", 1, 2, sig="4-20 mA", level="4 wire")]  # unseen spelling → generic fallback
    out = run(b"", table=table(rows))
    got = {r["Tag Name"]: (r["CHARM TB1"], r["CHARM TB2"], r["CHARM TB3"]) for r in out.rows if r["Tag Status"] == "Field"}
    assert got == {"T-1": ("1", "2", "4"), "T-2": ("-", "2", "4"), "T-3": ("1", "2", "-"), "T-4": ("1", "2", "-"),
                   "T-5": ("-", "2", "4"), "T-6": ("1", "2", "-"), "T-7": ("-", "2", "4")}
    assert verify(out).verdict == "PASS"


def test_tampered_terminal_fails_c20():
    out = run(MDB)
    rows = [dict(r) for r in out.rows]
    i = next(i for i, r in enumerate(rows) if r["Tag Status"] == "Field" and r["CHARM TB3"] == "-")
    rows[i]["CHARM TB3"] = "4"
    rep = verify_rows(rows, out.signals, out.rules.rs, out.settings, out.tqs)
    c = check(rep, "C20")
    assert rep.verdict == "FAIL" and c.failed == 1 and c.violations[0].row == i + 2
    assert not check(rep, "C09").failed  # CHARM/TB part numbers themselves are still right


# ───────────────────────────── IS / NON-IS segregation ─────────────────────────────

def mixed_rows(n_cables: int = 8) -> list[dict]:
    """Small cables alternating IS / NON-IS: without the rule they would pack into shared baseplates."""
    rows = []
    for c in range(n_cables):
        size = 6 if c % 3 else 2
        for p in range(1, size + 1):
            rows.append(row(f"X{c}-{p}", "AI", f"CB-{c:02d}", p, size, is_type="IS" if c % 2 else "NON-IS"))
    return rows


@pytest.mark.parametrize("strategy", ["balanced", "compact"])
def test_is_never_shares_a_baseplate(strategy):
    out = run(b"", with_strategy(load_ruleset(), strategy), table=table(mixed_rows()))
    assert all(len(f) == 1 for f in is_by_baseplate(out).values())
    rep = verify(out)
    assert rep.verdict == "PASS" and check(rep, "C07.2").passed > 0
    why = [w.text for s in out.alloc.slots if s.status == "Field" for w in s.why if w.rule_id == "r-is"]
    assert why and all("baseplate" in w for w in why)


def test_is_violation_caught_by_independent_verifier():
    """Allocate with the rule OFF (signals share baseplates), verify against the rule ON → C07.2 fails."""
    off = load_ruleset()
    next(r for r in off.rules if r.id == "r-is").enabled = False
    out = run(b"", off, table=table(mixed_rows()))
    assert any(len(f) > 1 for f in is_by_baseplate(out).values())
    rep = verify(out, load_ruleset())
    c = check(rep, "C07.2")
    assert rep.verdict == "FAIL" and c.failed > 0 and "baseplate" in c.violations[0].message


@pytest.mark.parametrize("level,key", [("cioc", ("CIOC/CSLS Name",)), ("cabinet", ("Electronic/ Marshalling Cabinet",))])
def test_is_levels(level, key):
    out = run(b"", ruleset(level=level), table=table(mixed_rows()))
    fams: dict[tuple, set[str]] = defaultdict(set)
    for r in out.rows:
        if r["Tag Status"] in ("Field", "Wired Spare"):
            fams[tuple(r[k] for k in key)].add(r["NON-IS / IS"])
    assert all(len(f) == 1 for f in fams.values())
    assert verify(out).verdict == "PASS"


def test_missing_is_is_non_is_with_one_tq():
    rows = mixed_rows(4)
    for r in rows[:5]:
        r["Execution"] = ""
    rows[6]["Execution"] = "weird"
    out = run(b"", table=table(rows))
    blank = [t for t in out.tqs if t.category == "NON-IS / IS missing"]
    odd = [t for t in out.tqs if t.category == "Unrecognised NON-IS / IS"]
    assert len(blank) == 1 and "5 signal(s)" in blank[0].message and "NON-IS" in blank[0].message
    assert len(odd) == 1 and "'weird'" in odd[0].message
    assert not blank[0].rows and not blank[0].tags  # must never excuse a missing tag in C01
    assert verify(out).verdict == "PASS"


def test_missing_is_column_one_tq():
    out = run(b"", table=table(mixed_rows(3), headers=[h for h in table([]).headers if h != "Execution"]))
    assert len([t for t in out.tqs if t.category == "NON-IS / IS missing"]) == 1
    assert verify(out).verdict == "PASS"


def test_is_and_non_is_on_one_cable_is_tq_covered():
    rows = [row(f"M-{p}", "AI", "CB-MIX", p, 6, is_type="IS" if p > 3 else "NON-IS") for p in range(1, 7)]
    rows += [row(f"N-{p}", "AI", "CB-N", p, 6) for p in range(1, 7)]
    out = run(b"", table=table(rows))
    tq = [t for t in out.tqs if t.category == "Segregation clash on one cable" and "r-is" in t.rules_in_conflict]
    assert len(tq) == 1
    rep = verify(out)
    assert rep.verdict == "PASS" and check(rep, "C07.2").excepted > 0


def test_sample_unchanged_by_is_rule():
    """Every sample signal is NON-IS: enabling r-is must not move a single slot."""
    off = load_ruleset()
    next(r for r in off.rules if r.id == "r-is").enabled = False
    a, b = run(MDB), run(MDB, off)
    addr = lambda o: [(r["Tag Name"], r["CIOC/CSLS Name"], r["Baseplate"], r["Channel_No"]) for r in o.rows]  # noqa: E731
    assert addr(a) == addr(b)


mix = st.lists(st.tuples(st.sampled_from([1, 2, 6, 12, 24]), st.sampled_from(["IS", "NON-IS", "", "Ex ia"]),
                         st.sampled_from(["A", "B", "-"]), st.floats(0.1, 1.0)), min_size=1, max_size=40)


@settings(max_examples=80, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(mix, st.sampled_from(["balanced", "compact"]), st.sampled_from(["baseplate", "cioc"]))
def test_is_engine_and_verifier_agree(m, strategy, level):
    rows = []
    for c, (size, is_type, grp, fill) in enumerate(m):
        for p in range(1, max(1, int(size * fill)) + 1):
            rows.append(row(f"T{c}-{p}", "AI", f"CB-{c:03d}", p, size, group=grp, is_type=is_type))
    out = run(b"", with_strategy(ruleset(level=level), strategy), table=table(rows))
    rep = verify(out)
    assert rep.verdict == "PASS", [(c.id, c.violations[:3]) for c in rep.checks if c.failed]


# ───────────────────────────── misc ─────────────────────────────

def test_cable_spec_mismatch_writes_one_spec():
    """Found by the junk fuzzer: a 1-triad row kept + its 24-pair twin quarantined → the written size must be 24PX."""
    rows = [row("00", "AI", "0", None, spec="1TX"), row("0", "AI", "0", 1, spec="24PX1MM2")]
    out = run(b"", table=table(rows))
    specs = {r["Field Cable Size"] for r in out.rows if r["Field Cable No"] == "0"}
    assert specs == {"24PX1MM2"}
    assert verify(out).verdict == "PASS"


def test_english_is_rule():
    r = _templates("IS and NON-IS never share a baseplate")
    assert r["params"]["field"] == "is_type" and r["params"]["level"] == "baseplate"
    assert _templates("never mix IS with non-IS on the same cioc")["params"]["level"] == "cioc"


def test_synthetic_nasty_with_is_rows():
    from xio.synthetic import generate, to_table
    h, rows = generate(3000, seed=11, nasty=True)
    out = run(b"", table=to_table(h, rows))
    cats = {t.category for t in out.tqs}
    assert {"NON-IS / IS missing", "Unrecognised NON-IS / IS"} <= cats
    assert any(t.category == "Segregation clash on one cable" and "r-is" in t.rules_in_conflict for t in out.tqs)
    assert {r["NON-IS / IS"] for r in out.rows if r["Tag Status"] == "Field"} >= {"IS", "NON-IS"}
    assert verify(out).verdict == "PASS"
