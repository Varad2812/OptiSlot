"""The UI fixtures and the default rule set must validate against the frozen contract."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.schemas import AllocationResult, Project, RevisionImpact, RuleSet, RunRecord

ROOT = Path(__file__).resolve().parents[2]
MOCK = ROOT / "frontend" / "src" / "mock"


def test_fixtures_validate():
    a = AllocationResult.model_validate_json((MOCK / "allocation.json").read_text())
    assert len(a.slots) == 384 * len(a.cabinets)
    Project.model_validate_json((MOCK / "project.json").read_text())
    RuleSet.model_validate_json((MOCK / "ruleset.json").read_text())
    RevisionImpact.model_validate_json((MOCK / "revision_impact.json").read_text())
    for r in json.loads((MOCK / "runs.json").read_text()):
        RunRecord.model_validate(r)


def test_default_ruleset_validates():
    rs = RuleSet.model_validate_json((ROOT / "rulesets" / "default.json").read_text())
    assert len({r.id for r in rs.rules}) == len(rs.rules)


def test_stub_routes_answer():
    c = TestClient(app)
    assert c.get("/api/health").json() == {"ok": True}
    assert c.get("/api/projects/demo/allocation").status_code == 200
    assert c.get("/api/projects/demo/rules").status_code == 200
