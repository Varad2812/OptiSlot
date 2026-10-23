"""What-if `settings`: preview strategy / spare-% changes on a copy — the stored rule set and decision log are untouched."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.schemas import AllocationResult, WhatIfResult


@pytest.fixture()
def c(tmp_path, monkeypatch):
    import app.main as main
    from app.service import Service
    from store.db import Store
    monkeypatch.setattr(main, "svc", Service(Store(tmp_path / "ws.db")))
    with TestClient(main.app) as client:
        yield client


def state(c):
    a = AllocationResult.model_validate(c.get("/api/projects/demo/allocation").json())
    return {"sha": a.certificate.output_sha256, "version": c.get("/api/projects/demo/rules").json()["version"],
            "decisions": len(c.get("/api/projects/demo/decisions").json()), "runs": len(c.get("/api/projects/demo/runs").json()),
            "settings": c.get("/api/projects/demo/settings").json(), "alloc": a}


def whatif(c, body) -> WhatIfResult:
    r = c.post("/api/projects/demo/whatif", json=body)
    assert r.status_code == 200, r.text
    return WhatIfResult.model_validate(r.json())


def test_spare_pct_preview_reports_status_changes_and_stores_nothing(c):
    before = state(c)
    r = whatif(c, {"settings": {"wired_spare_pct": 25}})
    assert r.allowed and r.report.verdict == "PASS" and r.applied_settings == {"wired_spare_pct": 25}
    flips = [d for d in r.diff if d.change == "status"]
    assert flips and all(d.reason.startswith("Spare Slot → Wired Spare") for d in flips)
    assert r.kpis.wired_spares == before["alloc"].kpis.wired_spares + len(flips) and r.moves == 0
    assert {s.id for s in r.slots} >= {d.to_slot for d in flips}
    after = state(c)
    assert {k: v for k, v in after.items() if k != "alloc"} == {k: v for k, v in before.items() if k != "alloc"}


def test_lower_spare_pct_turns_wired_spares_back_into_spare_slots(c):
    r = whatif(c, {"settings": {"wired_spare_pct": 0}})
    flips = [d for d in r.diff if d.change == "status"]
    assert flips and all(d.reason.startswith("Wired Spare → Spare Slot") for d in flips) and r.kpis.wired_spares == 0


def test_strategy_preview_leaves_the_stored_strategy_alone(c):
    cur = c.get("/api/projects/demo/rules").json()["settings"]["cioc_strategy"]
    other = "compact" if cur == "balanced" else "balanced"
    before = state(c)
    r = whatif(c, {"settings": {"cioc_strategy": other}})
    assert r.allowed and r.report.verdict == "PASS" and r.diff
    assert c.get("/api/projects/demo/rules").json()["settings"]["cioc_strategy"] == cur
    assert state(c)["decisions"] == before["decisions"] and state(c)["sha"] == before["sha"]


def test_project_settings_can_be_previewed(c):
    r = whatif(c, {"settings": {"cpsat_enabled": False}})
    assert r.allowed and c.get("/api/projects/demo/settings").json()["cpsat_enabled"] is True


@pytest.mark.parametrize("settings", [{"nonsense": 1}, {"cioc_strategy": "wide"}, {"wired_spare_pct": 140},
                                      {"wired_spare_pct": "lots"}, {"ciocs_per_cabinet": 0}])
def test_bad_settings_are_rejected_cleanly(c, settings):
    r = c.post("/api/projects/demo/whatif", json={"settings": settings})
    assert r.status_code == 422 and r.json()["detail"]


def test_old_requests_still_work(c):
    r = whatif(c, {})
    assert r.allowed and r.diff == [] and r.applied_settings == {}
    r = whatif(c, {"params": {"r-wired": {"pct": 12}}}) if any(x["id"] == "r-wired" for x in c.get("/api/projects/demo/rules").json()["rules"]) else r
    assert r.allowed


def test_commit_persists_rule_level_settings_with_a_decision_entry(c):
    before = state(c)
    r = c.post("/api/projects/demo/commit", json={"settings": {"wired_spare_pct": 15}})
    assert r.status_code == 200, r.text
    after = state(c)
    assert after["version"] == before["version"] + 1 and after["decisions"] == before["decisions"] + 1
    assert after["alloc"].kpis.wired_spares > before["alloc"].kpis.wired_spares
    u = c.post("/api/projects/demo/undo")
    assert u.status_code == 200 and state(c)["alloc"].kpis.wired_spares == before["alloc"].kpis.wired_spares


def test_commit_refuses_preview_only_settings(c):
    before = state(c)
    r = c.post("/api/projects/demo/commit", json={"settings": {"cpsat_enabled": False}})
    assert r.status_code == 422 and "PUT /settings" in r.json()["detail"]
    assert state(c)["version"] == before["version"]
