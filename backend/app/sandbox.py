"""What-if Sandbox, commit / undo / redo, and TQ Apply / Close.

Moves are validated against the hard rules BEFORE anything runs, so a blocked move comes back with the exact
rule and reason. Previews never commit. Commits are stored as inputs (moves, rule-set versions) and replayed on
every recompute, so a restart reproduces the same allocation and hashes.
"""
from __future__ import annotations

from typing import Any

from app.schemas import (
    AllocationResult, Move, ProjectSettings, RuleSet, SlotDiff, TQ, WhatIfRequest, WhatIfResult,
)
from app.service import ProjectState, Service, now, tq_signature
from engine.allocate import Block
from engine.pipeline import RunOutput, run
from engine.revise import revise
from verify.checks import verify_rows


# ───────────────────────────── rule patches ─────────────────────────────

def _walk(params: dict, path: str) -> tuple[dict, str]:
    keys = [k for k in path.split(".") if k]
    d = params
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    return d, keys[-1]


def patch_ruleset(rs: RuleSet, patch: dict[str, Any]) -> RuleSet:
    rs2 = rs.model_copy(deep=True)
    rule = next((r for r in rs2.rules if r.id == patch.get("rule_id")), None)
    if rule is None:
        raise ValueError(f"rule {patch.get('rule_id')} not in the rule set")
    op, path, value = patch.get("op"), patch.get("path", ""), patch.get("value")
    if op == "toggle":
        rule.enabled = bool(value)
    elif op == "set":
        d, k = _walk(rule.params, path)
        d[k] = value
    elif op in ("list_add", "list_remove"):
        d, k = _walk(rule.params, path)
        cur = list(d.get(k, []))
        vals = value if isinstance(value, list) else [value]
        for v in vals:
            if op == "list_add" and v not in cur:
                cur.append(v)
            if op == "list_remove" and v in cur:
                cur.remove(v)
        d[k] = cur
    elif op == "map_set":
        d, k = _walk(rule.params, path or "map")
        d.setdefault(k, {})[patch["key"]] = value
    else:
        raise ValueError(f"unknown patch op {op}")
    return RuleSet.model_validate(rs2.model_dump())


def apply_overrides(rs: RuleSet, toggles: dict[str, bool], params: dict[str, dict]) -> RuleSet:
    rs2 = rs.model_copy(deep=True)
    for r in rs2.rules:
        if r.id in toggles:
            r.enabled = toggles[r.id]
        if r.id in params:
            r.params.update(params[r.id])
    return RuleSet.model_validate(rs2.model_dump())


RULESET_SETTINGS = ("cioc_strategy", "wired_spare_pct", "future_spare_pct")   # the ones /commit can persist (as a rule-set version)


def apply_settings(rs: RuleSet, ps: ProjectSettings, changes: dict[str, Any]) -> tuple[RuleSet, ProjectSettings]:
    """What-if `settings` → a modified COPY of the rule set and project settings. Nothing is stored."""
    if not changes:
        return rs, ps
    rs2 = rs.model_copy(deep=True)
    ps_updates: dict[str, Any] = {}
    for k, v in changes.items():
        if k == "cioc_strategy":
            if v not in ("balanced", "compact"):
                raise ValueError("cioc_strategy must be 'balanced' or 'compact'")
            rs2.settings.cioc_strategy = v
        elif k in ("wired_spare_pct", "future_spare_pct"):
            rule = next((r for r in rs2.rules if r.type == k), None)
            if rule is None:
                raise ValueError(f"the rule set has no {k} rule — add it in Rules Studio first")
            if not rule.enabled:
                raise ValueError(f"rule {rule.id} ({rule.label}) is switched off — toggle it on to try a different percentage")
            try:
                pct = float(v)
            except (TypeError, ValueError):
                raise ValueError(f"{k} must be a number (percent)") from None
            if not 0 <= pct <= 100:
                raise ValueError(f"{k} must be between 0 and 100")
            rule.params["pct"] = pct
        elif k in ProjectSettings.model_fields:
            ps_updates[k] = v
        else:
            allowed = ", ".join([*RULESET_SETTINGS, *ProjectSettings.model_fields])
            raise ValueError(f"unknown setting '{k}' (allowed: {allowed})")
    ps2 = ProjectSettings.model_validate({**ps.model_dump(), **ps_updates}) if ps_updates else ps
    return RuleSet.model_validate(rs2.model_dump()), ps2


# ───────────────────────────── move validation ─────────────────────────────

def resolve_move(out: RunOutput, rs: RuleSet, mv: Move) -> tuple[str, tuple] | str:
    """→ (cable, (ns, seq, local, bp, ch)) or a human reason why the move is blocked."""
    alloc = out.alloc
    rules = out.rules
    blocks = {b.id: b for b in alloc.blocks if b.cab is not None}
    by_id = {s.id: s for s in alloc.slots}
    b: Block | None = None
    if mv.block_id:
        b = blocks.get(mv.block_id)
        if b is None:
            return f"cable block {mv.block_id} is not placed"
    elif mv.slot_id:
        s = by_id.get(mv.slot_id)
        if s is None:
            return f"slot {mv.slot_id} not found"
        if s.status == "Cabinet Alarm":
            return f"{s.tag} is a cabinet alarm — it stays on the reserved baseplate (rule {rules.rid('reserve_baseplate')})"
        if not s.block_id:
            return "this slot holds no cable — pick a signal or a cable block"
        b = blocks.get(s.block_id)
        if b and b.size > 1:
            return (f"{s.tag or 'this slot'} is pair {s.pair} of {b.size}-pair cable {b.cable} — cables move as a whole block "
                    f"(rule {rules.rid('cable_contiguous') or 'r-cable'}). Move the whole cable instead.")
    if b is None:
        return "nothing to move"
    tgt = next((s for s in alloc.slots if s.cioc == mv.target_cioc), None)
    if tgt is None:
        return f"CIOC {mv.target_cioc} not found"
    cab = next((c for c in alloc.cabs if c.seq == tgt.cabinet_seq and c.domain == tgt.domain), None)
    if cab is None:
        return "target cabinet not found"
    if cab.domain != b.domain:
        return f"{b.cable} belongs to controller domain {b.domain}; {mv.target_cioc} is in {cab.domain}"
    local = tgt.cioc_local
    seg_rules = rules.all("segregate")
    seg = rules.primary_seg
    if seg is not None and b.family != "-" and seg.params.get("level", "cioc") == "cioc":
        others = {o.family for o in cab.blocks.get(local, []) if o is not b and o.family != "-"}
        lock = cab.alarm_lock.get(local)
        others |= {lock} if lock else set()
        clash = others - {b.family}
        if clash:
            return (f"{b.family}-family cable {b.cable} cannot join CIOC {mv.target_cioc} which holds "
                    f"{'/'.join(sorted(clash))}-family signals — rule {seg.id}: {seg.label}")
    for rule in seg_rules:
        f = b.fams.get(rule.id)
        if not f:
            continue
        level = rule.params.get("level", "cioc")
        if level == "baseplate":
            continue  # checked below, once the target baseplate(s) are known
        cabinet = level == "cabinet"
        scope = [o for l, bl in cab.blocks.items() for o in bl] if cabinet else cab.blocks.get(local, [])
        clash = {o.fams.get(rule.id) for o in scope if o is not b} - {None, f}
        if clash:
            return (f"{f} cable {b.cable} cannot join the {'cabinet' if cabinet else 'CIOC'} of {mv.target_cioc}, which holds "
                    f"{'/'.join(sorted(clash))} signals — rule {rule.id}: {rule.label}")
    n_bp, n_ch = out.settings.baseplates_per_cioc, out.settings.channels_per_baseplate
    bp, ch = mv.target_bp, (1 if b.span else mv.target_ch)
    if not (1 <= bp <= n_bp) or (b.span and bp + b.span - 1 > n_bp):
        return f"{b.size}-pair cable needs {b.span} whole baseplate(s) from BP {bp} — beyond baseplate {n_bp}"
    if not b.span and ch + b.foot - 1 > n_ch:
        return f"{b.size}-pair cable at channel {ch} would cross the baseplate boundary (rule {rules.rid('cable_contiguous')})"
    for x in range(bp, bp + max(1, b.span)):
        if (local, x) in cab.reserved:
            kind = cab.reserved[(local, x)]
            rid = rules.rid("future_spare_pct") if kind == "future" else rules.rid("reserve_baseplate")
            label = next((r.label for r in rs.rules if r.id == rid), "")
            return f"baseplate {x} is reserved ({kind.replace('_', ' ')}) — rule {rid}: {label}"
    span_ch = (range(1, n_ch + 1) if b.span else range(ch, ch + b.foot))
    want = {(x, c) for x in range(bp, bp + max(1, b.span)) for c in span_ch}
    for o in cab.blocks.get(local, []):
        if o is b or o.bp is None or o.ch is None:
            continue
        occ = {(o.bp + k, c) for k in range(max(1, o.span)) for c in (range(1, n_ch + 1) if o.span else range(o.ch, o.ch + o.foot))}
        if want & occ:
            return f"target channels are occupied by cable {o.cable}"
        for rule in seg_rules:
            f, g_ = b.fams.get(rule.id), o.fams.get(rule.id)
            if rule.params.get("level") == "baseplate" and f and g_ and f != g_ and {x for x, _ in want} & {x for x, _ in occ}:
                return (f"{f} cable {b.cable} cannot share a baseplate with {g_} cable {o.cable} — rule {rule.id}: {rule.label}")
    alarm_local = int(rules.params("reserve_baseplate").get("cioc", 1)) if rules.first("reserve_baseplate") else None
    if local == alarm_local and any(pos in want for pos in cab.alarm_pos.values()):
        return "target channels hold cabinet alarms"
    return b.cable, (cab.ns, cab.seq, local, bp, ch)


def _diff(prev: RunOutput, new: RunOutput) -> list[SlotDiff]:
    a = {s.tag_key: s for s in prev.alloc.slots if s.status in ("Field", "Cabinet Alarm")}
    b = {s.tag_key: s for s in new.alloc.slots if s.status in ("Field", "Cabinet Alarm")}
    out: list[SlotDiff] = []
    for k, s in b.items():
        if k not in a:
            out.append(SlotDiff(tag=s.tag, to_slot=s.id, change="added", reason=s.remarks if s.remarks != "-" else "new"))
        elif a[k].id != s.id:
            out.append(SlotDiff(tag=s.tag, from_slot=a[k].id, to_slot=s.id, change="moved",
                                reason=s.remarks if s.remarks != "-" else "moved"))
        elif (a[k].charm, a[k].tb) != (s.charm, s.tb):
            out.append(SlotDiff(tag=s.tag, from_slot=s.id, to_slot=s.id, change="hardware",
                                reason=f"{a[k].charm}/{a[k].tb} → {s.charm}/{s.tb}"))
    for k, s in a.items():
        if k not in b:
            out.append(SlotDiff(tag=s.tag, from_slot=s.id, change="removed", reason="no longer allocated"))
    # Spare Slot ↔ Wired Spare (a spare % change, a strategy change, a freed pair …): same slot, new Tag Status
    sa = {s.id: s for s in prev.alloc.slots if s.status in ("Spare Slot", "Wired Spare")}
    for s in new.alloc.slots:
        old = sa.get(s.id)
        if old is None or s.status not in ("Spare Slot", "Wired Spare"):
            continue
        if old.status != s.status:
            out.append(SlotDiff(tag=s.tag if s.status == "Wired Spare" else old.tag, from_slot=s.id, to_slot=s.id, change="status",
                                reason=f"{old.status} → {s.status}" + (f" ({s.io_type} on {s.cable})" if s.status == "Wired Spare" else "")))
        elif s.status == "Wired Spare" and (old.charm, old.tb) != (s.charm, s.tb):
            out.append(SlotDiff(tag=s.tag, from_slot=s.id, to_slot=s.id, change="hardware",
                                reason=f"{old.charm}/{old.tb} → {s.charm}/{s.tb}"))
    return out


# ───────────────────────────── the sandbox ─────────────────────────────

def _active_mdb(st: ProjectState) -> bytes:
    return st.extra.get("mdb_b") if st.project.revision == "B" and st.extra.get("mdb_b") else st.mdb  # type: ignore[return-value]


def _rev_no(st: ProjectState) -> str:
    return "01" if st.project.revision == "B" else st.settings.revision


def apply_sandbox(svc: Service, st: ProjectState, out: RunOutput, rs: RuleSet | None = None,
                  settings: ProjectSettings | None = None) -> RunOutput:
    """Replay committed sandbox moves on top of a freshly computed allocation (called by every recompute).
    rs / settings: what-if copies to replay under instead of the stored ones."""
    moves = svc.store.get(st.project.id, "sandbox_moves", {}) or {}
    if not moves:
        return out
    ok = {}
    for cable, pos in moves.items():
        ns, seq, local, bp, ch = pos
        ok[cable] = (tuple(ns), seq, local, bp, ch)
    rev = st.project.revision
    out2, _ = revise(_active_mdb(st), out, rs or st.ruleset, settings or st.settings, from_rev=rev, to_rev=rev,
                     rev_no=_rev_no(st), moves=ok)
    out2.optimiser = out.optimiser
    return out2


def whatif(svc: Service, pid: str, req: WhatIfRequest) -> WhatIfResult:
    st = svc.get(pid)
    comp = st.current
    assert comp is not None
    rs = apply_overrides(st.ruleset, req.rule_toggles, req.params)
    rs, ps = apply_settings(rs, st.settings, req.settings)   # copies: the stored rule set, settings and decision log stay untouched
    moves: dict[str, tuple] = {}
    for mv in req.moves:
        res = resolve_move(comp.out, rs, mv)
        if isinstance(res, str):
            return WhatIfResult(allowed=False, blocked_reason=res, kpis=comp.kpis, report=comp.report, moves=0, diff=[])
        moves[res[0]] = res[1]
    rev = st.project.revision
    if moves:
        out, _ = revise(_active_mdb(st), comp.out, rs, ps, from_rev=rev, to_rev=rev, rev_no=_rev_no(st), moves=moves)
        for cable, (_, seq, local, bp, ch) in moves.items():
            b = next((x for x in out.alloc.blocks if x.cable == cable), None)
            if b is None or not b.pinned:
                return WhatIfResult(allowed=False, blocked_reason=f"{cable} could not be placed there: "
                                    f"{(b.move_reason if b else None) or 'a hard rule rejected the position'}",
                                    kpis=comp.kpis, report=comp.report, moves=0, diff=[])
    elif rev == "B":
        from app.revisions import _rev_a
        out, _ = revise(st.extra["mdb_b"], _rev_a(svc, st), rs, ps)
    else:
        out = run(st.mdb, rs, ps, st.overrides or None, filename=st.mdb_name)
        out = apply_sandbox(svc, st, out, rs, ps)   # committed moves stay in the preview, so the diff shows only this change
    rep = verify_rows(out.rows, out.signals, rs, ps, out.tqs)
    diff = _diff(comp.out, out)
    changed = {d.to_slot for d in diff if d.to_slot} | {d.from_slot for d in diff if d.from_slot}
    kpis = out.kpis.model_copy(update={"violations": rep.violations})
    return WhatIfResult(allowed=rep.verdict == "PASS", blocked_reason=None if rep.verdict == "PASS" else
                        f"{rep.violations} hard-rule violation(s) — see the report", kpis=kpis, report=rep,
                        moves=sum(1 for d in diff if d.change == "moved"), diff=diff,
                        slots=[s for s in out.alloc.slots if s.id in changed], applied_settings=dict(req.settings))


def _push(svc: Service, pid: str, entry: dict) -> None:
    stack = svc.store.get(pid, "undo", []) or []
    stack.append(entry)
    svc.store.put(pid, "undo", stack[-50:])
    svc.store.put(pid, "redo", [])


def commit(svc: Service, pid: str, req: WhatIfRequest) -> AllocationResult:
    preview_only = [k for k in req.settings if k not in RULESET_SETTINGS]
    if preview_only:
        raise ValueError(f"{', '.join(preview_only)} can be previewed but not committed here — change project settings with "
                         f"PUT /settings (commit accepts {', '.join(RULESET_SETTINGS)})")
    preview = whatif(svc, pid, req)
    if not preview.allowed:
        raise ValueError(preview.blocked_reason or "change rejected")
    st = svc.get(pid)
    with st.lock:
        if req.rule_toggles or req.params or req.settings:
            before = st.ruleset.model_dump()
            rs = apply_overrides(st.ruleset, req.rule_toggles, req.params)
            rs, _ = apply_settings(rs, st.settings, req.settings)
            what = ", ".join([f"{k} {'on' if v else 'off'}" for k, v in req.rule_toggles.items()] +
                             [f"{k} {v}" for k, v in req.params.items()] + [f"{k} {v}" for k, v in req.settings.items()])
            _push(svc, pid, {"kind": "rules", "before": before, "after": rs.model_dump(), "label": what})
            svc.put_rules(pid, rs, f"What-if committed: {what}")
        if req.moves:
            moves_before = svc.store.get(pid, "sandbox_moves", {}) or {}
            moves_after = dict(moves_before)
            for mv in req.moves:
                res = resolve_move(st.current.out, st.ruleset, mv)  # type: ignore[union-attr]
                if isinstance(res, str):
                    raise ValueError(res)
                cable, (ns, seq, local, bp, ch) = res
                moves_after[cable] = [list(ns), seq, local, bp, ch]
            _push(svc, pid, {"kind": "moves", "before": moves_before, "after": moves_after,
                             "label": f"{len(req.moves)} move(s)"})
            svc.store.put(pid, "sandbox_moves", moves_after)
            svc.recompute_active(st)
            svc.activity(pid, "whatif", f"Sandbox: committed {len(req.moves)} move(s) — {preview.moves} signal(s) moved, "
                                        f"{st.current.report.violations} violations")  # type: ignore[union-attr]
        return svc.result(st)


def _restore(svc: Service, pid: str, entry: dict, which: str) -> None:
    st = svc.get(pid)
    if entry["kind"] == "moves":
        svc.store.put(pid, "sandbox_moves", entry[which])
        svc.recompute_active(st)
    else:
        svc.put_rules(pid, RuleSet.model_validate(entry[which]), f"{'Undo' if which == 'before' else 'Redo'}: {entry['label']}")


def undo(svc: Service, pid: str) -> AllocationResult:
    st = svc.get(pid)
    with st.lock:
        stack = svc.store.get(pid, "undo", []) or []
        if not stack:
            raise ValueError("nothing to undo")
        entry = stack.pop()
        svc.store.put(pid, "undo", stack)
        redo_ = svc.store.get(pid, "redo", []) or []
        svc.store.put(pid, "redo", redo_ + [entry])
        _restore(svc, pid, entry, "before")
        svc.activity(pid, "whatif", f"Undo: {entry['label']}")
        return svc.result(st)


def redo(svc: Service, pid: str) -> AllocationResult:
    st = svc.get(pid)
    with st.lock:
        redo_ = svc.store.get(pid, "redo", []) or []
        if not redo_:
            raise ValueError("nothing to redo")
        entry = redo_.pop()
        svc.store.put(pid, "redo", redo_)
        stack = svc.store.get(pid, "undo", []) or []
        svc.store.put(pid, "undo", stack + [entry])
        _restore(svc, pid, entry, "after")
        svc.activity(pid, "whatif", f"Redo: {entry['label']}")
        return svc.result(st)


# ───────────────────────────── TQ apply / close ─────────────────────────────

def _find_tq(svc: Service, pid: str, tq_id: str) -> tuple[ProjectState, TQ]:
    st = svc.get(pid)
    tq = next((t for t in (st.current.tqs if st.current else []) if t.id == tq_id), None)
    if tq is None:
        raise KeyError(tq_id)
    return st, tq


def _decide(svc: Service, pid: str, tq: TQ, status: str, decision: str) -> None:
    d = svc.store.get(pid, "tq_decisions", {}) or {}
    snap = tq.model_copy(update={"status": status, "decision": decision})
    d[tq_signature(tq)] = {"status": status, "decision": decision, "ts": now(), "tq": snap.model_dump()}
    svc.store.put(pid, "tq_decisions", d)


def apply_tq(svc: Service, pid: str, tq_id: str, option: int = 0) -> AllocationResult:
    st, tq = _find_tq(svc, pid, tq_id)
    if not tq.fix_options:
        return close_tq(svc, pid, tq_id, "Acknowledged")
    if not 0 <= option < len(tq.fix_options):
        raise ValueError(f"{tq_id} has {len(tq.fix_options)} fix option(s)")
    fix = tq.fix_options[option]
    with st.lock:
        if fix.rule_patch:
            rs = patch_ruleset(st.ruleset, fix.rule_patch)
            _decide(svc, pid, tq, "applied", fix.label)
            before = st.current.out if st.current else None
            svc.put_rules(pid, rs, f"{tq.id}: {fix.label}", tq_id=tq.id, patch=fix.rule_patch)
            diff = _diff(before, st.current.out) if before and st.current else []
            moved = sum(1 for d in diff if d.change == "moved")
            hw = sum(1 for d in diff if d.change == "hardware")
            svc.activity(pid, "tq", f"Applied {tq.id} ({fix.label}) → {hw} hardware change(s), {moved} move(s), "
                                    f"{st.current.report.violations} violations")  # type: ignore[union-attr]
            res = svc.result(st)
            return res
        return close_tq(svc, pid, tq_id, fix.label)


def close_tq(svc: Service, pid: str, tq_id: str, decision: str) -> AllocationResult:
    st, tq = _find_tq(svc, pid, tq_id)
    with st.lock:
        _decide(svc, pid, tq, "closed", decision)
        ts = now()
        from app.schemas import DecisionEntry
        svc.store.append("decisions", pid, ts, DecisionEntry(ts=ts, why=f"{tq.id}: {decision}", tq_id=tq.id).model_dump())
        comp = st.current
        assert comp is not None
        comp.tqs = svc.decorate_tqs(pid, comp.out.tqs)
        comp.kpis = comp.kpis.model_copy(update={"tqs_open": sum(t.status == "open" for t in comp.tqs)})
        svc.activity(pid, "tq", f"Closed {tq.id}: {decision}")
        return svc.result(st)

