"""Revision service: a linear chain A → B → C …, each revision pinned against the one before it.

    Rev A  = the plain allocation of the project's MDB
    Rev N  = engine.revise(MDB of N, output of N-1)  — unchanged signals keep their slot, every move has a reason

Uploading a revision appends the next letter; `rev=` replaces an existing letter (and drops the revisions after it, because
they were pinned against the old one). The Revision Gauntlet defaults to Rev B (idempotent), `rev=C` builds Rev C from Rev B.
"""
from __future__ import annotations

import hashlib
import time

from app.schemas import AllocationResult, RevisionImpact
from app.service import LETTERS, Computed, ProjectState, Service, now, rev_no
from engine.pipeline import RunOutput, run
from engine.revise import revise
from xio.gauntlet import build


def _letters(svc: Service, st: ProjectState) -> list[str]:
    return ["A", *svc.revs(st)]


def _data(svc: Service, st: ProjectState, letter: str) -> tuple[bytes, str]:
    if letter == "A":
        return st.mdb, st.mdb_name
    r = svc.revs(st)[letter]
    return r["data"], r["name"]


def _step(svc: Service, st: ProjectState, letter: str, rs=None, settings=None) -> tuple[RunOutput, RevisionImpact | None]:
    """Compute revision `letter` (fresh — never from the cache). Predecessors always come from the cache, computed under the
    stored rule set: a what-if (rs / settings) only changes the last step."""
    rs, settings = rs or st.ruleset, settings or st.settings
    letters = _letters(svc, st)
    i = letters.index(letter)
    if i == 0:
        out = run(st.mdb, rs, settings, st.overrides or None, filename=st.mdb_name, table=svc.table(st, "a"))
        return svc.apply_tq_pins(st, out, "A", rs, settings), None
    prev = letters[i - 1]
    prev_out, _ = chain(svc, st, prev)
    data, name = _data(svc, st, letter)
    pins = {c: tuple(p) for c, p in svc.tq_pins(st, letter).items()}     # what stayed in place when a TQ was applied
    notes = {c: "kept in place when a TQ fix was applied (pinned)" for c in pins}
    return revise(data, prev_out, rs, settings, filename=name, from_rev=prev, to_rev=letter, rev_no=rev_no(letter, settings.revision),
                  table=svc.table(st, letter.lower()), moves=pins or None, manual_notes=notes if pins else None)


def chain(svc: Service, st: ProjectState, letter: str) -> tuple[RunOutput, RevisionImpact | None]:
    """Cached output of a revision under the stored rule set and settings (A → … → letter, each pinned to its predecessor)."""
    letters = _letters(svc, st)
    shas = tuple(hashlib.sha256(_data(svc, st, x)[0]).hexdigest()[:12] for x in letters[:letters.index(letter) + 1])
    key = (letter, st.ruleset.version, st.settings.model_dump_json(), svc.patch_hash(st), svc.pins_hash(st), shas)
    cache = st.extra.setdefault("chain_cache", {})
    if key not in cache:
        cache[key] = _step(svc, st, letter)
    return cache[key]


def chain_output(svc: Service, st: ProjectState, rs, settings) -> RunOutput:
    """The ACTIVE revision under a what-if rule set / settings (nothing cached, nothing stored)."""
    return _step(svc, st, st.project.revision, rs, settings)[0]


def compute_active(svc: Service, st: ProjectState, record: bool = True) -> Computed:
    t0 = time.perf_counter()
    out, impact = _step(svc, st, st.project.revision)
    from app.sandbox import apply_sandbox
    out = apply_sandbox(svc, st, out)
    comp = svc.certify(st, out, t0, impact)
    st.current = comp
    if record:
        svc.record_run(st, comp, "revision")
    return comp


def activate(svc: Service, st: ProjectState, letter: str, record: bool = True) -> Computed:
    revs = svc.revs(st)
    st.extra["recompute_hook"] = lambda s: compute_active(svc, s)
    st.project.revision = letter
    st.project.revisions = ["A", *revs]
    return compute_active(svc, st, record)


def _persist(svc: Service, st: ProjectState) -> None:
    pid = st.project.id
    revs = svc.revs(st)
    svc.store.put(pid, "rev_letters", list(revs))
    for letter, r in revs.items():
        key = f"mdb_{letter.lower()}"
        svc.store.put_file(pid, key, "mdb", hashlib.sha256(r["data"]).hexdigest(), r["data"], now())
        svc.store.put(pid, key + "_name", r["name"])


def apply_revision(svc: Service, pid: str, data: bytes, filename: str, steps: list | None = None, rev: str | None = None) -> RevisionImpact:
    st = svc.get(pid)
    with st.lock:
        revs = svc.revs(st)
        have = list(revs)
        nxt = LETTERS[len(have) + 1]
        target = (rev or nxt).upper()
        if target not in LETTERS[1:] or LETTERS.index(target) > len(have) + 1:
            raise ValueError(f"Rev {target} cannot be added: the next revision is Rev {nxt} (revisions form a chain A → B → C …)")
        for dropped in have[LETTERS.index(target) - 1:]:    # a replaced revision invalidates the ones pinned against it
            del revs[dropped]
            svc.store.del_file(pid, f"mdb_{dropped.lower()}")
        revs[target] = {"data": data, "name": filename}
        st.extra.pop("chain_cache", None)
        _persist(svc, st)
        svc.store.put(pid, "revision", target)
        comp = activate(svc, st, target)
        svc.touch(st)
        imp = comp.impact
        assert imp is not None
        if steps:
            svc.activity(pid, "revision", "Revision Gauntlet: " + " · ".join(f"{s.n}. {s.action} {s.tag}" for s in steps))
        svc.activity(pid, "revision", f"Rev {target} from {filename} (pinned against Rev {imp.from_rev}): +{len(imp.added)} −{len(imp.deleted)} "
                                      f"~{len(imp.modified)} moved {len(imp.moved)} · stability {imp.stability_pct}% · "
                                      f"{comp.report.violations} violations · {len(imp.new_tqs)} new TQ(s)")
        return imp


def run_gauntlet(svc: Service, pid: str, rev: str | None = None) -> RevisionImpact:
    st = svc.get(pid)
    with st.lock:
        target = (rev or "B").upper()
        if target not in LETTERS[1:] or LETTERS.index(target) > len(svc.revs(st)) + 1:
            raise ValueError(f"Rev {target} cannot be built yet — build or upload the revision before it first")
        prev = LETTERS[LETTERS.index(target) - 1]
        prev_out, _ = chain(svc, st, prev)
        data, steps = build(_data(svc, st, prev)[0], prev_out)
        st.extra["gauntlet_steps"] = [s.__dict__ for s in steps]
        svc.store.put(pid, "gauntlet_steps", st.extra["gauntlet_steps"])
    return apply_revision(svc, pid, data, f"{st.project.id}_Rev{target}_gauntlet.xlsx", steps, rev=target)


def switch(svc: Service, pid: str, rev: str) -> AllocationResult:
    st = svc.get(pid)
    with st.lock:
        rev = rev.upper()
        if rev != "A" and rev not in svc.revs(st):
            have = ", ".join(_letters(svc, st))
            raise ValueError(f"No Rev {rev} loaded yet — inject or upload one first (loaded: {have})")
        svc.store.put(pid, "revision", None if rev == "A" else rev)
        if rev == "A":
            st.extra.pop("recompute_hook", None)
            st.project.revision = "A"
            svc.recompute(st, record=False)
        else:
            activate(svc, st, rev, record=False)
        svc.touch(st)
        svc.activity(pid, "revision", f"Switched to Rev {rev}")
        return svc.result(st)
