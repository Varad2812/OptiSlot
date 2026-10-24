"""POST /signals/{tag}/patch — fix a signal's data, re-validate it, and place it if possible.

The patch edits the raw MDB cell (xio.patches) and the project is re-run through the ordinary pipeline, so the preview
is exactly what a stored patch produces. A patch that would add a hard violation is refused; a stored patch is one step
on the committed undo stack and one entry in the decision log.
"""
from __future__ import annotations

import copy

from app.sandbox import _diff, _push
from app.schemas import DataPatch, DecisionEntry, SignalPatchRequest, SignalPatchResult
from app.service import ProjectState, Service, now
from app.signals import row_by_number, row_for
from xio.patches import MAX_VALUE, canonical, patch_key
from xio.reader import mapping_dict


def _quiet(svc: Service, st: ProjectState):
    """Recompute the active revision WITHOUT writing a run record (previews and refusals must leave no trace)."""
    if st.project.revision != "A" and st.extra.get("recompute_hook"):
        from app.revisions import compute_active
        return compute_active(svc, st, record=False)
    return svc.recompute(st, record=False)


def _verdict(row) -> str:
    return {"allocated": "placed", "warning": "warning", "unallocated": "unallocated", "quarantined": "quarantined"}.get(row.state, "unallocated")


def _run(svc: Service, pid: str, tag: str, row: int | None, mutate, *, preview: bool, who: str, reason: str, label: str) -> SignalPatchResult:
    st = svc.get(pid)
    with st.lock:
        comp0 = st.current
        assert comp0 is not None
        before = row_for(comp0, tag, row)
        old = copy.deepcopy(svc.store.get(pid, "data_patches", {}) or {})
        new = mutate(copy.deepcopy(old), before)
        if new == old:
            return SignalPatchResult(tag=before.tag, applied=False, stored=False, before=before, after=before, verdict="unchanged",
                                     messages=["nothing to change — the patch matches what is already stored"],
                                     kpis_before=comp0.kpis, kpis_after=comp0.kpis, report=comp0.report)
        svc.store.put(pid, "data_patches", new)
        try:
            with svc.no_persist():                    # a preview or a refused patch must not reserve TQ ids
                comp1 = _quiet(svc, st)
        except Exception:
            svc.store.put(pid, "data_patches", old)
            st.current = comp0
            raise
        after = row_by_number(comp1, before.row)
        added = comp1.report.violations - comp0.report.violations
        msgs = [label]
        if after.location:
            msgs.append(f"Placed at {after.location.slot_id} ({after.location.cioc} baseplate {after.location.bp} channel {after.location.ch}).")
        else:
            msgs.append(after.reason)
            msgs += [f"Fix: {f.label}" for f in after.fixes[:5]]
        keep = not preview and added <= 0
        if added > 0:
            msgs.append(f"Rejected: this correction would introduce {added} hard-rule violation(s) — nothing was stored.")
        new_ids = [t.id for t in comp1.tqs if t.id not in {x.id for x in comp0.tqs}]
        res = SignalPatchResult(tag=after.tag, applied=keep, stored=keep, before=before, after=after, verdict=_verdict(after),  # type: ignore[arg-type]
                                messages=msgs, diff=_diff(comp0.out, comp1.out), kpis_before=comp0.kpis, kpis_after=comp1.kpis,
                                report=comp1.report, new_tqs=new_ids)
        if not keep:                                        # preview or refusal: put everything back, no recompute needed
            svc.store.put(pid, "data_patches", old)
            st.current = comp0
            return res
        svc.stable_ids(pid, comp1.out.tqs)            # now the ids are real: keep them
        svc.record_run(st, comp1, "revision" if st.project.revision != "A" else "allocate")
        _push(svc, pid, {"kind": "patches", "before": old, "after": new, "label": label[:120]})
        ts = now()
        svc.store.append("decisions", pid, ts, DecisionEntry(
            ts=ts, who=who, why=f"Data patch: {label}" + (f" — {reason}" if reason else ""),
            patch={"data_patch": {"tag": before.tag, "row": before.row, "after": new.get(patch_key(before.tag_key, row if row else None))}}
        ).model_dump())
        svc.touch(st)
        svc.activity(pid, "import", f"Data patch: {label} → {res.verdict} · {comp1.report.violations} violations")
        return res


def patch_signal(svc: Service, pid: str, tag: str, req: SignalPatchRequest) -> SignalPatchResult:
    st = svc.get(pid)
    if not req.fields:
        raise ValueError("fields is empty — give at least one field to correct, e.g. {\"pair\": \"7\"}")
    fields: dict[str, str] = {}
    for k, v in req.fields.items():
        f = canonical(k)
        if v is None or len(str(v)) > MAX_VALUE:
            raise ValueError(f"value for '{k}' must be text of at most {MAX_VALUE} characters")
        fields[f] = str(v).strip()
    comp = st.current
    assert comp is not None
    mapped = mapping_dict(comp.out.mapping)
    missing = [f for f in fields if f not in mapped]
    if missing:
        raise ValueError(f"this MDB has no column mapped for {', '.join(missing)} — map one on the Import page first")

    def mutate(patches: dict, before) -> dict:
        key = patch_key(before.tag_key, req.row)
        cur = patches.get(key, {})
        raw = before.source
        # drop a patch that restores the original cell value instead of storing a no-op
        merged = {**cur, **fields}
        for f in list(merged):
            if raw.get(mapped[f], "") == merged[f] and f not in cur:
                del merged[f]
        if merged:
            patches[key] = merged
        else:
            patches.pop(key, None)
        return patches

    row = row_for(comp, tag, req.row)
    label = f"{row.tag}: " + ", ".join(f"{f} '{row.source.get(mapped[f], '')}' → '{v}'" for f, v in fields.items())
    return _run(svc, pid, tag, req.row, mutate, preview=req.preview, who=req.who, reason=req.reason, label=label)


def remove_patch(svc: Service, pid: str, tag: str, row: int | None = None, who: str = "engineer") -> SignalPatchResult:
    def mutate(patches: dict, before) -> dict:
        patches.pop(patch_key(before.tag_key, row), None)
        return patches
    return _run(svc, pid, tag, row, mutate, preview=False, who=who, reason="", label=f"{tag}: data patch removed")


def list_patches(svc: Service, pid: str) -> list[DataPatch]:
    svc.get(pid)
    out = []
    for key, fields in sorted((svc.store.get(pid, "data_patches", {}) or {}).items()):
        tk, _, r = key.partition("#")
        out.append(DataPatch(key=key, tag_key=tk, row=int(r) if r.isdigit() else None, fields=fields))
    return out
