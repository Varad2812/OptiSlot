"""Hypothesis: the placement check is exactly as strict as the engine + independent verifier.

INVARIANT  check == allowed  ⇔  applying the move gives the verifier 0 new violations (and the cable lands where asked).
The right-hand side is evaluated WITHOUT the check's static diagnosis: the move is pinned straight into the engine, then
verified. So an over-strict diagnosis (refusing something the engine+verifier accept) fails the test just like an
over-lenient one.
"""
from __future__ import annotations

import os
import tempfile

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.placement import _new_tqs, _origin, _step, _violation_refs, _working, check
from app.schemas import PlacementCheckRequest, PlacementTarget

EXAMPLES = int(os.environ.get("OPTISLOT_PROP_EXAMPLES", "300"))
PROFILE = settings(max_examples=EXAMPLES, deadline=None, suppress_health_check=list(HealthCheck), derandomize=True)

_STATE: dict = {}


def _svc():
    """One service for the whole module: the demo sample and a messy synthetic project (bad rows, A+B cables, oversize pairs …)."""
    if not _STATE:
        from app.service import Service
        from store.db import Store
        from xio.synthetic import generate
        from xio.writer import write_table
        svc = Service(Store(os.path.join(tempfile.mkdtemp(prefix="optislot-prop-"), "p.db")))
        svc.ensure_demo()
        headers, rows = generate(160, seed=11, nasty=True)
        svc.create_project("messy", "Messy", write_table(headers, rows), "messy.xlsx")
        _STATE["svc"] = svc
    return _STATE["svc"]


def _forced(svc, stt, wout, wrep, tag_key: str, tgt):
    """Pin the move straight into the engine (no static diagnosis) and verify. → (landed, clean) or None if the target is not a
    position this signal's pair can occupy."""
    slot = next(s for s in wout.alloc.slots if s.tag_key == tag_key and s.status == "Field")
    b = next(x for x in wout.alloc.blocks if x.id == slot.block_id)
    org = _origin(b, slot.pair or 1, tgt, wout.settings.channels_per_baseplate)
    if isinstance(org, str):
        return None
    cab = next(c for c in wout.alloc.cabs if c.seq == tgt.cabinet_seq and c.domain == tgt.domain)
    ev = _step(svc, stt, wout, {b.cable: (cab.ns, cab.seq, tgt.cioc_local, org[0], 1 if b.span else org[1])})
    clean = not _violation_refs(ev.report, wrep) and not _new_tqs(wout, ev.out) and not ev.collateral
    return ev.landed, clean


def _aligned_target(data, wout, src):
    """A slot where `src`'s pair lands if its cable starts on a legal (aligned) origin somewhere in its own controller domain —
    so most draws are real candidates instead of channel-misaligned nonsense."""
    b = next(x for x in wout.alloc.blocks if x.id == src.block_id)
    g = wout.settings
    grid = {(s.cabinet_seq, s.domain, s.cioc_local, s.bp, s.ch): s for s in wout.alloc.slots}
    cabs = [c for c in wout.alloc.cabs if c.domain == b.domain]
    cab = data.draw(st.sampled_from(cabs))
    local = data.draw(st.integers(1, g.ciocs_per_cabinet))
    bp0 = data.draw(st.integers(1, g.baseplates_per_cioc))
    ch0 = 1 if b.span else 1 + data.draw(st.integers(0, max(0, (g.channels_per_baseplate // max(1, b.foot)) - 1))) * max(1, b.foot)
    pair = src.pair or 1
    bp, ch = (bp0 + (pair - 1) // g.channels_per_baseplate, (pair - 1) % g.channels_per_baseplate + 1) if b.span else (bp0, ch0 + pair - 1)
    return grid.get((cab.seq, cab.domain, local, bp, ch))


def _property(pid: str, data) -> None:
    svc = _svc()
    stt = svc.get(pid)
    with stt.lock:
        wout, wrep, _ = _working(svc, stt)
        placed = [s for s in wout.alloc.slots if s.status == "Field" and s.block_id and s.tag_key]
        if not placed:
            return
        src = data.draw(st.sampled_from(placed))
        tgt = data.draw(st.sampled_from(wout.alloc.slots)) if data.draw(st.booleans()) else _aligned_target(data, wout, src)
        if tgt is None:
            return
        mode = data.draw(st.sampled_from(["slot", "slot", "triple"]))
        target = (PlacementTarget(slot_id=tgt.id) if mode == "slot"
                  else PlacementTarget(cabinet=tgt.cabinet, cioc=str(tgt.cioc_seq), bp=tgt.bp, ch=tgt.ch))
        res = check(svc, pid, PlacementCheckRequest(tag=src.tag, target=target, alternatives=0, row=src.source_row))
        assert res.verdict in ("allowed", "refused", "swap")
        if res.verdict == "allowed" and not res.changes.moves:
            return                                              # "already there"
        if res.verdict == "swap":
            assert res.swap and len(res.changes.moves) >= 2 and not res.changes.new_violations
            return
        fo = _forced(svc, stt, wout, wrep, src.tag_key, tgt)
        if res.verdict == "allowed":
            assert fo is not None, "allowed for a position the pair cannot occupy"
            landed, clean = fo
            assert landed and clean, f"{src.tag} → {tgt.id}: the check said allowed but engine+verifier disagree ({fo})"
            assert res.changes.new_violations == [] and res.kpis_after and res.kpis_after.violations <= (res.kpis_before.violations)
        else:
            kinds = {r.kind for r in res.reasons}
            assert res.reasons, "a refusal always says why"
            if fo is not None and not kinds & {"input", "data", "error"}:
                landed, clean = fo
                assert not (landed and clean), (f"{src.tag} → {tgt.id}: refused ({[r.text for r in res.reasons]}) but the engine "
                                                f"accepts it and the verifier is clean")


@PROFILE
@given(data=st.data())
def test_check_matches_engine_and_verifier_on_the_sample(data):
    _property("demo", data)


@PROFILE
@given(data=st.data())
def test_check_matches_engine_and_verifier_on_a_messy_project(data):
    _property("messy", data)


@settings(max_examples=40, deadline=None, suppress_health_check=list(HealthCheck), derandomize=True)
@given(data=st.data())
def test_every_alternative_offered_is_allowed(data):
    svc = _svc()
    stt = svc.get("demo")
    with stt.lock:
        wout, _, _ = _working(svc, stt)
        placed = [s for s in wout.alloc.slots if s.status == "Field" and s.block_id]
        src = data.draw(st.sampled_from(placed))
        tgt = data.draw(st.sampled_from(wout.alloc.slots))
        res = check(svc, "demo", PlacementCheckRequest(tag=src.tag, target=PlacementTarget(slot_id=tgt.id), alternatives=3))
        for alt in res.alternatives:
            again = check(svc, "demo", PlacementCheckRequest(tag=src.tag, target=PlacementTarget(slot_id=alt.slot_id), alternatives=0))
            assert again.verdict in ("allowed", "swap"), (src.tag, alt.slot_id, [r.text for r in again.reasons])
        assert len(res.alternatives) <= 3
        assert [a.distance for a in res.alternatives] == sorted(a.distance for a in res.alternatives)


@settings(max_examples=25, deadline=None, suppress_health_check=list(HealthCheck), derandomize=True)
@given(data=st.data())
def test_apply_then_reset_restores_the_committed_allocation_exactly(data):
    from app.placement import apply, reset
    from app.schemas import PlacementApplyRequest
    svc = _svc()
    stt = svc.get("demo")
    before = list(stt.current.out.rows)
    with stt.lock:
        reset(svc, "demo")
        wout, _, _ = _working(svc, stt)
        placed = [s for s in wout.alloc.slots if s.status == "Field" and s.block_id]
        applied = 0
        for _ in range(data.draw(st.integers(1, 3))):
            wout, _, _ = _working(svc, stt)
            src = data.draw(st.sampled_from([s for s in wout.alloc.slots if s.status == "Field" and s.block_id]))
            tgt = data.draw(st.sampled_from(wout.alloc.slots))
            r = apply(svc, "demo", PlacementApplyRequest(tag=src.tag, target=PlacementTarget(slot_id=tgt.id), alternatives=0, swap=True))
            applied += r.applied
            if r.applied:
                assert r.report and r.report.violations == 0 and r.state.depth == applied
        st_ = reset(svc, "demo")
        assert st_.depth == 0 and stt.current.out.rows == before, "the sandbox must never touch the committed allocation"
        assert placed
