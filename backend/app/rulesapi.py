"""Rules Studio API: the catalogue of rule templates, rule listings, custom-rule CRUD and what-if previews.

Every change goes through one function (`_change`): build the candidate rule set → validate it (422 with a clear message if a
custom rule is malformed) → compute the full result on a detached copy (`Service.preview`) → refuse it if it would add a
hard violation or a system TQ → store it as a new rule-set version (decision log + undo step). A preview stops after the
compute: the stored rule set, the decision log and the TQ numbering are untouched.
"""
from __future__ import annotations

import copy
import re
from typing import Any, Callable

from app.customrules import (
    CUSTOM_TYPES, FILTER_FIELDS, MAX_DEPTH, MAX_NODES, MAX_PATTERNS, SCOPES, CRule, RuleError, compile_rule, is_custom, validate_ruleset,
)
from app.sandbox import _diff, _push, _walk
from app.schemas import (
    ParamSpec, Rule, RuleCatalogue, RuleChange, RuleEdit, RuleInput, RuleListing, RulePreviewRequest, RuleSet, RuleTypeInfo, RuleView,
)
from app.service import ProjectState, Service

ADDABLE_BUILTIN = {"segregate", "custom_expr"}      # built-in types that legitimately come in several (IS / NON-IS, A / B, hardware overrides)

FILTER_HELP = (
    "A filter is an object: AND of field conditions, plus optional \"not\" (a filter) and \"any\" (a list of filters, OR). "
    "Values are text globs — `*` matches any run of characters, `?` one character, case-insensitive — or a list of them. "
    "No regular expressions and no code: {\"tag\": \"440-PI-*\", \"io_type\": [\"DOR\", \"DIR\"], \"not\": {\"instrument_type\": \"XYV\"}}. "
    "An empty filter {} matches every signal. io_type accepts AI or AIR (the R form), AO/AOR, DI/DIR, DO/DOR."
)


def _spec(name, kind, required=True, default=None, choices=(), help=""):
    return ParamSpec(name=name, kind=kind, required=required, default=default, choices=list(choices), help=help)


def catalogue() -> RuleCatalogue:
    scope_help = "Where the limit/relation applies: one baseplate (12 channels), one CIOC (96 channels) or one marshalling cabinet."
    custom = [
        RuleTypeInfo(type="max_per_scope", label="Limit signals per baseplate / CIOC / cabinet", custom=True, scopes=list(SCOPES),
                     description="At most N signals matching a filter in any one baseplate, CIOC or cabinet.",
                     params=[_spec("filter", "filter", help="Which signals count."), _spec("scope", "scope", default="cioc", choices=SCOPES, help=scope_help),
                             _spec("max", "int", help="The most signals allowed per scope instance (0 = none).")],
                     example=Rule(id="c-max-ao-bp", type="max_per_scope", label="At most 4 analog outputs per baseplate",
                                  params={"filter": {"io_type": "AOR"}, "scope": "baseplate", "max": 4})),
        RuleTypeInfo(type="scope_relation", label="Same / different baseplate, CIOC or cabinet", custom=True, scopes=list(SCOPES),
                     description="Signals matching filter A and signals matching filter B must share a scope (\"same\") or must never share one "
                                 "(\"different\"). With group_by, the relation applies per value of a field (e.g. per loop).",
                     params=[_spec("filter_a", "filter"), _spec("filter_b", "filter"),
                             _spec("scope", "scope", default="cioc", choices=SCOPES, help=scope_help),
                             _spec("relation", "enum", default="different", choices=("same", "different")),
                             _spec("group_by", "field", required=False, choices=FILTER_FIELDS,
                                   help="Pair the signals up per value of this field (e.g. loop_name, unit).")],
                     example=Rule(id="c-xyv-xa", type="scope_relation", label="Shutdown valves never share a cabinet with horns",
                                  params={"filter_a": {"instrument_type": "XYV"}, "filter_b": {"instrument_type": "XA"},
                                          "scope": "cabinet", "relation": "different"})),
        RuleTypeInfo(type="forbid_mix", label="Forbid mixing two IO types", custom=True, scopes=["baseplate", "cioc"],
                     description="IO type A and IO type B never meet on one baseplate or CIOC.",
                     params=[_spec("io_type_a", "io_types", help="e.g. [\"AIR\"]"), _spec("io_type_b", "io_types", help="e.g. [\"DIR\"]"),
                             _spec("scope", "scope", default="cioc", choices=("baseplate", "cioc"))],
                     example=Rule(id="c-no-ai-di", type="forbid_mix", label="No AI with DI on a CIOC",
                                  params={"io_type_a": ["AIR"], "io_type_b": ["DIR"], "scope": "cioc"})),
        RuleTypeInfo(type="zone_cabinets", label="Zone / tag pattern → allowed cabinets", custom=True, scopes=["cabinet"],
                     description="Signals matching a filter (a tag pattern, an area, a room …) may only be placed in the listed cabinets.",
                     params=[_spec("filter", "filter"),
                             _spec("cabinets", "cabinets", help="Cabinet numbers (the last number in the name: 1, 4) or name patterns (\"P30-DCM-*-04\").")],
                     example=Rule(id="c-zone-ra320", type="zone_cabinets", label="RA 320-01 signals only in cabinet 04",
                                  params={"filter": {"area": "RA 320-01"}, "cabinets": [4]})),
        RuleTypeInfo(type="extra_spares", label="Reserve extra wired spares per IO type", custom=True, scopes=["cabinet"],
                     description="On top of the global wired-spare percentage, keep this many extra wired spares for one IO type per controller.",
                     params=[_spec("io_type", "string", help="e.g. AIR"), _spec("extra_pct", "float", required=False, default=0, help="Extra percent of that IO type's field signals."),
                             _spec("extra_count", "int", required=False, default=0, help="Extra fixed number per controller.")],
                     example=Rule(id="c-xs-air", type="extra_spares", label="5% extra AI spares", params={"io_type": "AIR", "extra_pct": 5})),
    ]
    builtin = [
        ("capacity", "Capacity", "One signal per slot, one slot per cable pair, cabinets within the configured limits. Limits live in Project Settings."),
        ("cable_contiguous", "Cable pairs contiguous", "Params: whole_baseplate_min_pairs — cables at least this big start a baseplate."),
        ("group_together", "Keep IO groupings together", "Params: level (cabinet | cioc), ignore (group values to skip)."),
        ("segregate", "Segregate families", "Params: field, level (baseplate | cioc | cabinet), families {family: [values]}, default_family."),
        ("reserve_baseplate", "Reserve a baseplate for cabinet alarms", "Params: cioc, baseplate, match_any [{field: value}], remarks."),
        ("wired_spare_pct", "Wired spare percentage", "Params: pct, rounding (ceil | round)."),
        ("future_spare_pct", "Future-spare baseplates", "Params: pct, rounding."),
        ("hardware_map", "Hardware map", "Params: rows [{when, charm, tb}], lists, terminals, loop_typicals, spare_slot."),
        ("io_type_map", "IO type map", "Params: map {raw type: AIR | AOR | DIR | DOR}."),
        ("naming_pattern", "Naming patterns", "Params: patterns {cabinet, controller, cioc, baseplate, …}, derive, sides."),
        ("output_map", "Engineering columns", "Params: columns {output column: MDB field}, blank_for."),
        ("custom_expr", "Hardware override expression", "Params: expr — `io_type==\"DOR\" and instrument_type in [\"UZV\"] -> charm=\"SE4302T02\", tb=\"SE4502\"`."),
    ]
    types = custom + [RuleTypeInfo(type=t, label=l, description=d, custom=False) for t, l, d in builtin]
    return RuleCatalogue(types=types, filter_fields=list(FILTER_FIELDS), filter_syntax=FILTER_HELP, scopes=list(SCOPES), notes=[
        "Hard rules are ENFORCED: the allocator keeps them and the independent verifier fails the run if they are broken. "
        "Soft rules are ADVISORY: the verifier reports a warning, nothing is blocked.",
        "A cable whose own signals already break a rule cannot satisfy it anywhere; that is raised as a TQ and the cable is reported as excepted.",
        f"Filters nest up to {MAX_DEPTH} levels, {MAX_NODES} conditions and {MAX_PATTERNS} patterns per field.",
        "Baseplate-scope \"same\" relations are best effort: if the layout cannot honour them a TQ names the clash.",
    ])


# ───────────────────────────── listing ─────────────────────────────

def _view(rule: Rule, report) -> RuleView:
    checks = [c for c in (report.checks if report else []) if c.rule_id == rule.id]
    mode = "off" if not rule.enabled else "enforced" if rule.severity == "hard" else "advisory"
    summary = ""
    if is_custom(rule):
        try:
            summary = compile_rule(rule).describe()
        except RuleError as e:
            summary = f"MALFORMED: {e}"
    return RuleView(id=rule.id, type=rule.type, label=rule.label, enabled=rule.enabled, severity=rule.severity, params=rule.params,
                    custom=is_custom(rule), mode=mode, summary=summary, check_ids=[c.id for c in checks],  # type: ignore[arg-type]
                    passed=sum(c.passed for c in checks), failed=sum(c.failed for c in checks), excepted=sum(c.excepted for c in checks))


def listing(svc: Service, pid: str) -> RuleListing:
    st = svc.get(pid)
    rep = st.current.report if st.current else None
    return RuleListing(project_id=pid, version=st.ruleset.version, settings=st.ruleset.settings,
                       rules=[_view(r, rep) for r in st.ruleset.rules])


# ───────────────────────────── changes ─────────────────────────────

def _new_id(rs: RuleSet, rtype: str) -> str:
    base = "c-" + rtype.replace("_", "-")
    n = 1
    taken = {r.id for r in rs.rules}
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def _sys_tqs(comp) -> set[str]:
    return {t.id for t in comp.tqs if t.category.startswith("SYS-")}


def _change(svc: Service, pid: str, action: str, rule_id: str | None, build: Callable[[RuleSet], tuple[RuleSet, str, str]], *,
            store: bool, who: str, reason: str) -> RuleChange:
    st = svc.get(pid)
    with st.lock:
        comp0 = st.current
        assert comp0 is not None
        rs0 = st.ruleset
        rs1, rid, label = build(rs0.model_copy(deep=True))
        rs1 = RuleSet.model_validate(rs1.model_dump())            # pydantic: ids, types, severities
        validate_ruleset(rs1)                                      # custom rules: params and filters (RuleError → 422)
        comp1 = svc.preview(st, rs1)
        worse = comp1.report.violations - comp0.report.violations
        new_sys = _sys_tqs(comp1) - _sys_tqs(comp0)
        old_ids = {t.id for t in comp0.tqs}
        new_ids = {t.id for t in comp1.tqs}
        diff = _diff(comp0.out, comp1.out)
        msgs: list[str] = []
        allowed = worse <= 0 and not new_sys
        if worse > 0:
            msgs.append(f"Refused: this change would leave {worse} more hard-rule violation(s) than now "
                        f"({', '.join(c.id for c in comp1.report.checks if c.failed)}).")
        if new_sys:
            msgs.append("Refused: the change makes the pipeline raise a system TQ ("
                        + "; ".join(t.message[:90] for t in comp1.tqs if t.id in new_sys) + ").")
        moved = sum(1 for d in diff if d.change == "moved")
        if allowed:
            msgs.append(f"{comp1.report.checks_passed}/{comp1.report.checks_total} checks pass, {comp1.report.violations} violation(s), "
                        f"{moved} signal(s) move, {len(new_ids - old_ids)} new TQ(s).")
        stored_ok = store and allowed
        version = rs0.version
        if stored_ok:
            why = f"{action.capitalize()} rule {rid}: {label}" + (f" — {reason}" if reason else "")
            _push(svc, pid, {"kind": "rules", "before": rs0.model_dump(), "after": rs1.model_dump(), "label": why[:120]})
            svc.put_rules(pid, rs1, why, patch={"rule_id": rid, "op": action, "rule": next((r.model_dump() for r in rs1.rules if r.id == rid), None)},
                          who=who)
            version = st.ruleset.version
            comp1 = st.current or comp1
        rule = next((r for r in rs1.rules if r.id == rid), None)
        return RuleChange(action=action, rule_id=rid, stored=stored_ok, allowed=allowed, ruleset_version=version,  # type: ignore[arg-type]
                          rule=_view(rule, comp1.report) if rule else None, messages=msgs, kpis_before=comp0.kpis, kpis_after=comp1.kpis,
                          report=comp1.report, diff=diff, moves=moved, new_tqs=sorted(new_ids - old_ids),
                          resolved_tqs=sorted(old_ids - new_ids))


def _build_add(inp: RuleInput):
    def build(rs: RuleSet):
        rid = inp.id or _new_id(rs, inp.type)
        if any(r.id == rid for r in rs.rules):
            raise ValueError(f"a rule with id '{rid}' already exists — pick another id or edit it with PUT /rules/{rid}")
        rule = Rule(id=rid, type=inp.type, enabled=inp.enabled, severity=inp.severity, label=inp.label.strip(), params=copy.deepcopy(inp.params))
        if is_custom(rule):
            try:
                compile_rule(rule)
            except RuleError as e:
                raise RuleError(f"rule '{rid}': {e}") from e
        elif inp.type not in ADDABLE_BUILTIN:
            raise ValueError(f"'{inp.type}' is a built-in rule type — edit the existing rule with PUT /rules/{{id}}; new rules can be "
                             f"custom types ({', '.join(CUSTOM_TYPES)}) or a further {' / '.join(sorted(ADDABLE_BUILTIN))} rule")
        rs.rules.append(rule)
        return rs, rid, rule.label
    return build


def _build_edit(rule_id: str, e: RuleEdit):
    def build(rs: RuleSet):
        rule = next((r for r in rs.rules if r.id == rule_id), None)
        if rule is None:
            raise KeyError(f"rule {rule_id}")
        if e.label is not None:
            if not e.label.strip():
                raise ValueError("label cannot be empty")
            rule.label = e.label.strip()
        if e.enabled is not None:
            rule.enabled = e.enabled
        if e.severity is not None:
            rule.severity = e.severity
        if e.params is not None:
            if e.replace_params:
                rule.params = copy.deepcopy(e.params)
            else:
                for k, v in e.params.items():
                    d, last = _walk(rule.params, k)
                    d[last] = copy.deepcopy(v)
        for k in e.unset_params:
            d, last = _walk(rule.params, k)
            d.pop(last, None)
        return rs, rule.id, rule.label
    return build


def _build_delete(rule_id: str, force: bool):
    def build(rs: RuleSet):
        rule = next((r for r in rs.rules if r.id == rule_id), None)
        if rule is None:
            raise KeyError(f"rule {rule_id}")
        if not is_custom(rule) and not force:
            raise ValueError(f"'{rule_id}' is a built-in rule — switch it off (PUT /rules/{rule_id} with enabled=false), "
                             f"or pass force=true to delete it")
        rs.rules = [r for r in rs.rules if r.id != rule_id]
        return rs, rule.id, rule.label
    return build


def add_rule(svc: Service, pid: str, inp: RuleInput) -> RuleChange:
    return _change(svc, pid, "add", inp.id, _build_add(inp), store=True, who=inp.who, reason=inp.reason)


def edit_rule(svc: Service, pid: str, rule_id: str, e: RuleEdit) -> RuleChange:
    return _change(svc, pid, "update", rule_id, _build_edit(rule_id, e), store=True, who=e.who, reason=e.reason)


def delete_rule(svc: Service, pid: str, rule_id: str, force: bool = False, who: str = "engineer") -> RuleChange:
    return _change(svc, pid, "delete", rule_id, _build_delete(rule_id, force), store=True, who=who, reason="")


def preview(svc: Service, pid: str, req: RulePreviewRequest) -> RuleChange:
    if req.action == "add":
        if req.rule is None:
            raise ValueError("preview of an add needs `rule`")
        return _change(svc, pid, "add", req.rule.id, _build_add(req.rule), store=False, who=req.rule.who, reason="")
    if not req.rule_id:
        raise ValueError(f"preview of an {req.action} needs `rule_id`")
    if req.action == "update":
        if req.edit is None:
            raise ValueError("preview of an update needs `edit`")
        return _change(svc, pid, "update", req.rule_id, _build_edit(req.rule_id, req.edit), store=False, who="engineer", reason="")
    return _change(svc, pid, "delete", req.rule_id, _build_delete(req.rule_id, req.force), store=False, who="engineer", reason="")
