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
    AllocationResult, ColumnMapping, DecisionEntry, ExportFile, ImportSummary, Project, ProjectSettings, RevisionImpact,
    RuleCheckReport, RuleDraft, RuleSet, RunRecord, StressResult, TQ, WhatIfRequest, WhatIfResult, WhyStep,
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
async def import_mdb(pid: str, file: UploadFile = File(...)):
    return svc.import_mdb(pid, await _read(file), file.filename or "upload.xlsx")


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


# ───────────── revisions ─────────────

@app.post("/api/projects/{pid}/revisions", response_model=RevisionImpact)
async def upload_revision(pid: str, file: UploadFile = File(...)):
    from app.revisions import apply_revision
    return apply_revision(svc, pid, await _read(file), file.filename or "RevB.xlsx")


@app.post("/api/projects/{pid}/revisions/gauntlet", response_model=RevisionImpact)
def gauntlet(pid: str):
    from app.revisions import run_gauntlet
    return run_gauntlet(svc, pid)


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
