"""Hypothesis: random custom rules over random cable mixes — the engine never raises, and the independent verifier agrees with it
(0 violations: every rule is either kept or a clash is a TQ-covered exception)."""
from __future__ import annotations

import os

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.schemas import Rule
from engine.pipeline import run
from engine.rules import load_ruleset
from tests.helpers import row, table
from verify.checks import verify_rows

EXAMPLES = int(os.environ.get("OPTISLOT_PROP_EXAMPLES", "300"))
PROFILE = settings(max_examples=EXAMPLES, deadline=None, suppress_health_check=list(HealthCheck), derandomize=True)

IO = st.sampled_from(["AI", "AO", "DI", "DO"])
INST = st.sampled_from(["PT", "TT", "XA", "XYV", "UZV"])
SCOPE = st.sampled_from(["baseplate", "cioc", "cabinet"])


@st.composite
def filters(draw):
    f: dict = {}
    if draw(st.booleans()):
        f["io_type"] = draw(st.lists(IO, min_size=1, max_size=2, unique=True))
    if draw(st.booleans()):
        f["instrument_type"] = draw(st.sampled_from(["PT", "XA*", "*Y*", "TT"]))
    if draw(st.booleans()):
        f["tag"] = draw(st.sampled_from(["T0*", "T1?-*", "*-1", "T*"]))
    if draw(st.integers(0, 4)) == 0:
        f["not"] = {"instrument_type": draw(INST)}
    return f


@st.composite
def custom_rules(draw):
    t = draw(st.sampled_from(["max_per_scope", "scope_relation", "forbid_mix", "zone_cabinets", "extra_spares"]))
    if t == "max_per_scope":
        p = {"filter": draw(filters()), "scope": draw(SCOPE), "max": draw(st.integers(0, 8))}
    elif t == "scope_relation":
        p = {"filter_a": draw(filters()), "filter_b": draw(filters()), "scope": draw(SCOPE),
             "relation": draw(st.sampled_from(["same", "different"]))}
        if draw(st.booleans()):
            p["group_by"] = draw(st.sampled_from(["cable", "group", "instrument_type"]))
    elif t == "forbid_mix":
        a, b = draw(st.lists(IO, min_size=2, max_size=2, unique=True))
        p = {"io_type_a": [a], "io_type_b": [b], "scope": draw(st.sampled_from(["baseplate", "cioc"]))}
    elif t == "zone_cabinets":
        p = {"filter": draw(filters()), "cabinets": draw(st.lists(st.integers(1, 3), min_size=1, max_size=2, unique=True))}
    else:
        p = {"io_type": draw(IO), "extra_pct": draw(st.sampled_from([0, 5, 20])), "extra_count": draw(st.integers(0, 3))}
        if not p["extra_pct"] and not p["extra_count"]:
            p["extra_count"] = 1
    return {"id": f"c-{draw(st.integers(1, 99))}", "type": t, "label": f"random {t}", "params": p,
            "severity": draw(st.sampled_from(["hard", "hard", "soft"])), "enabled": True}


@st.composite
def tables(draw):
    rows = []
    for c in range(draw(st.integers(1, 7))):
        size = draw(st.sampled_from([1, 2, 6, 12, 24]))
        pairs = draw(st.lists(st.integers(1, size), min_size=1, max_size=min(size, 14), unique=True))
        group = draw(st.sampled_from(["A", "B", "-", "-"]))
        for p in pairs:
            tag = f"T{c}{p % 10}-{p}"
            rows.append(row(tag, draw(IO), f"CB-{c}", p, size, group=group, inst=draw(INST)))
    return rows


@PROFILE
@given(rows=tables(), rules=st.lists(custom_rules(), min_size=1, max_size=3, unique_by=lambda r: r["id"]),
       strategy=st.sampled_from(["balanced", "compact"]))
def test_engine_and_verifier_agree_for_random_custom_rules(rows, rules, strategy):
    rs = load_ruleset("default")
    rs.settings.cioc_strategy = strategy
    rs.rules.extend(Rule.model_validate(r) for r in rules)
    out = run(b"", rs, table=table(rows))
    rep = verify_rows(out.rows, out.signals, rs, out.settings, out.tqs)
    assert not [t for t in out.tqs if t.category.startswith("SYS-")], [t.message for t in out.tqs if t.category.startswith("SYS-")]
    assert rep.violations == 0, [(c.id, c.label, [v.message for v in c.violations[:2]]) for c in rep.checks if c.failed and c.severity == "hard"]
    assert out.kpis.allocated == len({s.tag_key for s in out.signals if s.live and not s.quarantined}), "no live signal is dropped"
    ids = [c.id for c in rep.checks if c.id >= "C23"]
    assert ids == [f"C{23 + i}" for i in range(len(rules))], "one dynamic check per enabled custom rule, numbered from C23"
