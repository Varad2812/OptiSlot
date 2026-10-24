"""A database written by an older build heals itself: the stored rule set gets the default fields it lacks (one new
version + a decision-log entry), the user's edits and custom rules survive, the MDB and the history are untouched,
and a current database is left alone."""
from __future__ import annotations

import hashlib
from pathlib import Path

from app.migrate import current_stamp, merge_defaults
from app.schemas import ENGINE_VERSION, RuleSet
from app.service import Service
from engine.rules import load_ruleset
from store.db import Store

FIXTURE = Path(__file__).parent / "fixtures" / "OptiSlot_Adversarial_MDB.xlsx"
CUSTOM = {"id": "c-mine", "type": "max_per_scope", "enabled": True, "severity": "hard", "label": "At most 96 AI per CIOC",
          "params": {"filter": {"io_type": "AIR"}, "scope": "cioc", "max": 96}}
LABEL = "10% wired spares (my wording)"
NEW_R_OUT_PARAMS = ("soft_columns", "dash_columns", "spare_inherit", "slot_inherit")   # added to r-out by 32a3166


def old_format_ruleset() -> dict:
    """What an older build stored: r-out without the newer parameters, plus the user's edit and a custom rule."""
    d = load_ruleset("default").model_dump(mode="json")
    for r in d["rules"]:
        if r["id"] == "r-out":
            r["severity"], r["label"] = "soft", "Copy engineering columns from the MDB into the allocation"
            for k in NEW_R_OUT_PARAMS:
                r["params"].pop(k)
        if r["id"] == "r-wired-spare":
            r["label"] = LABEL
    d["rules"].append(CUSTOM)
    return d


def make_old_db(path: Path) -> str:
    """A project created by an older build: legacy ruleset, no engine stamp, a cached run from the old engine."""
    svc = Service(Store(path))
    mdb = FIXTURE.read_bytes()
    svc.create_project("old", "Old project", mdb, FIXTURE.name)
    svc.store.put_ruleset("old", 1, old_format_ruleset(), "2026-01-01T00:00:00Z", "default rule set")
    svc.store.conn.execute("DELETE FROM kv WHERE project_id='old' AND key='engine_stamp'")
    svc.store.append("decisions", "old", "2026-01-02T00:00:00Z",
                     {"ts": "2026-01-02T00:00:00Z", "who": "engineer", "why": "kept by hand", "ruleset_version": 1})
    svc.store.append("runs", "old", "2026-01-02T00:00:00Z",
                     {"run_id": "run-old", "project_id": "old", "timestamp": "2026-01-02T00:00:00Z", "revision": "A",
                      "kind": "allocate", "mdb_sha256": "0" * 64, "ruleset_hash": "9d65bc8f" + "0" * 56, "output_sha256": "0" * 64,
                      "verdict": "FAIL", "violations": 1374, "signals": 189, "runtime_ms": 1.0})
    return hashlib.sha256(mdb).hexdigest()


def test_merge_adds_only_what_is_missing_and_keeps_edits():
    stored = old_format_ruleset()
    merged, added = merge_defaults(stored)
    r_out = next(r for r in merged["rules"] if r["id"] == "r-out")
    assert all(k in r_out["params"] for k in NEW_R_OUT_PARAMS)
    assert [a for a in added] == [f"r-out.params.{k}" for k in NEW_R_OUT_PARAMS]
    assert r_out["severity"] == "soft"                                       # an existing value is never overwritten
    assert next(r for r in merged["rules"] if r["id"] == "r-wired-spare")["label"] == LABEL
    assert CUSTOM in merged["rules"]
    assert merge_defaults(merged)[1] == []                                    # idempotent
    assert merge_defaults(stored, deleted_ids={"r-out"})[1] == added          # a deleted rule is not an addition either way
    gone = {**stored, "rules": [r for r in stored["rules"] if r["id"] != "r-alarm-bp"]}
    assert "r-alarm-bp (new rule)" in merge_defaults(gone)[1]
    assert "r-alarm-bp (new rule)" not in merge_defaults(gone, deleted_ids={"r-alarm-bp"})[1]


def test_old_database_is_migrated_on_load_and_verifies(tmp_path, monkeypatch):
    db = tmp_path / "old.db"
    mdb_sha = make_old_db(db)

    # the old rule set judged by the current code, with no healing (what the user saw): not clean
    monkeypatch.setattr(Service, "heal", lambda self, pid: None)
    stale = Service(Store(db)).result(Service(Store(db)).get("old")).report
    monkeypatch.undo()
    assert stale.violations > 0

    svc = Service(Store(db))                                                  # a new process opening the old file
    st = svc.get("old")
    versions = svc.store.ruleset_versions("old")
    assert [v["version"] for v in versions] == [1, 2] and versions[1]["note"] == f"auto-migrated to engine {ENGINE_VERSION}"
    rs = svc.store.get_ruleset("old")
    assert rs["version"] == 2 and st.ruleset.version == 2 and st.project.ruleset_version == 2
    r_out = next(r for r in rs["rules"] if r["id"] == "r-out")
    assert all(k in r_out["params"] for k in NEW_R_OUT_PARAMS)
    assert CUSTOM in rs["rules"] and next(r for r in rs["rules"] if r["id"] == "r-wired-spare")["label"] == LABEL

    res = svc.result(st)
    assert res.report.violations == 0 and res.report.verdict == "PASS"
    assert res.kpis.violations == 0 and res.certificate.engine_version == ENGINE_VERSION
    assert any(c.rule_id == "c-mine" for c in res.report.checks)             # the custom rule is still checked

    log = svc.store.log("decisions", "old")
    mig = log[0]
    assert mig["who"] == "system" and mig["why"].startswith(f"auto-migrated to engine {ENGINE_VERSION}") and mig["ruleset_version"] == 2
    assert [d["why"] for d in log if d["why"] == "kept by hand"] == ["kept by hand"]          # history intact
    assert any(a["text"].startswith("Auto-migrated to engine") for a in (e.model_dump() for e in res.activity))
    assert hashlib.sha256(svc.store.get_file("old", "mdb_a")).hexdigest() == mdb_sha          # the upload is untouched
    assert any(r["run_id"] == "run-old" for r in svc.store.log("runs", "old"))                # the old run stays in history
    assert svc.store.get("old", "engine_stamp") == current_stamp()

    again = Service(Store(db))                                                # the next start finds nothing to do
    again.get("old")
    assert [v["version"] for v in again.store.ruleset_versions("old")] == [1, 2]
    assert len(again.store.log("decisions", "old")) == len(log)


def test_current_database_is_untouched(tmp_path):
    db = tmp_path / "new.db"
    svc = Service(Store(db))
    svc.create_project("p", "Current", FIXTURE.read_bytes(), FIXTURE.name)
    before = (svc.store.log("decisions", "p"), svc.store.log("activity", "p"))
    for _ in range(3):
        again = Service(Store(db))
        st = again.get("p")
        assert again.heal("p") is None
        assert st.ruleset.version == 1
    assert [v["version"] for v in svc.store.ruleset_versions("p")] == [1]
    assert (svc.store.log("decisions", "p"), svc.store.log("activity", "p")) == before
    assert RuleSet.model_validate(svc.store.get_ruleset("p")) == load_ruleset("default")


def test_loaded_state_drops_its_cached_run_when_the_stamp_changes(tmp_path, monkeypatch):
    db = tmp_path / "live.db"
    svc = Service(Store(db))
    svc.create_project("p", "Live", FIXTURE.read_bytes(), FIXTURE.name)
    st = svc.get("p")
    first = st.current
    assert first is not None
    monkeypatch.setattr("app.service.current_stamp", lambda: {"engine_version": ENGINE_VERSION, "rules_baseline": "changed"})
    svc.get("p")                                                              # heal() sees the new stamp and recomputes
    assert svc.store.get("p", "engine_stamp")["rules_baseline"] == "changed"
    assert [v["version"] for v in svc.store.ruleset_versions("p")] == [1]     # nothing was missing: no new version
    assert st.current is not None and st.current is not first                 # the old cached run was dropped and recomputed
