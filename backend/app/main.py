"""OptiSlot FastAPI app.

P0: every route of the frozen contract exists and returns realistic fixture data
(frontend/src/mock). Later phases swap the fixture loaders for the real engine/store.
In demo mode (`make demo`) the built frontend in frontend/dist is served at /.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.schemas import (
    AllocationResult, ColumnMapping, ExportFile, ImportSummary, Project, RevisionImpact, RuleCheckReport,
    RuleDraft, RuleSet, RunRecord, Slot, StressResult, TQ, WhatIfRequest, WhatIfResult, WhyStep,
)

ROOT = Path(__file__).resolve().parents[2]
MOCK = ROOT / "frontend" / "src" / "mock"
DIST = ROOT / "frontend" / "dist"

app = FastAPI(title="OptiSlot API", version="0.1.0", description="Allocate. Prove. Revise.")


@lru_cache
def _fixture(name: str):
    return json.loads((MOCK / f"{name}.json").read_text())


def _alloc() -> AllocationResult:
    return AllocationResult.model_validate(_fixture("allocation"))


def _project(pid: str) -> Project:
    p = Project.model_validate(_fixture("project"))
    if pid != p.id:
        raise HTTPException(404, f"project {pid} not found")
    return p


# ───────────── projects ─────────────

@app.get("/api/projects", response_model=list[Project])
def list_projects():
    return [Project.model_validate(_fixture("project"))]


@app.get("/api/projects/{pid}", response_model=Project)
def get_project(pid: str):
    return _project(pid)


@app.post("/api/projects/{pid}/import", response_model=ImportSummary)
async def import_mdb(pid: str, file: UploadFile = File(...)):
    _project(pid)
    return ImportSummary(file=file.filename or "upload.xlsx", sheet="MDB-1", header_row=1, rows=190, live_rows=189,
                         quarantined=0, mapping=[ColumnMapping(field="tag", label="Tag Number", source="Tag Number", confidence=1.0, required=True)],
                         sha256="0" * 64)


@app.post("/api/projects/{pid}/mapping", response_model=ImportSummary)
def set_mapping(pid: str, mapping: list[ColumnMapping]):
    _project(pid)
    return ImportSummary(file="Sample_IO_MDB_VIT_v2_1.xlsx", sheet="MDB-1", header_row=1, rows=190, live_rows=189,
                         quarantined=0, mapping=mapping, sha256="0" * 64)


# ───────────── rules ─────────────

@app.get("/api/projects/{pid}/rules", response_model=RuleSet)
def get_rules(pid: str):
    _project(pid)
    return RuleSet.model_validate(_fixture("ruleset"))


@app.put("/api/projects/{pid}/rules", response_model=AllocationResult)
def put_rules(pid: str, ruleset: RuleSet):
    _project(pid)
    return _alloc()


@app.post("/api/projects/{pid}/rules/draft", response_model=RuleDraft)
def draft_rule(pid: str, body: dict):
    _project(pid)
    return RuleDraft(provider="templates", provider_note="AI offline — using rule templates")


# ───────────── allocation ─────────────

@app.get("/api/projects/{pid}/allocation", response_model=AllocationResult)
def get_allocation(pid: str):
    _project(pid)
    return _alloc()


@app.post("/api/projects/{pid}/allocate", response_model=AllocationResult)
def allocate(pid: str):
    _project(pid)
    return _alloc()


@app.post("/api/projects/{pid}/verify", response_model=RuleCheckReport)
def verify(pid: str):
    _project(pid)
    return _alloc().report


@app.post("/api/projects/{pid}/whatif", response_model=WhatIfResult)
def whatif(pid: str, req: WhatIfRequest):
    a = _alloc()
    return WhatIfResult(allowed=True, kpis=a.kpis, report=a.report, moves=len(req.moves), diff=[])


@app.post("/api/projects/{pid}/commit", response_model=AllocationResult)
def commit(pid: str, req: WhatIfRequest):
    _project(pid)
    return _alloc()


@app.post("/api/projects/{pid}/undo", response_model=AllocationResult)
def undo(pid: str):
    _project(pid)
    return _alloc()


@app.post("/api/projects/{pid}/tqs/{tq_id}/apply", response_model=AllocationResult)
def apply_tq(pid: str, tq_id: str, option: int = 0):
    _project(pid)
    return _alloc()


@app.get("/api/projects/{pid}/tqs", response_model=list[TQ])
def list_tqs(pid: str):
    _project(pid)
    return _alloc().tqs


@app.get("/api/projects/{pid}/slots/{slot_id:path}/why", response_model=list[WhyStep])
def slot_why(pid: str, slot_id: str):
    for s in _alloc().slots:
        if s.id == slot_id:
            return s.why
    raise HTTPException(404, f"slot {slot_id} not found")


@app.get("/api/projects/{pid}/rows", response_model=list[dict[str, str]])
def rows(pid: str):
    """The 76-column allocation rows exactly as they will be written to Excel."""
    _project(pid)
    return []


# ───────────── revisions ─────────────

@app.post("/api/projects/{pid}/revisions", response_model=RevisionImpact)
async def upload_revision(pid: str, file: UploadFile = File(...)):
    _project(pid)
    return RevisionImpact.model_validate(_fixture("revision_impact"))


@app.post("/api/projects/{pid}/revisions/gauntlet", response_model=RevisionImpact)
def gauntlet(pid: str):
    _project(pid)
    return RevisionImpact.model_validate(_fixture("revision_impact"))


@app.get("/api/projects/{pid}/revisions/impact", response_model=RevisionImpact)
def revision_impact(pid: str):
    _project(pid)
    return RevisionImpact.model_validate(_fixture("revision_impact"))


# ───────────── proof / export ─────────────

@app.get("/api/projects/{pid}/runs", response_model=list[RunRecord])
def runs(pid: str):
    _project(pid)
    return [RunRecord.model_validate(r) for r in _fixture("runs")]


@app.post("/api/verify-file", response_model=RuleCheckReport)
async def verify_file(file: UploadFile = File(...)):
    r = _alloc().report.model_copy()
    r.source, r.file = "file", file.filename
    return r


@app.get("/api/projects/{pid}/exports", response_model=list[ExportFile])
def exports(pid: str):
    _project(pid)
    return [
        ExportFile(kind="allocation", filename="IO_Allocation_demo_A.xlsx", rows=1152),
        ExportFile(kind="rule_check", filename="Rule_Check_Report.xlsx", rows=15),
        ExportFile(kind="tq_register", filename="TQ_Register.xlsx", rows=5),
        ExportFile(kind="revision_impact", filename="Revision_Impact.xlsx", rows=4),
        ExportFile(kind="capacity_bom", filename="Capacity_BOM.xlsx", rows=24),
    ]


@app.get("/api/projects/{pid}/export/{kind}")
def export(pid: str, kind: str):
    raise HTTPException(501, "exports arrive in P2")


@app.post("/api/projects/{pid}/stress", response_model=StressResult)
def stress(pid: str, n: int = 10000):
    return StressResult(n=n, signals=n, allocate_ms=0, verify_ms=0, total_ms=0, cabinets=0, violations=0, tqs=0)


@app.get("/api/health")
def health():
    return {"ok": True}


# ───────────── static frontend (make demo) ─────────────

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
