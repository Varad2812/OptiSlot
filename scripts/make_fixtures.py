"""Generate the UI fixtures (frontend/src/mock/*.json) from the REAL engine, verifier and API.

Drives the FastAPI app in-process (TestClient) against a throw-away SQLite DB, so projects/optislot.db is never
touched. Every value in the output was computed by the engine on data/Sample_IO_MDB_VIT_v2_1.xlsx: nothing is invented.
Usage: `make fixtures`  (= uv run --project backend python scripts/make_fixtures.py)
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "frontend" / "src" / "mock"
sys.path.insert(0, str(ROOT / "backend"))

_tmp = tempfile.mkdtemp(prefix="optislot-fixtures-")
os.environ["OPTISLOT_DB"] = str(Path(_tmp) / "fixtures.db")  # must be set before app.main is imported

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.schemas import (  # noqa: E402
    AllocationResult, Certificate, Kpis, Project, RevisionImpact, RuleCheckReport, RuleSet, RunRecord, TQ,
)

PID = "demo"
MOCK_FILES = ("allocation", "allocation_revb", "kpis", "tqs", "report", "certificate", "revision_impact", "runs",
              "project", "ruleset", "decisions", "exports")


def main() -> None:
    with TestClient(app) as c:
        def get(path: str):
            r = c.get(f"/api/projects/{PID}{path}")
            r.raise_for_status()
            return r.json()

        def post(path: str):
            r = c.post(f"/api/projects/{PID}{path}")
            r.raise_for_status()
            return r.json()

        # Rev A: allocate on the sample MDB, then read everything back through the API.
        alloc_a = AllocationResult.model_validate(post("/allocate"))
        report = RuleCheckReport.model_validate(post("/verify"))
        tqs = [TQ.model_validate(t) for t in get("/tqs")]
        project = Project.model_validate(get(""))
        ruleset = RuleSet.model_validate(get("/rules"))
        exports = get("/exports")

        # Rev B: the deterministic Revision Gauntlet.
        impact = RevisionImpact.model_validate(post("/revisions/gauntlet"))
        alloc_b = AllocationResult.model_validate(get("/allocation"))
        runs = [RunRecord.model_validate(r) for r in get("/runs")]
        decisions = get("/decisions")
        cert: Certificate = alloc_a.certificate
        kpis: Kpis = alloc_a.kpis

    MOCK.mkdir(parents=True, exist_ok=True)
    out = {
        "allocation": alloc_a, "allocation_revb": alloc_b, "kpis": kpis, "tqs": tqs, "report": report,
        "certificate": cert, "revision_impact": impact, "project": project, "ruleset": ruleset,
    }
    for name, obj in out.items():
        (MOCK / f"{name}.json").write_text(obj.model_dump_json(indent=1) if not isinstance(obj, list)
                                           else json.dumps([o.model_dump(mode="json") for o in obj], indent=1))
    (MOCK / "runs.json").write_text(json.dumps([r.model_dump(mode="json") for r in runs], indent=1))
    (MOCK / "decisions.json").write_text(json.dumps(decisions, indent=1))
    (MOCK / "exports.json").write_text(json.dumps(exports, indent=1))
    assert set(MOCK_FILES) == {p.stem for p in MOCK.glob("*.json")}, "stale fixture files in frontend/src/mock"

    k = alloc_a.kpis
    print(f"fixtures → {MOCK}")
    print(f"  Rev A: {len(alloc_a.slots)} slots · {k.signals} signals · {k.cabinets} cabinets · {k.ciocs} CIOCs · "
          f"{len(tqs)} TQs · {report.checks_passed}/{report.checks_total} checks · {report.violations} violations")
    print(f"  Rev B: +{len(impact.added)} −{len(impact.deleted)} ~{len(impact.modified)} moved {len(impact.moved)} · "
          f"stability {impact.stability_pct}% · {alloc_b.report.violations} violations · {len(alloc_b.tqs)} TQs")
    print(f"  cert {cert.output_sha256[:12]}… · {len(runs)} runs")


if __name__ == "__main__":
    main()
