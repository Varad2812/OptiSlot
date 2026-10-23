"""Revision service: Rev B (uploaded or the Gauntlet) against the Rev A baseline; switch between revisions."""
from __future__ import annotations

import hashlib
import time

from app.schemas import AllocationResult, RevisionImpact
from app.service import Computed, ProjectState, Service, now
from engine.pipeline import run
from engine.revise import revise
from xio.gauntlet import build


def _rev_a(svc: Service, st: ProjectState):
    """The Rev A run output (recomputed from stored inputs if needed)."""
    a = st.extra.get("rev_a_out")
    if a is None or st.extra.get("rev_a_key") != (st.ruleset.version, st.settings.model_dump_json()):
        a = run(st.mdb, st.ruleset, st.settings, st.overrides or None, filename=st.mdb_name)
        st.extra["rev_a_out"] = a
        st.extra["rev_a_key"] = (st.ruleset.version, st.settings.model_dump_json())
    return a


def _compute_b(svc: Service, st: ProjectState, record: bool = True) -> Computed:
    t0 = time.perf_counter()
    a = _rev_a(svc, st)
    revb: bytes = st.extra["mdb_b"]
    out, impact = revise(revb, a, st.ruleset, st.settings, filename=st.extra.get("mdb_b_name", "RevB.xlsx"))
    comp = svc.certify(st, out, t0, impact)
    st.current = comp
    if record:
        svc.record_run(st, comp, "revision")
    return comp


def activate_b(svc: Service, st: ProjectState, record: bool = True) -> Computed:
    st.extra["mdb_b"] = st.extra.get("mdb_b") or svc.store.get_file(st.project.id, "mdb_b")
    st.extra["mdb_b_name"] = svc.store.get(st.project.id, "mdb_b_name", "RevB.xlsx")
    st.extra["recompute_hook"] = lambda s: _compute_b(svc, s)
    st.project.revision = "B"
    st.project.revisions = ["A", "B"]
    return _compute_b(svc, st, record)


def apply_revision(svc: Service, pid: str, data: bytes, filename: str, steps: list | None = None) -> RevisionImpact:
    st = svc.get(pid)
    with st.lock:
        ts = now()
        svc.store.put_file(pid, "mdb_b", "mdb", hashlib.sha256(data).hexdigest(), data, ts)
        svc.store.put(pid, "mdb_b_name", filename)
        svc.store.put(pid, "revision", "B")
        st.extra["mdb_b"] = data
        comp = activate_b(svc, st)
        svc.touch(st)
        imp = comp.impact
        assert imp is not None
        if steps:
            svc.activity(pid, "revision", "Revision Gauntlet: " + " · ".join(f"{s.n}. {s.action} {s.tag}" for s in steps))
        svc.activity(pid, "revision", f"Rev B from {filename}: +{len(imp.added)} −{len(imp.deleted)} ~{len(imp.modified)} "
                                      f"moved {len(imp.moved)} · stability {imp.stability_pct}% · {comp.report.violations} violations · "
                                      f"{len(imp.new_tqs)} new TQ(s)")
        return imp


def run_gauntlet(svc: Service, pid: str) -> RevisionImpact:
    st = svc.get(pid)
    with st.lock:
        a = _rev_a(svc, st)
        data, steps = build(st.mdb, a)
        st.extra["gauntlet_steps"] = [s.__dict__ for s in steps]
        svc.store.put(pid, "gauntlet_steps", st.extra["gauntlet_steps"])
    return apply_revision(svc, pid, data, f"{st.project.id}_RevB_gauntlet.xlsx", steps)


def switch(svc: Service, pid: str, rev: str) -> AllocationResult:
    st = svc.get(pid)
    with st.lock:
        if rev == "B":
            if not (st.extra.get("mdb_b") or svc.store.get_file(pid, "mdb_b")):
                raise ValueError("No Rev B loaded yet — inject or upload one first")
            svc.store.put(pid, "revision", "B")
            activate_b(svc, st, record=False)
        else:
            svc.store.put(pid, "revision", "A")
            st.extra.pop("recompute_hook", None)
            st.project.revision = "A"
            svc.recompute(st, record=False)
        svc.touch(st)
        svc.activity(pid, "revision", f"Switched to Rev {rev}")
        return svc.result(st)
