"""Independent verifier checks for custom rules (dynamic check ids C23, C24, …, one per enabled custom rule).

Like every verifier check this knows nothing about the engine: it reads the OUTPUT ROWS and the normalised MDB, applies the
rule language (app.customrules — pure semantics) and reports. A signal covered by a 'Custom rule clash' TQ is reported as
excepted, never as a silent pass. A malformed rule is a failed check, never a crash and never skipped.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from typing import TYPE_CHECKING

from app.customrules import CRule, Item, RuleError, _io_norm, compile_rule, exempt_keys, filter_ctx, is_custom
from app.schemas import CheckResult, Violation

if TYPE_CHECKING:
    from verify.checks import Ctx

FIRST_ID = 23
MAX_LISTED = 250


def _trailing_int(name: str) -> int | None:
    m = re.search(r"(\d+)\s*$", name or "")
    return int(m.group(1)) if m else None


def custom_checks(ctx: "Ctx") -> list[CheckResult]:
    from verify.checks import mdb_index
    rules = [r for r in ctx.rs.rules if is_custom(r) and r.enabled]
    if not rules:
        return []
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    field_rows = [(r, by_key[r.key]) for r in ctx.rows if r.status == "Field" and r.key in by_key]
    row_of: dict[str, list] = defaultdict(list)
    for r, _ in field_rows:
        row_of[r.key].append(r)
    ctxs = {id(s): filter_ctx(s) for _, s in field_rows}
    out: list[CheckResult] = []
    for n, rule in enumerate(rules):
        cid = f"C{FIRST_ID + n}"
        res = CheckResult(id=cid, label=rule.label, rule_id=rule.id, severity=rule.severity)
        try:
            cr = compile_rule(rule)
            _run(cr, ctx, res, field_rows, ctxs, row_of)
        except RuleError as e:
            res.failed += 1
            res.violations.append(Violation(message=f"rule {rule.id} is malformed and cannot be checked: {e}"))
        except Exception as e:  # noqa: BLE001 — a check that cannot run is a FAIL, never skipped
            res.failed += 1
            res.violations.append(Violation(message=f"check could not run: {type(e).__name__}: {e}"))
        out.append(res)
    return out


def _run(cr: CRule, ctx: "Ctx", res: CheckResult, field_rows, ctxs, row_of) -> None:
    if cr.type == "extra_spares":
        _extra_spares(cr, ctx, res)
        return
    excused = exempt_keys(ctx.tqs, cr.id)
    items: list[Item] = []
    for r, s in field_rows:
        if s.tag_key in excused:
            continue
        a, b, g = cr.flags(ctxs[id(s)])
        if a or b:
            items.append(Item(key=r.key, tag=r.tag, a=a, b=b, gkey=g, domain=s.domain, cab=r.cab, cioc=(r.cab, r.cioc),
                              bp=(r.cab, r.cioc, r.baseplate), cab_name=r.cab, cab_no=_trailing_int(r.cab), cioc_name=r.cioc,
                              bp_name=r.baseplate))
    out = cr.evaluate(items)
    bad = {k for v in out.violations for k in v.keys}
    res.passed += max(0, len({i.key for i in items}) - len(bad))
    for v in out.violations:
        for k in v.keys:
            for row in row_of.get(k, [])[:1]:
                res.failed += 1
                if len(res.violations) < MAX_LISTED:
                    res.violations.append(row.v(v.message))
    n_ex = len({k for k in excused if k in row_of})
    if n_ex:
        res.excepted += n_ex
        for k in sorted(k for k in excused if k in row_of)[:MAX_LISTED]:
            res.exceptions.append(row_of[k][0].v(f"excepted by a 'Custom rule clash' TQ — rule {cr.id}"))


def _extra_spares(cr: CRule, ctx: "Ctx", res: CheckResult) -> None:
    """Wired spares per controller for the rule's IO type ≥ the global target + the extra."""
    base = ctx.rule("wired_spare_pct")
    pct = float(base.params.get("pct", 10)) if base else 0.0
    rounding = base.params.get("rounding", "ceil") if base else "ceil"
    by: dict[str, list] = defaultdict(list)
    for r in ctx.rows:
        by[r.controller].append(r)
    for ctrl, rows in by.items():
        field = Counter(r.io for r in rows if r.status == "Field")
        wired = Counter(r.io for r in rows if r.status == "Wired Spare")
        for io, nf in field.items():
            if _io_norm(io) != cr.io_type:
                continue
            g = math.ceil(nf * pct / 100 - 1e-9) if rounding == "ceil" else round(nf * pct / 100)
            target = g + cr.extra_target(nf)
            if wired[io] >= target:
                res.passed += 1
                continue
            cables = {r.cable for r in rows if r.status == "Field" and r.io == io and r.cable != "-"}
            free = [r for r in rows if r.status == "Spare Slot" and r.cable in cables and r.pair]
            v = Violation(message=f"{ctrl} {io}: {wired[io]} wired spare(s) < target {target} ({pct:g}% + {cr.extra_pct:g}%"
                                  f"{f' + {cr.extra_count}' if cr.extra_count else ''} of {nf}) — rule {cr.id}"
                                  + (f" while {len(free)} free pair(s) remain on {io} cables" if free else " — no free pair left (shortfall TQ)"))
            if free:
                res.failed += 1
                res.violations.append(v)
            else:
                res.excepted += 1
                res.exceptions.append(v)
