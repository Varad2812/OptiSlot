"""Signal Workbench placement: check / apply / undo / redo / reset / changes / commit.

One oracle decides everything: a move is evaluated by re-running the engine with that cable pinned at the requested
position (every other cable stays where it is, hard rules may still unpin) and then running the INDEPENDENT verifier on
the result. `allowed` ⇔ the cable landed exactly there AND the verifier reports no new violation (and no new custom-rule
TQ). Plain-English reasons come from the static diagnosis (app.sandbox.diagnose_move) or from the verifier's own messages.

The sandbox is a stack of operations on top of the committed allocation (stored in the project's key/value table, so it
survives a restart). It is thrown away if the committed allocation changes underneath it. Nothing in the sandbox touches
exports, certificates or the decision log until /placement/commit turns it into a recorded manual override.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from app.schemas import (
    DecisionEntry, HardwareChange, Kpis, Move, PlacementAlternative, PlacementApplyRequest, PlacementApplyResult,
    PlacementChanges, PlacementChangeSet, PlacementCheck, PlacementCheckRequest, PlacementCommitRequest,
    PlacementCommitResult, PlacementMove, PlacementOp, PlacementReason, PlacementState, PlacementTarget, RuleCheckReport,
    RuleSet, Slot, SlotDiff, SpareImpact, SwapInfo, TQ, ViolationRef, SignalFix,
)
from app.sandbox import Refusal, _active_mdb, _active_table, _diff, _push, _rev_no, diagnose_move
from app.service import ProjectState, Service, now
from app.signals import Ctx, Idx, build_index, fixes_for, find_signal, reason_for, tag_key
from engine.allocate import Block
from engine.pipeline import RunOutput
from engine.revise import revise
from verify.checks import verify_rows

DRAFT_KEY = "placement_draft"
OVERRIDES_KEY = "manual_overrides"
MAX_ALT_EVALS = 12
Pos = tuple  # (ns, seq, local, bp, ch)


@dataclass
class View:
    """The slice of a Computed that the signal index needs, for any allocation."""
    out: RunOutput
    tqs: list[TQ]


@dataclass
class Eval:
    out: RunOutput
    report: RuleCheckReport
    landed: bool
    engine_reason: str = ""
    notes: dict[str, str] = field(default_factory=dict)


@dataclass
class Draft:
    base: str                                   # run_id of the committed allocation the sandbox sits on
    ops: list[dict] = field(default_factory=list)
    redo: list[dict] = field(default_factory=list)
    chain: list[tuple[RunOutput, RuleCheckReport]] = field(default_factory=list)   # state after op i
    stale: bool = False


# ───────────────────────────── state ─────────────────────────────

def _step(svc: Service, st: ProjectState, prev: RunOutput, moves: dict[str, Pos], notes: dict[str, str] | None = None) -> Eval:
    """The oracle: pin `moves` on top of `prev`, re-run, verify. Never raises on rule trouble (only on programming errors)."""
    rev = st.project.revision
    notes = notes or {c: "moved by the engineer in the What-if Sandbox (all hard rules re-checked)" for c in moves}
    out, _ = revise(_active_mdb(st), prev, st.ruleset, st.settings, from_rev=rev, to_rev=rev, rev_no=_rev_no(st),
                    moves=moves, manual_notes=notes, table=_active_table(svc, st))
    rep = verify_rows(out.rows, out.signals, st.ruleset, st.settings, out.tqs)
    landed, why = True, ""
    for cable, (_, seq, local, bp, ch) in moves.items():
        b = next((x for x in out.alloc.blocks if x.cable == cable), None)
        here = b is not None and b.cab is not None and b.pinned and (b.cab.seq, b.cioc, b.bp, b.ch) == (seq, local, bp, ch if not b.span else 1)
        if not here:
            landed = False
            why = (b.move_reason if b else None) or "a hard rule rejected the position"
            break
    return Eval(out, rep, landed, why, notes)


def _draft(svc: Service, st: ProjectState) -> Draft:
    """The sandbox for this project: loaded from the store, validated against the committed allocation, chain rebuilt."""
    comp = st.current or svc.recompute(st)
    d: Draft | None = st.extra.get("placement_draft")
    if d is None:
        raw = svc.store.get(st.project.id, DRAFT_KEY, None) or {}
        d = Draft(base=raw.get("base") or comp.cert.run_id, ops=list(raw.get("ops", [])), redo=list(raw.get("redo", [])))
        st.extra["placement_draft"] = d
    if d.base != comp.cert.run_id:                       # the committed allocation moved on: the sandbox no longer applies
        stale = bool(d.ops or d.redo)
        d = Draft(base=comp.cert.run_id, stale=stale)
        st.extra["placement_draft"] = d
        _save(svc, st, d)
    if len(d.chain) != len(d.ops):                       # rebuild (first use after a restart, or after undo/redo)
        d.chain.clear()
        prev = comp.out
        for i, op in enumerate(d.ops):
            ev = _step(svc, st, prev, {c: (tuple(p[0]), *p[1:]) for c, p in op["moves"].items()}, op.get("notes"))
            if not ev.landed:                            # cannot happen for a deterministic replay; drop the rest rather than lie
                d.ops = d.ops[:i]
                d.stale = True
                break
            d.chain.append((ev.out, ev.report))
            prev = ev.out
        _save(svc, st, d)
    return d


def _save(svc: Service, st: ProjectState, d: Draft) -> None:
    svc.store.put(st.project.id, DRAFT_KEY, {"base": d.base, "ops": d.ops, "redo": d.redo})


def _working(svc: Service, st: ProjectState) -> tuple[RunOutput, RuleCheckReport, Draft]:
    d = _draft(svc, st)
    if d.chain:
        out, rep = d.chain[-1]
        return out, rep, d
    comp = st.current
    assert comp is not None
    return comp.out, comp.report, d


def _kpis(out: RunOutput, rep: RuleCheckReport) -> Kpis:
    return out.kpis.model_copy(update={"violations": rep.violations})


# ───────────────────────────── helpers ─────────────────────────────

def _tags_of(out: RunOutput, cables: list[str], limit: int = 8) -> list[str]:
    want = set(cables)
    return [s.tag for s in out.signals if s.live and not s.quarantined and s.cable in want][:limit]


_RULE_RX = re.compile(r"\brule\s+((?:r|c)-[\w.-]+)", re.I)
_KINDS = {"rule", "capacity", "occupied", "reserved", "domain", "data", "engine", "verifier", "input", "error", "info"}


def _rid(text: str) -> str | None:
    m = _RULE_RX.search(text or "")
    return m.group(1) if m else None


def _reason_from(ref: Refusal, out: RunOutput, own_cable: str) -> PlacementReason:
    others = [c for c in dict.fromkeys(ref.cables) if c != own_cable]
    return PlacementReason(text=ref.text, kind=ref.kind if ref.kind in _KINDS else "rule",  # type: ignore[arg-type]
                           rule_id=ref.rule_id or _rid(ref.text), tags=_tags_of(out, others), cables=others)


def resolve_target(out: RunOutput, t: PlacementTarget) -> Slot | PlacementReason:
    slots = out.alloc.slots
    if t.slot_id:
        sl = next((s for s in slots if s.id == t.slot_id), None)
        return sl or PlacementReason(text=f"slot {t.slot_id} does not exist in the allocation", kind="input")
    if t.bp is None or t.ch is None or not t.cioc:
        return PlacementReason(text="the target needs slot_id, or cioc + bp + ch (and the cabinet when the CIOC is given as a number)",
                               kind="input")
    c = t.cioc.strip()
    cands = [s for s in slots if (t.cabinet is None or s.cabinet.lower() == t.cabinet.strip().lower())]
    if not cands:
        names = sorted({s.cabinet for s in slots})
        return PlacementReason(text=f"cabinet {t.cabinet} does not exist (cabinets: {', '.join(names[:12])})", kind="input")
    match = [s for s in cands if s.cioc.lower() == c.lower()]
    if not match and c.isdigit():
        n = int(c)
        match = [s for s in cands if s.cioc_seq == n] or ([s for s in cands if s.cioc_local == n] if t.cabinet else [])
    if not match:
        names = sorted({s.cioc for s in cands})
        return PlacementReason(text=f"CIOC {t.cioc} does not exist" + (f" in {t.cabinet}" if t.cabinet else "")
                               + f" (CIOCs: {', '.join(names[:8])})", kind="input")
    sl = next((s for s in match if s.bp == t.bp and s.ch == t.ch), None)
    if sl is None:
        s0 = match[0]
        return PlacementReason(text=f"baseplate {t.bp} channel {t.ch} does not exist on {s0.cioc} "
                                    f"(baseplates 1–{out.settings.baseplates_per_cioc}, channels 1–{out.settings.channels_per_baseplate})",
                               kind="input")
    return sl


def _origin(b: Block, pair: int, tgt: Slot, n_ch: int) -> tuple[int, int] | str:
    """Where the cable must start so that its `pair` lands on the target slot."""
    if b.span:
        off, c = divmod(pair - 1, n_ch)
        if tgt.ch != c + 1:
            return (f"pair {pair} of a {b.size}-pair cable sits on channel {c + 1} of its baseplate — a cable of "
                    f"{b.size} pairs starts at channel 1, so only channel {c + 1} of a baseplate can take this signal")
        bp0, ch0 = tgt.bp - off, 1
    else:
        bp0, ch0 = tgt.bp, tgt.ch - (pair - 1)
    if bp0 < 1 or ch0 < 1:
        return f"the {b.size}-pair cable would start before baseplate 1 / channel 1 if pair {pair} went to {tgt.id}"
    return bp0, ch0


def _pos(b: Block) -> Pos:
    assert b.cab is not None and b.cioc is not None and b.bp is not None
    return (b.cab.ns, b.cab.seq, b.cioc, b.bp, 1 if b.span else (b.ch or 1))


def _hw_changes(before: RunOutput, after: RunOutput) -> list[HardwareChange]:
    a = {s.tag_key: s for s in before.alloc.slots if s.status in ("Field", "Cabinet Alarm")}
    out = []
    for s in after.alloc.slots:
        if s.status not in ("Field", "Cabinet Alarm"):
            continue
        o = a.get(s.tag_key)
        if o and (o.charm, o.tb) != (s.charm, s.tb):
            out.append(HardwareChange(tag=s.tag, slot_id=s.id, charm_before=o.charm, charm_after=s.charm, tb_before=o.tb, tb_after=s.tb))
    return out


def _moves(before: RunOutput, after: RunOutput) -> list[PlacementMove]:
    a = {s.tag_key: s for s in before.alloc.slots if s.status in ("Field", "Cabinet Alarm")}
    out = []
    for s in after.alloc.slots:
        if s.status not in ("Field", "Cabinet Alarm"):
            continue
        o = a.get(s.tag_key)
        if o is None:
            out.append(PlacementMove(tag=s.tag, cable=s.cable, pair=s.pair, from_slot=None, to_slot=s.id,
                                     reason=s.remarks if s.remarks != "-" else "placed"))
        elif o.id != s.id:
            out.append(PlacementMove(tag=s.tag, cable=s.cable, pair=s.pair, from_slot=o.id, to_slot=s.id,
                                     reason=s.remarks if s.remarks != "-" else "moved"))
    return out


def _spare(before: RunOutput, after: RunOutput) -> SpareImpact:
    def cnt(o: RunOutput, status: str) -> int:
        return sum(1 for s in o.alloc.slots if s.status == status)

    def per_io(o: RunOutput) -> Counter:
        return Counter(s.io_type for s in o.alloc.slots if s.status == "Wired Spare")

    pb, pa = per_io(before), per_io(after)
    return SpareImpact(wired_spares_before=cnt(before, "Wired Spare"), wired_spares_after=cnt(after, "Wired Spare"),
                       spare_slots_before=cnt(before, "Spare Slot"), spare_slots_after=cnt(after, "Spare Slot"),
                       wired_target_before=before.kpis.wired_target, wired_target_after=after.kpis.wired_target,
                       by_io_type={k: pa[k] - pb[k] for k in sorted(set(pa) | set(pb)) if pa[k] != pb[k]})


def _violation_refs(rep: RuleCheckReport, base: RuleCheckReport) -> list[ViolationRef]:
    """Violations the move ADDED: per check, the failures beyond the baseline's count (messages unseen before come first)."""
    seen = {c.id: {re.sub(r"\d+", "#", v.message) for v in c.violations} for c in base.checks}
    was = {c.id: c.failed for c in base.checks}
    refs: list[ViolationRef] = []
    for c in rep.checks:
        extra = c.failed - was.get(c.id, 0)
        if extra <= 0 or c.severity != "hard":
            continue
        fresh = [v for v in c.violations if re.sub(r"\d+", "#", v.message) not in seen.get(c.id, set())] or c.violations
        for v in fresh[:max(extra, 1)]:
            refs.append(ViolationRef(check_id=c.id, label=c.label, message=v.message, row=v.row, tag=v.tag, slot_id=v.slot_id))
    return refs


def _new_tqs(before: RunOutput, after: RunOutput) -> list[TQ]:
    """TQs the move introduced that mean 'a rule could not be kept' (custom-rule clashes, unplaced cables)."""
    seen = {(t.category, tuple(sorted(t.tags))) for t in before.tqs}
    return [t for t in after.tqs if t.category in ("Custom rule clash", "Unsatisfiable layout", "Cabinet capacity", "Cable too large")
            and (t.category, tuple(sorted(t.tags))) not in seen]


def _fixes(idx: Idx, view: View) -> list[SignalFix]:
    cx = Ctx(view)
    return fixes_for(idx, cx.tqs, cx.by_cable, cx.io_map, [])


# ───────────────────────────── check ─────────────────────────────

def _run_check(svc: Service, st: ProjectState, req: PlacementCheckRequest):
    """→ (PlacementCheck, Eval | None, moves | None). Never a 500 for rule trouble: an unexpected evaluation error comes back
    as `refused` / "could not evaluate". An unknown tag is the caller's mistake (404)."""
    wout, wrep, _ = _working(svc, st)
    view = View(wout, svc.decorate_tqs(st.project.id, wout.tqs, persist=False))
    idx = find_signal(view, req.tag, req.row)             # unknown tag → KeyError → 404; ambiguous tag → ValueError → 422
    try:
        return _check(svc, st, wout, wrep, view, idx, req)
    except Exception as e:  # noqa: BLE001 — a failed evaluation is a refusal, never a crash
        return (PlacementCheck(verdict="refused", tag=idx.s.tag, cable=idx.s.cable or "-", pair=idx.s.pair,
                               from_slot=idx.slot.id if idx.slot else None,
                               reasons=[PlacementReason(text=f"could not evaluate this move: {type(e).__name__}: {e}", kind="error")]),
                None, None)


def check(svc: Service, pid: str, req: PlacementCheckRequest) -> PlacementCheck:
    st = svc.get(pid)
    with st.lock:
        return _run_check(svc, st, req)[0]


def _check(svc: Service, st: ProjectState, wout: RunOutput, wrep: RuleCheckReport, view: View, idx: Idx,
           req: PlacementCheckRequest) -> tuple[PlacementCheck, Eval | None, dict[str, Pos] | None]:
    s, slot = idx.s, idx.slot
    base = PlacementCheck(verdict="refused", tag=s.tag, cable=s.cable or "-", pair=s.pair, from_slot=slot.id if slot else None,
                          kpis_before=_kpis(wout, wrep))

    def refuse(*reasons: PlacementReason, alt: bool = True, block: Block | None = None, tgt: Slot | None = None) -> tuple:
        base.reasons = list(reasons)
        base.to_slot = tgt.id if tgt else None
        if idx.state in ("quarantined", "unallocated", "deleted"):
            base.fixes = _fixes(idx, view)
        if alt and block is not None and tgt is not None and (req.alternatives is None or req.alternatives > 0):
            base.alternatives = _alternatives(svc, st, wout, wrep, block, s.pair or 1, tgt, req.alternatives or 5)
        return base, None, None

    if idx.state == "deleted":
        return refuse(PlacementReason(text=reason_for(idx, {t.id: t for t in view.tqs}), kind="data"), alt=False)
    if idx.state == "quarantined":
        return refuse(PlacementReason(text=reason_for(idx, {t.id: t for t in view.tqs}), kind="data",
                                      rule_id=None), alt=False)
    if slot is not None and slot.status == "Cabinet Alarm":
        rid = wout.rules.rid("reserve_baseplate")
        return refuse(PlacementReason(text=f"{s.tag} is a cabinet alarm — it stays on the reserved baseplate (rule {rid})",
                                      kind="rule", rule_id=rid), alt=False)
    blocks = {b.id: b for b in wout.alloc.blocks}
    bid = (slot.block_id if slot else None) or Ctx(view).block_of.get(s.tag_key)
    b = blocks.get(bid) if bid else None
    if b is None:
        return refuse(PlacementReason(text=f"the cable of {s.tag} ({s.cable or 'none'}) has no block in the allocation", kind="engine"), alt=False)
    base.block_id = b.id
    tgt = resolve_target(wout, req.target)
    if isinstance(tgt, PlacementReason):
        return refuse(tgt, alt=False)
    base.to_slot = tgt.id
    n_ch = wout.settings.channels_per_baseplate
    pair = s.pair or 1
    org = _origin(b, pair, tgt, n_ch)
    if isinstance(org, str):
        return refuse(PlacementReason(text=org, kind="rule", rule_id=wout.rules.rid("cable_contiguous")), block=b, tgt=tgt)
    bp0, ch0 = org
    cur = _pos(b) if b.cab is not None and b.bp is not None else None
    if cur is not None and (cur[1], cur[2], cur[3], cur[4]) == (tgt.cabinet_seq, tgt.cioc_local, bp0, ch0 if not b.span else 1) \
            and b.cab.domain == tgt.domain:  # type: ignore[union-attr]
        base.verdict = "allowed"
        base.reasons = [PlacementReason(text=f"{s.tag} is already in {tgt.id} — nothing moves", kind="info")]
        base.kpis_after = base.kpis_before
        return base, None, {}
    res = diagnose_move(wout, st.ruleset, Move(block_id=b.id, target_cioc=tgt.cioc, target_bp=bp0, target_ch=ch0))
    if isinstance(res, Refusal):
        if res.kind == "occupied" and tgt.block_id and tgt.block_id != b.id and b.cab is not None:
            sw = _try_swap(svc, st, wout, wrep, view, idx, b, blocks[tgt.block_id], tgt, res, base)
            if sw is not None:
                return sw
        return refuse(_reason_from(res, wout, b.cable), block=b, tgt=tgt)
    moves = {res[0]: res[1]}
    ev = _step(svc, st, wout, moves, _notes(req, wout, b, tgt))
    return _verdict(base, ev, moves, wout, wrep, view, idx, b, tgt, req, svc, st)


def _notes(req: PlacementCheckRequest, wout: RunOutput, b: Block, tgt: Slot, extra: str = "") -> dict[str, str]:
    why = (req.reason or "").strip()
    return {b.cable: f"Manual override: {b.cable} moved by the engineer to {tgt.cioc} BP {tgt.bp}" + (f" — {why}" if why else "")
            + extra + " (all hard rules re-checked)"}


def _verdict(base: PlacementCheck, ev: Eval, moves: dict[str, Pos], wout: RunOutput, wrep: RuleCheckReport, view: View, idx: Idx,
             b: Block, tgt: Slot, req: PlacementCheckRequest, svc: Service, st: ProjectState, swap: SwapInfo | None = None):
    s = idx.s
    new_v = _violation_refs(ev.report, wrep)
    new_tq = _new_tqs(wout, ev.out)
    base.kpis_after = _kpis(ev.out, ev.report)
    base.changes = PlacementChanges(moves=_moves(wout, ev.out), hardware=_hw_changes(wout, ev.out), spare=_spare(wout, ev.out),
                                    new_violations=new_v, new_tqs=[t.id for t in new_tq])
    if ev.landed and not new_v and not new_tq:
        base.verdict = "swap" if swap else "allowed"
        base.swap = swap
        notes = []
        if swap:
            notes.append(PlacementReason(text=swap.note, kind="info", tags=_tags_of(wout, [swap.with_cable]), cables=[swap.with_cable]))
        elif b.size > 1:
            notes.append(PlacementReason(text=f"Moves the whole {b.size}-pair cable {b.cable} so that pair {s.pair} lands on {tgt.id} "
                                              f"(cables never split — rule {wout.rules.rid('cable_contiguous') or 'r-cable'}).", kind="info"))
        notes.append(PlacementReason(text=f"The independent verifier re-checked the result: {ev.report.checks_passed}/{ev.report.checks_total} "
                                          f"checks, {ev.report.violations} violation(s).", kind="info"))
        base.reasons = notes
        return base, ev, moves
    reasons: list[PlacementReason] = []
    if not ev.landed:
        reasons.append(PlacementReason(text=f"The engine could not keep {b.cable} at {tgt.id}: {ev.engine_reason}", kind="engine",
                                       rule_id=_rid(ev.engine_reason)))
    for v in new_v:
        reasons.append(PlacementReason(text=f"{v.check_id} {v.label}: {v.message}", kind="verifier",
                                       rule_id=_rid(v.message),
                                       tags=[v.tag] if v.tag and v.tag != s.tag else []))
    for t in new_tq:
        reasons.append(PlacementReason(text=f"{t.id}: {t.message}", kind="rule", rule_id=(t.rules_in_conflict or [None])[0], tags=t.tags[:8]))
    base.verdict = "refused"
    base.reasons = reasons
    if req.alternatives is None or req.alternatives > 0:
        base.alternatives = _alternatives(svc, st, wout, wrep, b, s.pair or 1, tgt, req.alternatives or 5)
    return base, None, None


def _try_swap(svc, st, wout, wrep, view, idx, b: Block, other: Block, tgt: Slot, why: Refusal, base: PlacementCheck):
    """The target is occupied by another cable: offer an exact swap when both cables have the same footprint."""
    if other.cab is None or other.bp is None or (b.span, b.foot) != (other.span, other.foot) or other.domain != b.domain:
        return None
    moves = {b.cable: _pos(other), other.cable: _pos(b)}
    ev = _step(svc, st, wout, moves, {
        b.cable: f"Manual override: swapped with {other.cable} by the engineer (all hard rules re-checked)",
        other.cable: f"Manual override: swapped with {b.cable} by the engineer (all hard rules re-checked)"})
    sw = SwapInfo(with_tag=(next(iter(other.members.values())).tag if other.members else other.cable), with_cable=other.cable,
                  with_slot=tgt.id, note=f"{tgt.id} is occupied by cable {other.cable}; swapping the two {b.size}-pair cables "
                                         f"({b.cable} ⇄ {other.cable}) is valid and leaves every hard rule satisfied.")
    out = _verdict(base, ev, moves, wout, wrep, view, idx, b, tgt, PlacementCheckRequest(tag=idx.s.tag, target=PlacementTarget(slot_id=tgt.id),
                                                                                         alternatives=0), svc, st, swap=sw)
    if out[0].verdict == "swap":
        return out
    out[0].reasons = [_reason_from(why, wout, b.cable), PlacementReason(text=f"A swap with {other.cable} was tried and refused:", kind="info"),
                      *out[0].reasons]
    out[0].swap = None
    return out[0], None, None


def _alternatives(svc: Service, st: ProjectState, wout: RunOutput, wrep: RuleCheckReport, b: Block, pair: int, want: Slot,
                  k: int) -> list[PlacementAlternative]:
    """The nearest `k` slots where this signal's cable WOULD be accepted: the domain's slots ranked by distance from the
    requested one, filtered by the static diagnosis, then confirmed by the oracle (engine + independent verifier)."""
    n_ch = wout.settings.channels_per_baseplate
    order = {key: i for i, key in enumerate(sorted({(c.domain, c.seq) for c in wout.alloc.cabs}))}
    here = {s.id for s in wout.alloc.slots if b.cab is not None and s.block_id == b.id and s.pair == pair}
    if want.domain != b.domain:      # the requested slot is in another controller domain: rank by distance from where the signal is now
        want = next((s for s in wout.alloc.slots if s.id in here), want)

    def dist(sl: Slot) -> int:
        return (abs(order.get((sl.domain, sl.cabinet_seq), 0) - order.get((want.domain, want.cabinet_seq), 0)) * 10_000
                + abs(sl.cioc_seq - want.cioc_seq) * 1_000 + abs(sl.bp - want.bp) * 20 + abs(sl.ch - want.ch))

    cands = sorted((s for s in wout.alloc.slots if s.domain == b.domain and s.id not in here and s.id != want.id),
                   key=lambda s: (dist(s), s.cabinet_seq, s.cioc_seq, s.bp, s.ch))
    out: list[PlacementAlternative] = []
    diagnosed = confirmed = 0
    for sl in cands:
        org = _origin(b, pair, sl, n_ch)
        if isinstance(org, str) or (not b.span and (org[1] - 1) % max(1, b.foot)):    # unreachable or off the cable grid
            continue
        diagnosed += 1
        if diagnosed > 600 or confirmed >= MAX_ALT_EVALS:
            break
        res = diagnose_move(wout, st.ruleset, Move(block_id=b.id, target_cioc=sl.cioc, target_bp=org[0], target_ch=org[1]))
        if isinstance(res, Refusal):
            continue
        confirmed += 1
        ev = _step(svc, st, wout, {res[0]: res[1]})
        if ev.landed and not _violation_refs(ev.report, wrep) and not _new_tqs(wout, ev.out):
            out.append(PlacementAlternative(slot_id=sl.id, cabinet=sl.cabinet, cioc=sl.cioc, bp=sl.bp, ch=sl.ch, distance=dist(sl)))
            if len(out) >= k:
                break
    return out


# ───────────────────────────── apply / undo / redo / reset ─────────────────────────────

def _state(svc: Service, st: ProjectState, with_changes: bool = True) -> PlacementState:
    d = _draft(svc, st)
    ops = [PlacementOp(n=i + 1, kind=o["kind"], tag=o["tag"], label=o["label"], reason=o.get("reason", ""), ts=o["ts"])
           for i, o in enumerate(d.ops)]
    stale, d.stale = d.stale, False
    return PlacementState(depth=len(d.ops), redo_depth=len(d.redo), ops=ops,
                          changes=_changeset(svc, st) if with_changes and d.ops else None, stale=stale)


def state(svc: Service, pid: str) -> PlacementState:
    st = svc.get(pid)
    with st.lock:
        return _state(svc, st)


def apply(svc: Service, pid: str, req: PlacementApplyRequest) -> PlacementApplyResult:
    st = svc.get(pid)
    with st.lock:
        wout, _wrep, d = _working(svc, st)
        chk, ev, moves = _run_check(svc, st, req)
        if chk.verdict == "swap" and not req.swap:
            chk.reasons.append(PlacementReason(text="This move is a swap — send swap: true to apply it.", kind="info"))
            ev = None
        if ev is None or not moves or chk.verdict == "refused":
            return PlacementApplyResult(applied=False, check=chk, kpis_before=chk.kpis_before, kpis_after=chk.kpis_before,
                                        state=_state(svc, st, with_changes=bool(d.ops)))
        n = len(d.ops) + 1
        label = f"swap {chk.cable} ⇄ {chk.swap.with_cable}" if chk.swap else f"move {chk.cable} → {chk.to_slot}"
        d.ops.append({"kind": "swap" if chk.swap else "move", "tag": chk.tag, "label": label, "reason": req.reason, "ts": now(),
                      "moves": {c: list(p) for c, p in moves.items()}, "notes": ev.notes})
        d.chain.append((ev.out, ev.report))
        d.redo = []
        _save(svc, st, d)
        svc.activity(pid, "whatif", f"Sandbox #{n}: {label} — {ev.report.violations} violations")
        return PlacementApplyResult(applied=True, check=chk, diff=_diff(wout, ev.out), kpis_before=chk.kpis_before,
                                    kpis_after=chk.kpis_after, report=ev.report, state=_state(svc, st))


def undo(svc: Service, pid: str) -> PlacementState:
    st = svc.get(pid)
    with st.lock:
        d = _draft(svc, st)
        if not d.ops:
            raise ValueError("nothing to undo in the sandbox")
        d.redo.append(d.ops.pop())
        d.chain.pop()
        _save(svc, st, d)
        svc.activity(pid, "whatif", f"Sandbox undo → {len(d.ops)} operation(s)")
        return _state(svc, st)


def redo(svc: Service, pid: str) -> PlacementState:
    st = svc.get(pid)
    with st.lock:
        d = _draft(svc, st)
        if not d.redo:
            raise ValueError("nothing to redo in the sandbox")
        d.ops.append(d.redo.pop())
        _save(svc, st, d)                       # the chain is rebuilt on the next read
        _draft(svc, st)
        return _state(svc, st)


def reset(svc: Service, pid: str) -> PlacementState:
    st = svc.get(pid)
    with st.lock:
        d = _draft(svc, st)
        d.ops, d.redo, d.chain = [], [], []
        _save(svc, st, d)
        svc.activity(pid, "whatif", "Sandbox reset")
        return _state(svc, st)


# ───────────────────────────── changes (Before / Now) ─────────────────────────────

_SLOT_KEY = lambda s: (s.status, s.tag, s.charm, s.tb, s.cable, s.pair, s.io_type)  # noqa: E731


def _changeset(svc: Service, st: ProjectState) -> PlacementChangeSet:
    comp = st.current
    assert comp is not None
    now_out, now_rep, _ = _working(svc, st)
    base_out = comp.out
    before = {s.id: s for s in base_out.alloc.slots}
    after = {s.id: s for s in now_out.alloc.slots}
    ids = sorted(i for i in set(before) | set(after) if i in before and i in after and _SLOT_KEY(before[i]) != _SLOT_KEY(after[i])
                 or (i in before) != (i in after))
    moves = _moves(base_out, now_out)
    return PlacementChangeSet(
        base_run_id=comp.cert.run_id, moves=moves, hardware=_hw_changes(base_out, now_out),
        from_ids=sorted({m.from_slot for m in moves if m.from_slot}), to_ids=sorted({m.to_slot for m in moves if m.to_slot}),
        slots_before=[before[i] for i in ids if i in before], slots_now=[after[i] for i in ids if i in after],
        kpis_before=comp.kpis, kpis_now=_kpis(now_out, now_rep), violations_now=now_rep.violations,
        verdict_now=now_rep.verdict)


def changes(svc: Service, pid: str) -> PlacementChangeSet:
    st = svc.get(pid)
    with st.lock:
        _draft(svc, st)
        return _changeset(svc, st)


# ───────────────────────────── commit ─────────────────────────────

def commit(svc: Service, pid: str, req: PlacementCommitRequest) -> PlacementCommitResult:
    """Sandbox moves → a recorded manual override: stored with the project's committed moves (so every recompute and Rev B
    replays them), a decision-log entry, a remark on every moved slot, and one step on the committed undo stack."""
    st = svc.get(pid)
    with st.lock:
        d = _draft(svc, st)
        if not d.ops:
            raise ValueError("nothing to commit — the sandbox is empty")
        comp = st.current
        assert comp is not None
        before_moves = svc.store.get(pid, "sandbox_moves", {}) or {}
        before_notes = svc.store.get(pid, OVERRIDES_KEY, {}) or {}
        after_moves, notes = dict(before_moves), dict(before_notes)
        ts = now()
        why = (req.reason or "").strip() or "; ".join(o["label"] for o in d.ops)
        for o in d.ops:
            for cable, pos in o["moves"].items():
                after_moves[cable] = list(pos)
                detail = o["label"] + (f" — {o['reason']}" if o.get("reason") else "")
                notes[cable] = f"Manual override [{req.who}, {ts[:10]}]: {detail}" + (f" — {req.reason.strip()}" if req.reason.strip() else "") \
                    + " (all hard rules re-checked)"
        moves_list = _changeset(svc, st).moves
        base_violations = comp.report.violations
        svc.store.put(pid, "sandbox_moves", after_moves)
        svc.store.put(pid, OVERRIDES_KEY, notes)
        svc.recompute_active(st)
        new = st.current
        assert new is not None
        if new.report.violations > base_violations:        # the replay disagrees with the sandbox: refuse, restore, never half-commit
            svc.store.put(pid, "sandbox_moves", before_moves)
            svc.store.put(pid, OVERRIDES_KEY, before_notes)
            svc.recompute_active(st)
            raise ValueError("commit refused: the committed replay would leave "
                             f"{new.report.violations - base_violations} new violation(s) — the sandbox was kept")
        _push(svc, pid, {"kind": "moves", "before": before_moves, "after": after_moves, "label": f"manual override: {why}"[:120]})
        entry = DecisionEntry(ts=ts, who=req.who, why=f"Manual override: {why}", patch={"placement": [
            {"tag": m.tag, "cable": m.cable, "from": m.from_slot, "to": m.to_slot} for m in moves_list]})
        svc.store.append("decisions", pid, ts, entry.model_dump())
        d.ops, d.redo, d.chain, d.base = [], [], [], new.cert.run_id
        _save(svc, st, d)
        svc.activity(pid, "whatif", f"Committed {len(moves_list)} manual-override move(s) — {new.report.violations} violations")
        return PlacementCommitResult(committed=len(moves_list), moves=moves_list, decision=entry, kpis=new.kpis, report=new.report)
