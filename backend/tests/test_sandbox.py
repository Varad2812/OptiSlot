"""What-if, commit / undo / redo, TQ apply / close, English → rule drafting, rules added as data."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.schemas import AllocationResult, RuleDraft, RuleSet, WhatIfResult


@pytest.fixture()
def c(tmp_path, monkeypatch):
    import app.main as main
    from app.service import Service
    from store.db import Store
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:9")  # nothing listens here → templates
    monkeypatch.setattr(main, "svc", Service(Store(tmp_path / "sb.db")))
    with TestClient(main.app) as client:
        yield client


def alloc(c) -> AllocationResult:
    return AllocationResult.model_validate(c.get("/api/projects/demo/allocation").json())


def cioc_of(a: AllocationResult, cable: str) -> str:
    return next(s.cioc for s in a.slots if s.cable == cable)


def test_b_cable_into_a_cioc_is_blocked_with_the_rule(c):
    a = alloc(c)
    b_cable = next(s.block_id for s in a.slots if s.status == "Field" and s.family == "B")
    a_cioc = next(s.cioc for s in a.slots if s.status == "Field" and s.family == "A")
    r = WhatIfResult.model_validate(c.post("/api/projects/demo/whatif", json={
        "moves": [{"block_id": b_cable, "target_cioc": a_cioc, "target_bp": 8, "target_ch": 1}]}).json())
    assert not r.allowed and "rule r-ab" in r.blocked_reason


def test_single_pair_of_a_cable_must_move_as_a_block(c):
    a = alloc(c)
    s = next(s for s in a.slots if s.status == "Field" and s.cable_size == 24)
    r = WhatIfResult.model_validate(c.post("/api/projects/demo/whatif", json={
        "moves": [{"slot_id": s.id, "target_cioc": s.cioc, "target_bp": 8, "target_ch": 1}]}).json())
    assert not r.allowed and "whole block" in r.blocked_reason


def test_reserved_baseplate_is_blocked(c):
    a = alloc(c)
    s = next(s for s in a.slots if s.reserved == "future")
    cable = next(x.block_id for x in a.slots if x.status == "Field" and x.family == "-" and x.cable_size == 6)
    r = WhatIfResult.model_validate(c.post("/api/projects/demo/whatif", json={
        "moves": [{"block_id": cable, "target_cioc": s.cioc, "target_bp": s.bp, "target_ch": 1}]}).json())
    assert not r.allowed and "r-future" in r.blocked_reason


def _free_target(a: AllocationResult, cable: str):
    """An empty, unreserved baseplate in a neutral or empty CIOC of the same cabinet."""
    home = next(s for s in a.slots if s.cable == cable)
    used = {(s.cioc, s.bp) for s in a.slots if s.cable not in ("-", "") or s.status != "Spare Slot" or s.reserved}
    fam = {s.cioc for s in a.slots if s.status == "Field" and s.family in ("A", "B")}
    for s in a.slots:
        if s.cabinet == home.cabinet and s.cioc not in fam and (s.cioc, s.bp) not in used and s.cioc != home.cioc:
            return s.cioc, s.bp
    raise AssertionError("no free target")


def test_valid_move_preview_commit_undo_redo(c):
    a = alloc(c)
    cable = next(s.block_id for s in a.slots if s.status == "Field" and s.family == "-" and s.cable_size == 6)
    cioc, bp = _free_target(a, cable)
    body = {"moves": [{"block_id": cable, "target_cioc": cioc, "target_bp": bp, "target_ch": 1}]}
    r = WhatIfResult.model_validate(c.post("/api/projects/demo/whatif", json=body).json())
    n = sum(1 for s in a.slots if s.cable == cable and s.status == "Field")
    assert r.allowed and r.moves == n and r.report.verdict == "PASS"
    assert cioc_of(alloc(c), cable) != cioc  # preview did not commit
    after = AllocationResult.model_validate(c.post("/api/projects/demo/commit", json=body).json())
    assert cioc_of(after, cable) == cioc and after.report.verdict == "PASS"
    moved = [s for s in after.slots if s.cable == cable and s.status == "Field"]
    assert all(s.change_type == "Moved" and "What-if Sandbox" in s.remarks for s in moved)
    others_before = {s.tag_key: s.id for s in a.slots if s.status == "Field" and s.cable != cable}
    assert all(s.id == others_before[s.tag_key] for s in after.slots if s.status == "Field" and s.cable != cable)
    undone = AllocationResult.model_validate(c.post("/api/projects/demo/undo").json())
    assert cioc_of(undone, cable) == cioc_of(a, cable)
    redone = AllocationResult.model_validate(c.post("/api/projects/demo/redo").json())
    assert cioc_of(redone, cable) == cioc


def test_spare_slider_preview_does_not_commit(c):
    before = alloc(c)
    r = WhatIfResult.model_validate(c.post("/api/projects/demo/whatif", json={"params": {"r-wired-spare": {"pct": 15}}}).json())
    assert r.kpis.wired_spares > before.kpis.wired_spares and r.report.verdict == "PASS" and r.moves == 0
    assert alloc(c).kpis.wired_spares == before.kpis.wired_spares


def test_apply_uzv_tq_swaps_hardware_only(c):
    c.post("/api/projects/demo/revisions/gauntlet")
    a = alloc(c)
    tq = next(t for t in a.tqs if t.category == "Unknown DO type" and t.status == "open")
    tag = tq.tags[0].replace(" ", "")
    slot = next(s for s in a.slots if s.tag_key == tag)
    assert slot.charm == "SE4302T01"
    b = AllocationResult.model_validate(c.post(f"/api/projects/demo/tqs/{tq.id}/apply?option=0").json())
    slot2 = next(s for s in b.slots if s.tag_key == tag)
    assert slot2.id == slot.id and (slot2.charm, slot2.tb) == ("SE4302T02", "SE4502")
    assert b.report.verdict == "PASS" and b.report.violations == 0
    applied = next(t for t in b.tqs if t.id == tq.id)
    assert applied.status == "applied"
    log = c.get("/api/projects/demo/decisions").json()
    assert log[0]["tq_id"] == tq.id and log[0]["patch"]["value"] == "UZV"
    before = {s.tag_key: s.id for s in a.slots if s.status == "Field"}
    assert all(s.id == before[s.tag_key] for s in b.slots if s.status == "Field" and s.tag_key in before)


def test_close_tq(c):
    a = alloc(c)
    tq = next(t for t in a.tqs if t.status == "open")
    b = AllocationResult.model_validate(c.post(f"/api/projects/demo/tqs/{tq.id}/close?decision=Keep standard DO").json())
    t = next(t for t in b.tqs if t.id == tq.id)
    assert t.status == "closed" and t.decision == "Keep standard DO"
    assert b.kpis.tqs_open == a.kpis.tqs_open - 1


def test_english_rule_added_as_data_changes_the_allocation(c):
    d = RuleDraft.model_validate(c.post("/api/projects/demo/rules/draft",
                                        json={"text": "Never put A and B-ALARM in the same cabinet"}).json())
    assert d.provider == "templates" and "offline" in d.provider_note.lower() and d.rule is not None
    rs = RuleSet.model_validate(c.get("/api/projects/demo/rules").json())
    before = alloc(c)
    rs.rules.append(d.rule)
    after = AllocationResult.model_validate(c.put("/api/projects/demo/rules?why=added from English", json=rs.model_dump()).json())
    assert after.report.verdict == "PASS"
    assert any(ch.rule_id == d.rule.id for ch in after.report.checks)
    b_alarm = {s.cabinet for s in after.slots if s.group == "B-ALARM" and s.status == "Field"}
    a_cabs = {s.cabinet for s in after.slots if s.family == "A" and s.status == "Field"}
    assert not (b_alarm & a_cabs)
    assert {s.cabinet for s in before.slots if s.group == "B-ALARM" and s.status == "Field"} & \
        {s.cabinet for s in before.slots if s.family == "A" and s.status == "Field"}
