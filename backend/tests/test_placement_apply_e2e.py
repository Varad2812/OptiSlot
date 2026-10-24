"""End to end through HTTP: a move applied with POST /placement/apply is accepted, lands where asked, verifies, and a refusal
reports a rule (not an internal error). Guards the helpers app.placement shares with app.sandbox (signature drift = every move refused)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.schemas import AllocationResult, PlacementApplyResult, PlacementChangeSet

P = "/api/projects/demo"
CABLE, TARGET = "320-CS-0022", {"cabinet": "P30-DCM-32001-04", "cioc": "3", "bp": 5, "ch": 1}


@pytest.fixture()
def c(tmp_path, monkeypatch):
    import app.main as main
    from app.service import Service
    from store.db import Store
    monkeypatch.setattr(main, "svc", Service(Store(tmp_path / "e2e.db")))
    with TestClient(main.app) as client:
        yield client


def _tag(c) -> str:
    a = AllocationResult.model_validate(c.get(P + "/allocation").json())
    return next(s.tag for s in a.slots if s.cable == CABLE and s.status == "Field" and s.pair == 1)


def _apply(c, tag: str, target: dict) -> PlacementApplyResult:
    r = c.post(P + "/placement/apply", json={"tag": tag, "target": target, "reason": "e2e"})
    assert r.status_code == 200, r.text
    return PlacementApplyResult.model_validate(r.json())


def _assert_landed(c, res: PlacementApplyResult, tag: str) -> None:
    assert res.applied, [x.text for x in res.check.reasons]
    assert not any("could not evaluate" in x.text for x in res.check.reasons)
    assert res.check.to_slot == "P30-DCM-32001-04/015/5/1"
    assert res.report and res.report.violations == 0 and res.state.depth == 1
    ch = PlacementChangeSet.model_validate(c.get(P + "/placement/changes").json())      # the draft: listed, not yet committed
    assert any(m.tag == tag and m.to_slot == "P30-DCM-32001-04/015/5/1" for m in ch.moves) and ch.verdict_now == "PASS"
    assert c.post(P + "/placement/commit", json={"reason": "e2e", "who": "test"}).status_code == 200
    now = AllocationResult.model_validate(c.get(P + "/allocation").json())              # committed: now in the allocation
    slot = next(s for s in now.slots if s.tag == tag and s.status == "Field")
    assert slot.id == "P30-DCM-32001-04/015/5/1"
    assert now.report.verdict == "PASS" and now.report.violations == 0


def test_apply_a_move_end_to_end_on_rev_a(c):
    tag = _tag(c)
    _assert_landed(c, _apply(c, tag, TARGET), tag)


def test_apply_a_move_end_to_end_on_rev_b(c):
    assert c.post(P + "/revisions/gauntlet").status_code == 200
    tag = _tag(c)
    _assert_landed(c, _apply(c, tag, TARGET), tag)


def test_apply_a_move_end_to_end_on_rev_c(c):
    assert c.post(P + "/revisions/gauntlet").status_code == 200
    assert c.post(P + "/revisions/gauntlet?rev=C").status_code == 200
    tag = _tag(c)
    _assert_landed(c, _apply(c, tag, TARGET), tag)


def test_a_refused_move_names_a_rule_not_an_internal_error(c):
    a = AllocationResult.model_validate(c.get(P + "/allocation").json())
    b_tag = next(s.tag for s in a.slots if s.status == "Field" and s.family == "B")
    res = _apply(c, b_tag, {"cabinet": "P30-DCM-32001-01", "cioc": "1", "bp": 4, "ch": 1})
    assert not res.applied
    text = " ".join(x.text for x in res.check.reasons)
    assert "could not evaluate" not in text and "TypeError" not in text
