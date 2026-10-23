"""The UI fixtures and the default rule set must validate against the frozen contract."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.schemas import (
    AllocationResult, Certificate, Kpis, Project, RevisionImpact, RuleCheckReport, RuleSet, RunRecord, TQ,
)
from app.service import DEMO_ID, Service
from store.db import Store

ROOT = Path(__file__).resolve().parents[2]
MOCK = ROOT / "frontend" / "src" / "mock"


def test_fixtures_validate():
    a = AllocationResult.model_validate_json((MOCK / "allocation.json").read_text())
    assert len(a.slots) == 96 * a.kpis.ciocs == 96 * sum(len(c.ciocs) for c in a.cabinets)
    b = AllocationResult.model_validate_json((MOCK / "allocation_revb.json").read_text())
    assert b.revision == "B"
    Project.model_validate_json((MOCK / "project.json").read_text())
    RuleSet.model_validate_json((MOCK / "ruleset.json").read_text())
    RevisionImpact.model_validate_json((MOCK / "revision_impact.json").read_text())
    Kpis.model_validate_json((MOCK / "kpis.json").read_text())
    RuleCheckReport.model_validate_json((MOCK / "report.json").read_text())
    cert = Certificate.model_validate_json((MOCK / "certificate.json").read_text())
    assert cert == a.certificate
    for t in json.loads((MOCK / "tqs.json").read_text()):
        TQ.model_validate(t)
    for r in json.loads((MOCK / "runs.json").read_text()):
        RunRecord.model_validate(r)


def test_fixtures_are_fresh(tmp_path):
    """The fixtures are engine output, not hand-written: a pristine project reproduces the fixture's hashes (`make fixtures` if stale).

    Uses its own store; the shared demo project is mutated by other tests.
    """
    cert = Certificate.model_validate_json((MOCK / "certificate.json").read_text())
    svc = Service(Store(tmp_path / "fresh.db"))
    svc.ensure_demo()
    live = svc.result(svc.get(DEMO_ID)).certificate
    assert (live.mdb_sha256, live.ruleset_hash, live.output_sha256) == (
        cert.mdb_sha256, cert.ruleset_hash, cert.output_sha256), "fixtures are stale: run `make fixtures`"


def test_default_ruleset_validates():
    rs = RuleSet.model_validate_json((ROOT / "rulesets" / "default.json").read_text())
    assert len({r.id for r in rs.rules}) == len(rs.rules)


def test_routes_answer():
    with TestClient(app) as c:
        assert c.get("/api/health").json() == {"ok": True}
        assert c.get("/api/projects/demo/allocation").status_code == 200
        assert c.get("/api/projects/demo/rules").status_code == 200
