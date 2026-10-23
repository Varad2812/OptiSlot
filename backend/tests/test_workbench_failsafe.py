"""Fail-safe: nothing in the Workbench or Rules Studio can take the app down — bad rules are a clear 422, an evaluation that
cannot run is a refusal, a half-applied change is rolled back, and the same input always gives the same output."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

P = "/api/projects/demo"
ZONE = {"type": "zone_cabinets", "label": "FT only in cabinet 04", "params": {"filter": {"tag": "320-FT*"}, "cabinets": [4]}}


@pytest.fixture()
def c(tmp_path, monkeypatch):
    import app.main as main
    from app.service import Service
    from store.db import Store
    monkeypatch.setattr(main, "svc", Service(Store(tmp_path / "fs.db")))
    with TestClient(main.app) as client:
        yield client


def a_move(c):
    a = c.get(P + "/allocation").json()
    s = next(x for x in a["slots"] if x["cable"] == "320-CS-0022" and x["status"] == "Field" and x["pair"] == 1)
    return {"tag": s["tag"], "target": {"cabinet": "P30-DCM-32001-04", "cioc": "3", "bp": 5, "ch": 1}}


def test_a_check_that_cannot_be_evaluated_is_a_refusal_not_a_500(c, monkeypatch):
    import app.placement as pl
    body = a_move(c)
    with monkeypatch.context() as m:
        m.setattr(pl, "_step", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("engine exploded")))
        r = c.post(P + "/placement/check", json=body)
        assert r.status_code == 200
        j = r.json()
        assert j["verdict"] == "refused" and j["reasons"][0]["kind"] == "error" and "could not evaluate" in j["reasons"][0]["text"]
        assert "engine exploded" in j["reasons"][0]["text"]
        r = c.post(P + "/placement/apply", json=body)
        assert r.status_code == 200 and r.json()["applied"] is False and r.json()["state"]["depth"] == 0
    assert c.post(P + "/placement/check", json=body).json()["verdict"] == "allowed"


def test_an_error_while_searching_for_alternatives_is_still_a_refusal(c, monkeypatch):
    import app.placement as pl
    body = a_move(c)
    body["target"] = {"cabinet": "P30-DCM-32001-01", "cioc": "4", "bp": 8, "ch": 1}      # reserved
    with monkeypatch.context() as m:
        m.setattr(pl, "_alternatives", lambda *a, **k: (_ for _ in ()).throw(KeyError("no alternatives today")))
        r = c.post(P + "/placement/check", json=body)
    assert r.status_code == 200 and r.json()["verdict"] == "refused", r.text
    assert r.json()["reasons"][0]["kind"] in ("error", "reserved")


def test_commit_that_would_disagree_with_the_verifier_is_rolled_back(c, monkeypatch):
    body = a_move(c)
    assert c.post(P + "/placement/apply", json=body).json()["applied"]
    import app.main as main
    real = main.svc.recompute_active
    calls = []

    def worse(st):
        comp = real(st)
        if not calls:
            calls.append(1)
            comp.report = comp.report.model_copy(update={"violations": comp.report.violations + 1})
        return comp
    with monkeypatch.context() as m:
        m.setattr(main.svc, "recompute_active", worse)
        r = c.post(P + "/placement/commit", json={"reason": "x"})
    assert r.status_code == 422 and "commit refused" in r.json()["detail"]
    assert main.svc.store.get("demo", "sandbox_moves", {}) == {}, "nothing half-committed"
    assert c.get(P + "/placement").json()["depth"] == 1, "the sandbox is kept so the engineer can adjust it"
    assert c.get(P + "/allocation").json()["report"]["violations"] == 0
    assert c.post(P + "/placement/commit", json={}).status_code == 200


def test_junk_project_is_survivable(c):
    import app.main as main
    main.svc.create_project("junk", "Junk", b"this is not a workbook", "junk.xlsx")
    assert c.get("/api/projects/junk/allocation").status_code == 200
    j = c.get("/api/projects/junk/signals").json()
    assert j["rows"] == [] and j["counts"]["total"] == 0
    assert c.post("/api/projects/junk/placement/check", json={"tag": "X", "target": {"slot_id": "a"}}).status_code == 404
    assert c.get("/api/projects/junk/placement").json()["depth"] == 0
    assert c.get("/api/projects/junk/rules/listing").status_code == 200
    r = c.post("/api/projects/junk/rules/preview", json={"action": "add", "rule": ZONE})
    assert r.status_code == 200
    r = c.post("/api/projects/junk/signals/X/patch", json={"fields": {"pair": "1"}})
    assert r.status_code == 422 and "map one on the Import page" in r.json()["detail"]


def test_a_malformed_rule_that_got_into_the_database_cannot_break_the_project(c):
    """Defence in depth: validation happens on write, but even a rule edited straight in the database is handled."""
    import app.main as main
    from app.service import Service
    st = main.svc.get("demo")
    rs = st.ruleset.model_dump()
    rs["rules"].append({"id": "c-bad", "type": "max_per_scope", "enabled": True, "severity": "hard", "label": "bad",
                        "params": {"filter": {"colour": "red"}, "scope": "cioc", "max": 3}})
    main.svc.store.put_ruleset("demo", st.ruleset.version + 1, rs, "now", "tampered")
    main.svc = Service(main.svc.store)
    a = c.get(P + "/allocation").json()
    assert a["kpis"]["allocated"] > 0, "the allocation still runs"
    assert any(t["category"] == "SYS-custom" and "c-bad" in t["message"] for t in a["tqs"])
    bad = next(ch for ch in a["report"]["checks"] if ch["rule_id"] == "c-bad")
    assert bad["failed"] == 1 and a["report"]["verdict"] == "FAIL", "a rule that cannot be checked is a failure, never a silent pass"
    assert c.post(P + "/rules", json=ZONE).status_code == 422, "adding more rules is blocked until the bad one is fixed"
    r = c.delete(P + "/rules/c-bad")
    assert r.status_code == 200 and r.json()["stored"]
    assert c.get(P + "/allocation").json()["report"]["verdict"] == "PASS"


def test_same_input_same_output(c):
    body = a_move(c)
    j1, j2 = c.post(P + "/placement/check", json=body).json(), c.post(P + "/placement/check", json=body).json()
    assert j1 == j2
    p1 = c.post(P + "/rules/preview", json={"action": "add", "rule": ZONE}).json()
    p2 = c.post(P + "/rules/preview", json={"action": "add", "rule": ZONE}).json()
    assert p1 == p2
    s1, s2 = c.get(P + "/signals", params={"limit": 500}).json(), c.get(P + "/signals", params={"limit": 500}).json()
    assert s1 == s2
    # a stored custom rule gives the same certificate hash on a second, independent service instance
    assert c.post(P + "/rules", json=ZONE).json()["stored"]
    cert = c.get(P + "/allocation").json()["certificate"]
    import app.main as main
    from app.service import Service
    main.svc = Service(main.svc.store)
    cert2 = c.get(P + "/allocation").json()["certificate"]
    assert (cert["run_id"], cert["ruleset_hash"], cert["output_sha256"], cert["mdb_sha256"]) == \
           (cert2["run_id"], cert2["ruleset_hash"], cert2["output_sha256"], cert2["mdb_sha256"])


def test_the_workbench_works_on_revision_b(c):
    assert c.post(P + "/revisions/gauntlet").status_code == 200
    a = c.get(P + "/allocation").json()
    assert a["revision"] == "B"
    sl = c.get(P + "/signals", params={"limit": 1000}).json()
    assert sl["counts"]["total"] >= 190 and {"allocated", "warning", "quarantined"} & {k for k, v in sl["counts"]["by_state"].items() if v}
    s = next(x for x in a["slots"] if x["cable"] == "320-CS-0022" and x["status"] == "Field" and x["pair"] == 1)
    body = {"tag": s["tag"], "target": {"cabinet": "P30-DCM-32001-04", "cioc": "3", "bp": 5, "ch": 1}}
    r = c.post(P + "/placement/apply", json=body).json()
    assert r["applied"] and r["report"]["violations"] == 0
    assert c.post(P + "/placement/commit", json={"reason": "rev B tweak"}).status_code == 200
    b = c.get(P + "/allocation").json()
    assert b["revision"] == "B" and b["report"]["violations"] == 0
    assert next(x["id"] for x in b["slots"] if x["tag"] == s["tag"]) == "P30-DCM-32001-04/015/5/1"
