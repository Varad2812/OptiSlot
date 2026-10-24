"""OptiSlot FastAPI app — the frozen contract in app/schemas.py, backed by the real engine + verifier.

`make demo` builds the frontend into frontend/dist and this app serves it at / (one offline process).
"""
from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app.schemas import (
    AllocationResult, ColumnMapping, DecisionEntry, ExportFile, ImportSummary, PlacementApplyRequest, PlacementApplyResult,
    PlacementChangeSet, PlacementCheck, PlacementCheckRequest, PlacementCommitRequest, PlacementCommitResult, PlacementState,
    DataPatch, Project, ProjectSettings, RevisionImpact, RuleCatalogue, RuleChange, RuleCheckReport, RuleDraft, RuleEdit, RuleInput,
    AssistAnswer, AssistAskRequest, AssistStatus, NLRuleRequest, NLRuleResult,
    RuleListing, RulePreviewRequest, RuleSet, RunRecord, SignalList, SignalPatchRequest, SignalPatchResult, SignalRow, StressResult, TQ, WhatIfRequest, WhatIfResult, WhyStep,
)
from app.service import DEMO_ID, Service
from store.db import DEFAULT_DB, Store

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "frontend" / "dist"
MAX_UPLOAD = 50 * 1024 * 1024

svc = Service(Store(os.environ.get("OPTISLOT_DB", DEFAULT_DB)))


@asynccontextmanager
async def lifespan(_: FastAPI):
    svc.ensure_demo()
    svc.get(DEMO_ID)  # warm: the demo project is allocated before the first request
    yield


app = FastAPI(title="OptiSlot API", version="0.1.0", description="Allocate. Prove. Revise.", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.exception_handler(KeyError)
async def not_found(_, exc: KeyError):
    return JSONResponse({"detail": f"not found: {exc.args[0] if exc.args else exc}"}, status_code=404)


@app.exception_handler(ValueError)
async def bad_input(_, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=422)


async def _read(file: UploadFile) -> bytes:
    data = await file.read()
    if not data:
        raise ValueError("empty upload")
    if len(data) > MAX_UPLOAD:
        raise ValueError("file too large (max 50 MB)")
    return data


def _xlsx(data: bytes, filename: str) -> Response:
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ───────────── projects ─────────────

@app.get("/api/projects", response_model=list[Project])
def list_projects():
    return [svc.get(p["id"]).project for p in svc.store.list_projects()]


@app.get("/api/projects/{pid}", response_model=Project)
def get_project(pid: str):
    return svc.get(pid).project


@app.get("/api/projects/{pid}/import", response_model=ImportSummary)
def get_import(pid: str):
    return svc.import_summary(svc.get(pid))


@app.post("/api/projects/{pid}/import", response_model=ImportSummary)
async def import_mdb(pid: str, file: UploadFile | None = File(None), files: list[UploadFile] = File(default_factory=list)):
    """One MDB (`file`, .xlsx/.xlsm/.csv) or several (`files`, repeated field): several are merged with duplicate-tag
    detection. Mappings below 70% confidence come back with needs_confirmation."""
    ups = ([file] if file is not None else []) + list(files)
    if not ups:
        raise ValueError("no file uploaded (send `file`, or `files` for several)")
    return svc.import_files(pid, [(await _read(f), f.filename or "upload.xlsx") for f in ups])


@app.post("/api/projects/{pid}/mapping", response_model=ImportSummary)
def set_mapping(pid: str, mapping: list[ColumnMapping]):
    return svc.set_mapping(pid, mapping)


@app.get("/api/projects/{pid}/settings", response_model=ProjectSettings)
def get_settings(pid: str):
    return svc.get(pid).settings


@app.put("/api/projects/{pid}/settings", response_model=AllocationResult)
def put_settings(pid: str, settings: ProjectSettings):
    return svc.put_settings(pid, settings)


# ───────────── rules ─────────────

@app.get("/api/projects/{pid}/rules", response_model=RuleSet)
def get_rules(pid: str):
    return svc.get(pid).ruleset


@app.put("/api/projects/{pid}/rules", response_model=AllocationResult)
def put_rules(pid: str, ruleset: RuleSet, why: str = Query("rule set edited")):
    return svc.put_rules(pid, ruleset, why)


@app.get("/api/projects/{pid}/rules/versions", response_model=list[dict])
def rule_versions(pid: str):
    svc.get(pid)
    return svc.store.ruleset_versions(pid)


@app.get("/api/projects/{pid}/decisions", response_model=list[DecisionEntry])
def decisions(pid: str):
    svc.get(pid)
    return [DecisionEntry.model_validate(d) for d in svc.store.log("decisions", pid)]


@app.post("/api/projects/{pid}/rules/draft", response_model=RuleDraft)
def draft_rule(pid: str, body: dict):
    from app.drafting import draft
    return draft(str(body.get("text", "")), svc.get(pid).ruleset)


@app.get("/api/rule-types", response_model=RuleCatalogue)
def rule_types():
    """Rule templates with parameter schemas, the filter language and what enforces each rule."""
    from app.rulesapi import catalogue
    return catalogue()


@app.get("/api/projects/{pid}/rule-types", response_model=RuleCatalogue)
def project_rule_types(pid: str):
    from app.rulesapi import catalogue
    svc.get(pid)
    return catalogue()


@app.get("/api/projects/{pid}/rules/listing", response_model=RuleListing)
def rules_listing(pid: str):
    """Every rule with enforced | advisory | off, its severity, the verifier checks that test it and their last result."""
    from app.rulesapi import listing
    return listing(svc, pid)


@app.post("/api/projects/{pid}/rules/nl", response_model=NLRuleResult)
def rules_nl(pid: str, req: NLRuleRequest):
    """English → validated rule candidates (LLM when a key is set, else a deterministic parser). Saves NOTHING: preview with
    POST /rules/preview, then POST /rules."""
    from app.assist import nl_rule
    svc.get(pid)
    return nl_rule(req.text)


@app.get("/api/assist/status", response_model=AssistStatus)
def assist_status():
    from app.assist import status
    return status()


@app.post("/api/projects/{pid}/assist/ask", response_model=AssistAnswer)
def assist_ask(pid: str, req: AssistAskRequest):
    """Help chat grounded in existing data (signal reasons, placement checks, the rule listing). Rephrases, never decides."""
    from app.assist import ask
    svc.get(pid)
    return ask(svc, pid, req)


@app.post("/api/projects/{pid}/rules", response_model=RuleChange)
def add_rule(pid: str, rule: RuleInput):
    """Add a custom rule (max_per_scope, scope_relation, forbid_mix, zone_cabinets, extra_spares). A malformed rule is a
    422 naming the problem; a rule that would leave a hard violation is refused (stored=false) with the reason."""
    from app.rulesapi import add_rule as _add
    return _add(svc, pid, rule)


@app.post("/api/projects/{pid}/rules/preview", response_model=RuleChange)
def preview_rule(pid: str, req: RulePreviewRequest):
    """The full what-if of a rule change — diff, scoreboard, report — WITHOUT touching the stored rule set, the decision log
    or the TQ numbering."""
    from app.rulesapi import preview
    return preview(svc, pid, req)


@app.put("/api/projects/{pid}/rules/{rule_id}", response_model=RuleChange)
def edit_rule(pid: str, rule_id: str, edit: RuleEdit):
    from app.rulesapi import edit_rule as _edit
    return _edit(svc, pid, rule_id, edit)


@app.delete("/api/projects/{pid}/rules/{rule_id}", response_model=RuleChange)
def delete_rule(pid: str, rule_id: str, force: bool = False, who: str = "engineer"):
    from app.rulesapi import delete_rule as _del
    return _del(svc, pid, rule_id, force, who)


# ───────────── allocation ─────────────

@app.get("/api/projects/{pid}/allocation", response_model=AllocationResult)
def get_allocation(pid: str):
    return svc.result(svc.get(pid))


@app.post("/api/projects/{pid}/allocate", response_model=AllocationResult)
def allocate(pid: str):
    return svc.allocate(pid)


@app.post("/api/projects/{pid}/verify", response_model=RuleCheckReport)
def verify(pid: str):
    return svc.verify(pid)


@app.get("/api/projects/{pid}/tqs", response_model=list[TQ])
def list_tqs(pid: str):
    st = svc.get(pid)
    return st.current.tqs if st.current else []


@app.get("/api/projects/{pid}/slots/{slot_id:path}/why", response_model=list[WhyStep])
def slot_why(pid: str, slot_id: str):
    st = svc.get(pid)
    for s in st.current.out.alloc.slots:  # type: ignore[union-attr]
        if s.id == slot_id:
            return s.why
    raise KeyError(slot_id)


@app.get("/api/projects/{pid}/rows", response_model=list[dict[str, str]])
def rows(pid: str):
    """The 76-column allocation rows exactly as written to Excel."""
    return svc.get(pid).current.out.rows  # type: ignore[union-attr]


@app.post("/api/projects/{pid}/whatif", response_model=WhatIfResult)
def whatif(pid: str, req: WhatIfRequest):
    from app.sandbox import whatif as run_whatif
    return run_whatif(svc, pid, req)


@app.post("/api/projects/{pid}/commit", response_model=AllocationResult)
def commit(pid: str, req: WhatIfRequest):
    from app.sandbox import commit as run_commit
    return run_commit(svc, pid, req)


@app.post("/api/projects/{pid}/undo", response_model=AllocationResult)
def undo(pid: str):
    from app.sandbox import undo as run_undo
    return run_undo(svc, pid)


@app.post("/api/projects/{pid}/redo", response_model=AllocationResult)
def redo(pid: str):
    from app.sandbox import redo as run_redo
    return run_redo(svc, pid)


@app.post("/api/projects/{pid}/tqs/{tq_id}/apply", response_model=AllocationResult)
def apply_tq(pid: str, tq_id: str, option: int = 0):
    from app.sandbox import apply_tq as run_apply
    return run_apply(svc, pid, tq_id, option)


@app.post("/api/projects/{pid}/tqs/{tq_id}/close", response_model=AllocationResult)
def close_tq(pid: str, tq_id: str, decision: str = Query("Accepted as is")):
    from app.sandbox import close_tq as run_close
    return run_close(svc, pid, tq_id, decision)


# ───────────── Signal Workbench ─────────────

@app.get("/api/projects/{pid}/signals", response_model=SignalList)
def signals(pid: str, q: str | None = None, io_type: str | None = None, status: str | None = None, cabinet: str | None = None,
            cioc: str | None = None, cable: str | None = None, tq: str | None = None, sort: str = "row", order: str = "asc",
            limit: int = Query(100, ge=1, le=5000), offset: int = Query(0, ge=0)):
    """EVERY signal (allocated, warning, unallocated, quarantined, deleted) with its slot, hardware, plain-English reason and
    fixes. Filters: q (free text), io_type, status (a state or a Tag Status, comma-separated), cabinet, cioc, cable, tq."""
    from app.signals import list_signals
    st = svc.get(pid)
    return list_signals(st, st.current, q=q, io_type=io_type, status=status, cabinet=cabinet, cioc=cioc, cable=cable, tq=tq,
                        sort=sort, order=order, limit=limit, offset=offset)


@app.post("/api/projects/{pid}/signals/{tag:path}/patch", response_model=SignalPatchResult)
def signal_patch(pid: str, tag: str, req: SignalPatchRequest):
    """Fix a signal's data (io_type, cable, pair, group, instrument_type …): the MDB cell is corrected, the row is
    re-validated and placed if possible. `preview: true` shows the outcome without storing anything."""
    from app.signalfix import patch_signal
    return patch_signal(svc, pid, tag, req)


@app.delete("/api/projects/{pid}/signals/{tag:path}/patch", response_model=SignalPatchResult)
def signal_unpatch(pid: str, tag: str, row: int | None = None, who: str = "engineer"):
    from app.signalfix import remove_patch
    return remove_patch(svc, pid, tag, row, who)


@app.get("/api/projects/{pid}/patches", response_model=list[DataPatch])
def data_patches(pid: str):
    from app.signalfix import list_patches
    return list_patches(svc, pid)


@app.get("/api/projects/{pid}/signals/{tag:path}", response_model=SignalRow)
def signal(pid: str, tag: str, row: int | None = None):
    from app.signals import row_for
    st = svc.get(pid)
    return row_for(st.current, tag, row)


@app.post("/api/projects/{pid}/placement/check", response_model=PlacementCheck)
def placement_check(pid: str, req: PlacementCheckRequest):
    """Can this signal go to that slot? allowed | refused | swap, with plain-English reasons, what would change and the
    nearest allowed alternatives. The verdict is the engine + the independent verifier's, not a guess."""
    from app.placement import check
    return check(svc, pid, req)


@app.post("/api/projects/{pid}/placement/apply", response_model=PlacementApplyResult)
def placement_apply(pid: str, req: PlacementApplyRequest):
    from app.placement import apply
    return apply(svc, pid, req)


@app.get("/api/projects/{pid}/placement", response_model=PlacementState)
def placement_state(pid: str):
    from app.placement import state
    return state(svc, pid)


@app.post("/api/projects/{pid}/placement/undo", response_model=PlacementState)
def placement_undo(pid: str):
    from app.placement import undo
    return undo(svc, pid)


@app.post("/api/projects/{pid}/placement/redo", response_model=PlacementState)
def placement_redo(pid: str):
    from app.placement import redo
    return redo(svc, pid)


@app.post("/api/projects/{pid}/placement/reset", response_model=PlacementState)
def placement_reset(pid: str):
    from app.placement import reset
    return reset(svc, pid)


@app.get("/api/projects/{pid}/placement/changes", response_model=PlacementChangeSet)
def placement_changes(pid: str):
    from app.placement import changes
    return changes(svc, pid)


@app.post("/api/projects/{pid}/placement/commit", response_model=PlacementCommitResult)
def placement_commit(pid: str, req: PlacementCommitRequest | None = None):
    from app.placement import commit
    return commit(svc, pid, req or PlacementCommitRequest())


# ───────────── revisions ─────────────

@app.post("/api/projects/{pid}/revisions", response_model=RevisionImpact)
async def upload_revision(pid: str, file: UploadFile = File(...), rev: str | None = Query(None, description="Letter to (re)place, e.g. C. Default: the next revision in the chain")):
    """Adds the next revision (B, then C …) pinned against the previous one. `rev` replaces an existing letter and drops the later ones."""
    from app.revisions import apply_revision
    return apply_revision(svc, pid, await _read(file), file.filename or "Rev.xlsx", rev=rev)


@app.post("/api/projects/{pid}/revisions/gauntlet", response_model=RevisionImpact)
def gauntlet(pid: str, rev: str | None = Query(None, description="Revision to build (default B, from Rev A); C builds on B …")):
    from app.revisions import run_gauntlet
    return run_gauntlet(svc, pid, rev)


@app.get("/api/projects/{pid}/revisions/impact", response_model=RevisionImpact | None)
def revision_impact(pid: str):
    st = svc.get(pid)
    return st.current.impact if st.current else None


@app.post("/api/projects/{pid}/revisions/switch", response_model=AllocationResult)
def switch_revision(pid: str, rev: str = Query(...)):
    from app.revisions import switch
    return switch(svc, pid, rev)


# ───────────── proof / export ─────────────

@app.get("/api/projects/{pid}/runs", response_model=list[RunRecord])
def runs(pid: str):
    svc.get(pid)
    return [RunRecord.model_validate(r) for r in svc.store.log("runs", pid, 100)]


@app.post("/api/verify-file", response_model=RuleCheckReport)
async def verify_file(file: UploadFile = File(...), project_id: str = Query(DEMO_ID)):
    return svc.verify_file(project_id, await _read(file), file.filename or "upload.xlsx")


@app.get("/api/projects/{pid}/exports", response_model=list[ExportFile])
def exports(pid: str):
    return svc.exports(pid)


@app.get("/api/projects/{pid}/export/all.zip")
def export_all(pid: str):
    data, name = svc.export_zip(pid)
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/projects/{pid}/export/{kind}")
def export(pid: str, kind: str):
    data, name, _ = svc.export(pid, kind)
    svc.activity(pid, "export", f"Downloaded {name}")
    return _xlsx(data, name)


@app.post("/api/projects/{pid}/stress", response_model=StressResult)
def stress(pid: str, n: int = Query(10000, ge=100, le=50000), nasty: bool = False):
    from engine.pipeline import run
    from verify.checks import verify_rows
    from xio.synthetic import generate, to_table
    st = svc.get(pid)
    headers, rows = generate(n, seed=7, nasty=nasty)
    t0 = time.perf_counter()
    out = run(b"", st.ruleset, st.settings, table=to_table(headers, rows, f"synthetic_{n}.xlsx"))
    t1 = time.perf_counter()
    rep = verify_rows(out.rows, out.signals, st.ruleset, st.settings, out.tqs)
    t2 = time.perf_counter()
    res = StressResult(n=n, signals=out.kpis.signals, allocate_ms=round((t1 - t0) * 1e3, 1), verify_ms=round((t2 - t1) * 1e3, 1),
                       total_ms=round((t2 - t0) * 1e3, 1), cabinets=out.kpis.cabinets, violations=rep.violations, tqs=len(out.tqs))
    svc.activity(pid, "allocate", f"Stress test: {res.signals:,} signals allocated + verified in {res.total_ms / 1000:.2f} s "
                                  f"({res.cabinets} cabinets, {res.violations} violations)")
    return res


@app.get("/api/health")
def health():
    return {"ok": True}


# ───────────── static frontend (make demo) ─────────────

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        if path.startswith("api/"):
            raise HTTPException(404)
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
