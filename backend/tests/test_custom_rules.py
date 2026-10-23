"""Custom rules: each rule type is obeyed by the engine AND checked by the independent verifier (dynamic check ids C23+)."""
from __future__ import annotations

from collections import Counter, defaultdict

import pytest

from app.customrules import CRule, Flt, RuleError, compile_rule, glob_match, validate_ruleset
from app.schemas import Rule, RuleSet
from engine.pipeline import run
from engine.rules import load_ruleset
from tests.helpers import HEADERS, row, table
from verify.checks import verify_rows

LOOP_HEADERS = [*HEADERS, "Loop Name"]


def rs_with(*rules: dict) -> RuleSet:
    rs = load_ruleset("default")
    rs.rules.extend(Rule.model_validate({"enabled": True, "severity": "hard", **r}) for r in rules)
    return rs


def go(rows, *rules: dict, headers=None, strategy: str = "balanced"):
    rs = rs_with(*rules)
    rs.settings.cioc_strategy = strategy              # compact packs tightly, so a rule's effect is visible
    out = run(b"", rs, table=table(rows, headers or HEADERS))
    rep = verify_rows(out.rows, out.signals, out.rules.rs, out.settings, out.tqs)
    return out, rep


def check_for(rep, rule_id: str):
    return next(c for c in rep.checks if c.rule_id == rule_id and c.id >= "C23")


def where(out):
    return {s.tag: s for s in out.alloc.slots if s.status == "Field"}


# ───────────────────────────── the language ─────────────────────────────

def test_glob_is_case_insensitive_and_only_star_and_question():
    assert glob_match("440-PI-*", "440-pi-20077-L") and glob_match("a?c", "ABC") and not glob_match("a?c", "ac")
    assert glob_match("*", "") and glob_match("a*b*c", "aXXbYYc") and not glob_match("a*b*c", "aXXbYY")
    assert glob_match("a.c", "a.c") and not glob_match("a.c", "abc"), "a dot is a dot — no regular expressions"
    assert not glob_match("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaa!"), "no regex engine → no catastrophic backtracking"


def test_filter_language_and_limits():
    f = Flt({"io_type": ["DOR"], "not": {"instrument_type": "XYV"}, "any": [{"tag": "A-*"}, {"tag": "B-*"}]})
    ctx = {"io_type": "DOR", "instrument_type": "XA", "tag": "A-1", "tag_key": "A-1"}
    assert f.matches(ctx) and not f.matches({**ctx, "instrument_type": "XYV"}) and not f.matches({**ctx, "tag": "C-1", "tag_key": "C-1"})
    assert Flt({"io_type": "DO"}).matches({"io_type": "DOR"}) and Flt({"io_type": "AIR"}).matches({"io_type": "AI"})
    assert Flt({}).matches({}), "an empty filter matches everything"
    for bad in ({"colour": "red"}, {"tag": []}, {"tag": ["x"] * 200}, {"tag": 5 * ["a"] + [""]}, {"not": 3}, {"any": []}, "tag", [1]):
        with pytest.raises(RuleError):
            Flt(bad)
    deep: dict = {}
    for _ in range(8):
        deep = {"not": deep}
    with pytest.raises(RuleError):
        Flt(deep)


@pytest.mark.parametrize("params,needle", [
    ({"scope": "cioc", "max": 3, "oops": 1}, "unknown parameter"),
    ({"filter": {}, "scope": "room", "max": 3}, "scope must be one of"),
    ({"filter": {}, "scope": "cioc"}, "needs `max`"),
    ({"filter": {}, "scope": "cioc", "max": -1}, "max must be a whole number"),
    ({"filter": {}, "scope": "cioc", "max": True}, "max must be a whole number"),
    ({"filter": {}, "scope": "cioc", "max": 2.5}, "max must be a whole number"),
])
def test_malformed_max_per_scope_is_rejected_with_a_clear_message(params, needle):
    with pytest.raises(RuleError, match=needle):
        compile_rule(Rule(id="c-x", type="max_per_scope", label="x", params=params))


def test_other_rule_types_validate_their_parameters():
    bad = [
        ("scope_relation", {"filter_a": {}}, "needs `filter_a` and `filter_b`"),
        ("scope_relation", {"filter_a": {}, "filter_b": {}, "relation": "near"}, "relation must be"),
        ("scope_relation", {"filter_a": {}, "filter_b": {}, "group_by": "colour"}, "group_by"),
        ("forbid_mix", {"io_type_a": ["AIR"], "io_type_b": ["AI"], "scope": "cioc"}, "overlap"),
        ("forbid_mix", {"io_type_a": ["AIR"], "io_type_b": ["DIR"], "scope": "cabinet"}, "scope must be one of baseplate, cioc"),
        ("forbid_mix", {"io_type_a": [], "io_type_b": ["DIR"]}, "io_type_a"),
        ("zone_cabinets", {"filter": {}, "cabinets": []}, "cabinets"),
        ("zone_cabinets", {"filter": {}, "cabinets": [True]}, "cabinet number or a name pattern"),
        ("extra_spares", {"io_type": "AIR"}, "greater than 0"),
        ("extra_spares", {"io_type": "AIR", "extra_pct": 150}, "percentage"),
        ("extra_spares", {"extra_pct": 5}, "io_type"),
    ]
    for t, p, needle in bad:
        with pytest.raises(RuleError, match=needle):
            compile_rule(Rule(id="c-x", type=t, label="x", params=p))
    with pytest.raises(RuleError, match="rule id"):
        compile_rule(Rule(id="has space", type="extra_spares", label="x", params={"io_type": "AIR", "extra_pct": 5}))
    with pytest.raises(RuleError, match="label"):
        compile_rule(Rule(id="c-x", type="extra_spares", label="  ", params={"io_type": "AIR", "extra_pct": 5}))
    with pytest.raises(RuleError, match="duplicate rule id"):
        validate_ruleset(RuleSet(id="x", name="x", rules=[Rule(id="a", type="capacity", label="a"), Rule(id="a", type="capacity", label="b")]))


# ───────────────────────────── engine obeys, verifier checks ─────────────────────────────

def test_max_per_baseplate_is_obeyed_and_checked():
    rows = [row(f"AI-{c}-{p}", "AI", f"C-{c}", p, 2) for c in range(1, 7) for p in (1, 2)]    # six 2-pair AIR cables
    plain, _ = go(rows)
    per_bp = Counter((s.cioc, s.bp) for s in plain.alloc.slots if s.status == "Field")
    assert max(per_bp.values()) > 3, "without the rule one baseplate takes several cables"
    rule = {"id": "c-max", "type": "max_per_scope", "label": "At most 3 AI per baseplate",
            "params": {"filter": {"io_type": "AIR"}, "scope": "baseplate", "max": 3}}
    out, rep = go(rows, rule)
    per_bp = Counter((s.cioc, s.bp) for s in out.alloc.slots if s.status == "Field")
    assert max(per_bp.values()) <= 3 and out.kpis.allocated == 12
    chk = check_for(rep, "c-max")
    assert rep.violations == 0 and chk.failed == 0 and chk.passed == 12 and chk.id == "C23"
    assert not [t for t in out.tqs if t.category == "Custom rule clash"]


def test_max_per_cioc_and_cabinet_scopes():
    rows = [row(f"DO-{c}-{p}", "DO", f"C-{c}", p, 6, inst="XA") for c in range(1, 5) for p in range(1, 7)]   # four 6-pair DOR cables
    out, rep = go(rows, {"id": "c-cioc", "type": "max_per_scope", "label": "Max 12 DO per CIOC",
                         "params": {"filter": {"io_type": "DOR"}, "scope": "cioc", "max": 12}})
    assert max(Counter(s.cioc for s in out.alloc.slots if s.status == "Field").values()) <= 12
    assert rep.violations == 0 and check_for(rep, "c-cioc").failed == 0
    out, rep = go(rows, {"id": "c-cab", "type": "max_per_scope", "label": "Max 12 DO per cabinet",
                         "params": {"filter": {"io_type": "DOR"}, "scope": "cabinet", "max": 12}})
    assert max(Counter(s.cabinet for s in out.alloc.slots if s.status == "Field").values()) <= 12
    assert len({s.cabinet for s in out.alloc.slots if s.status == "Field"}) >= 2
    assert rep.violations == 0 and check_for(rep, "c-cab").failed == 0


def test_forbid_mix_keeps_io_types_on_different_ciocs():
    rows = ([row(f"AI{n}-{p}", "AI", f"C-AI{n}", p, 12) for n in (1, 2) for p in range(1, 13)]
            + [row(f"DI{n}-{p}", "DI", f"C-DI{n}", p, 12) for n in (1, 2) for p in range(1, 13)])
    plain, _ = go(rows, strategy="compact")
    mixed = defaultdict(set)
    for s in plain.alloc.slots:
        if s.status == "Field":
            mixed[s.cioc].add(s.io_type)
    assert any(len(v) > 1 for v in mixed.values()), "without the rule a compact CIOC takes both"
    rule = {"id": "c-mix", "type": "forbid_mix", "label": "No AI with DI on a CIOC",
            "params": {"io_type_a": ["AIR"], "io_type_b": ["DIR"], "scope": "cioc"}}
    for strategy in ("compact", "balanced"):
        out, rep = go(rows, rule, strategy=strategy)
        io = defaultdict(set)
        for s in out.alloc.slots:
            if s.status == "Field":
                io[s.cioc].add(s.io_type)
        assert all(len(v) == 1 for v in io.values()), (strategy, dict(io))
        assert rep.violations == 0 and check_for(rep, "c-mix").failed == 0 and out.kpis.allocated == 48


def test_forbid_mix_on_a_baseplate():
    rows = [row(f"AI-{p}", "AI", "C-AI", p, 2) for p in (1, 2)] + [row(f"DI-{p}", "DI", "C-DI", p, 2) for p in (1, 2)]
    out, rep = go(rows, {"id": "c-mix", "type": "forbid_mix", "label": "No AI with DI on a baseplate",
                         "params": {"io_type_a": "AIR", "io_type_b": "DIR", "scope": "baseplate"}})
    io = defaultdict(set)
    for s in out.alloc.slots:
        if s.status == "Field":
            io[(s.cioc, s.bp)].add(s.io_type)
    assert all(len(v) == 1 for v in io.values()) and len(io) == 2 and rep.violations == 0


def test_zone_pins_a_tag_pattern_to_a_cabinet_and_opens_it():
    rows = [row(f"Z-{p}", "AI", "C-Z", p, 6) for p in range(1, 4)] + [row(f"N-{p}", "AI", "C-N", p, 6) for p in range(1, 4)]
    zone = {"id": "c-zone", "type": "zone_cabinets", "label": "Z tags only in cabinet 2",
            "params": {"filter": {"tag": "Z-*"}, "cabinets": [2]}}
    out, rep = go(rows, zone, strategy="compact")
    w = where(out)
    assert {w[f"Z-{p}"].cabinet_seq for p in range(1, 4)} == {2}
    assert {w[f"N-{p}"].cabinet_seq for p in range(1, 4)} == {1}, "everything else stays where the normal engine puts it"
    assert rep.violations == 0 and check_for(rep, "c-zone").failed == 0 and check_for(rep, "c-zone").passed == 3
    out, rep = go(rows, zone, strategy="balanced")
    assert {where(out)[f"Z-{p}"].cabinet_seq for p in range(1, 4)} == {2} and rep.violations == 0
    by_name = {**zone, "params": {"filter": {"tag": "Z-*"}, "cabinets": ["*-DCM-*-02"]}}
    out, rep = go(rows, by_name)
    assert {where(out)["Z-1"].cabinet_seq} == {2} and rep.violations == 0 and check_for(rep, "c-zone").failed == 0


def test_different_cabinet_relation_splits_cabinets():
    rows = [row(f"X-{p}", "DO", "C-X", p, 6, inst="XYV") for p in range(1, 4)] + [row(f"H-{p}", "DO", "C-H", p, 6, inst="XA") for p in range(1, 4)]
    out, rep = go(rows, {"id": "c-diff", "type": "scope_relation", "label": "Shutdown valves never with horns in a cabinet",
                         "params": {"filter_a": {"instrument_type": "XYV"}, "filter_b": {"instrument_type": "XA"},
                                    "scope": "cabinet", "relation": "different"}})
    w = where(out)
    assert {w["X-1"].cabinet_seq} != {w["H-1"].cabinet_seq}
    assert rep.violations == 0 and check_for(rep, "c-diff").failed == 0


def test_same_relation_pairs_signals_per_loop():
    rows = []
    for c, io, inst in (("C-1", "AI", "PT"), ("C-2", "DO", "XA"), ("C-3", "AI", "PT"), ("C-4", "DO", "XA")):
        for p in range(1, 3):
            r = row(f"{inst}-{c}-{p}", io, c, p, 2, inst=inst)
            r["Loop Name"] = f"LOOP-{c[-1] if c in ('C-1', 'C-2') else 9}"     # C-1/C-2 share a loop; C-3/C-4 share another
            rows.append(r)
    out, rep = go(rows, {"id": "c-same", "type": "scope_relation", "label": "Transmitter and its valve in one baseplate",
                         "params": {"filter_a": {"instrument_type": "PT"}, "filter_b": {"instrument_type": "XA"}, "scope": "baseplate",
                                    "relation": "same", "group_by": "loop_name"}}, headers=LOOP_HEADERS)
    bp_of = {s.tag: (s.cioc, s.bp) for s in out.alloc.slots if s.status == "Field"}
    assert bp_of["PT-C-1-1"] == bp_of["XA-C-2-1"], "loop 1: transmitter and valve on one baseplate"
    assert bp_of["PT-C-3-1"] == bp_of["XA-C-4-1"]
    assert rep.violations == 0 and check_for(rep, "c-same").failed == 0


def test_a_cable_that_breaks_the_rule_by_itself_is_a_tq_and_excepted_not_a_silent_pass():
    rows = [row(f"AI-{p}", "AI", "C-MIX", p, 6) for p in (1, 2)] + [row(f"DI-{p}", "DI", "C-MIX", p, 6) for p in (3, 4)]
    out, rep = go(rows, {"id": "c-mix", "type": "forbid_mix", "label": "No AI with DI on a CIOC",
                         "params": {"io_type_a": ["AIR"], "io_type_b": ["DIR"], "scope": "cioc"}})
    tq = next(t for t in out.tqs if t.category == "Custom rule clash")
    assert "c-mix" in tq.rules_in_conflict and "C-MIX" in tq.message and set(tq.tags) == {"AI-1", "AI-2", "DI-3", "DI-4"}
    assert out.kpis.allocated == 4, "the cable is still allocated"
    chk = check_for(rep, "c-mix")
    assert chk.failed == 0 and chk.excepted == 4 and rep.violations == 0 and rep.excepted >= 4
    # without the TQ the same layout FAILS: the verifier does not trust the engine
    rep2 = verify_rows(out.rows, out.signals, out.rules.rs, out.settings, [])
    assert check_for(rep2, "c-mix").failed > 0 and rep2.verdict == "FAIL"


def test_extra_spares_raise_the_wired_spare_target():
    rows = [row(f"AI-{p}", "AI", "C-1", p, 24) for p in range(1, 18)]                 # 17 AIR on a 24-pair cable → 7 free pairs
    plain, _ = go(rows)
    assert sum(s.status == "Wired Spare" for s in plain.alloc.slots) == 2           # 10% of 17
    out, rep = go(rows, {"id": "c-xs", "type": "extra_spares", "label": "15% extra AI spares", "params": {"io_type": "AIR", "extra_pct": 15}})
    assert sum(s.status == "Wired Spare" for s in out.alloc.slots) == 2 + 3         # + ceil(15% of 17)
    assert rep.violations == 0 and check_for(rep, "c-xs").failed == 0
    out, rep = go(rows, {"id": "c-xs", "type": "extra_spares", "label": "extra", "params": {"io_type": "AI", "extra_count": 9}})
    assert sum(s.status == "Wired Spare" for s in out.alloc.slots) == 7             # all free pairs, shortfall explained
    assert any(t.category == "Wired spare shortfall" for t in out.tqs)
    assert rep.violations == 0 and check_for(rep, "c-xs").excepted == 1


def test_soft_rules_are_advisory_and_disabled_rules_do_nothing():
    rows = [row(f"AI-{c}-{p}", "AI", f"C-{c}", p, 2) for c in range(1, 7) for p in (1, 2)]
    params = {"filter": {"io_type": "AIR"}, "scope": "baseplate", "max": 3}
    plain, _ = go(rows)
    out, rep = go(rows, {"id": "c-soft", "type": "max_per_scope", "label": "advisory", "severity": "soft", "params": params})
    assert [s.id for s in out.alloc.slots if s.status == "Field"] == [s.id for s in plain.alloc.slots if s.status == "Field"]
    chk = check_for(rep, "c-soft")
    assert chk.severity == "soft" and chk.failed > 0 and rep.violations == 0 and rep.warnings >= chk.failed and rep.verdict == "PASS"
    out, rep = go(rows, {"id": "c-off", "type": "max_per_scope", "label": "off", "enabled": False, "params": params})
    assert not [c for c in rep.checks if c.id >= "C23"]


def test_a_rule_that_cannot_be_met_is_a_tq_naming_the_clash():
    rows = [row(f"AI-{c}-{p}", "AI", f"C-{c}", p, 12) for c in range(1, 3) for p in range(1, 13)]
    out, rep = go(rows, {"id": "c-zero", "type": "max_per_scope", "label": "no AI at all in cabinet 1",
                         "params": {"filter": {"io_type": "AIR"}, "scope": "cabinet", "max": 0}})
    assert out.kpis.allocated == 24 and rep.violations == 0
    assert all(t.category == "Custom rule clash" for t in out.tqs if "c-zero" in t.rules_in_conflict) and any(
        "c-zero" in t.rules_in_conflict for t in out.tqs)


def test_a_malformed_stored_rule_never_breaks_a_run():
    rs = load_ruleset("default")
    rs.rules.append(Rule(id="c-bad", type="max_per_scope", label="bad", params={"filter": {"colour": "red"}, "scope": "cioc", "max": 2}))
    rows = [row(f"AI-{p}", "AI", "C-1", p, 6) for p in range(1, 7)]
    out = run(b"", rs, table=table(rows))
    assert out.kpis.allocated == 6
    assert any(t.category == "SYS-custom" and "c-bad" in t.message for t in out.tqs)
    rep = verify_rows(out.rows, out.signals, rs, out.settings, out.tqs)
    chk = check_for(rep, "c-bad")
    assert chk.failed == 1 and "malformed" in chk.violations[0].message and rep.verdict == "FAIL", "never a silent pass"
