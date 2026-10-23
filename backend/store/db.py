"""SQLite (WAL, stdlib sqlite3) persistence: projects, input files, rule-set versions, runs, TQ decisions,
decision log, activity and revisions. Outputs are never stored as truth — they are recomputed from the
stored inputs (same inputs → same hashes), so a restart reloads the exact same state."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "projects" / "optislot.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (project_id TEXT, name TEXT, kind TEXT, sha256 TEXT, data BLOB, ts TEXT,
                                  PRIMARY KEY (project_id, name));
CREATE TABLE IF NOT EXISTS rulesets (project_id TEXT, version INTEGER, data TEXT, ts TEXT, note TEXT,
                                     PRIMARY KEY (project_id, version));
CREATE TABLE IF NOT EXISTS runs (run_id TEXT, project_id TEXT, ts TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS runs_p ON runs(project_id, ts);
CREATE TABLE IF NOT EXISTS decisions (project_id TEXT, ts TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS activity (project_id TEXT, ts TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS tq_history (project_id TEXT, tq_id TEXT, ts TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS kv (project_id TEXT, key TEXT, data TEXT, PRIMARY KEY (project_id, key));
"""


class Store:
    def __init__(self, path: Path | str = DEFAULT_DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)

    def _x(self, sql: str, args: tuple = ()) -> list[tuple]:
        with self._lock:
            return self.conn.execute(sql, args).fetchall()

    # projects
    def put_project(self, pid: str, data: dict) -> None:
        self._x("INSERT OR REPLACE INTO projects VALUES (?, ?)", (pid, json.dumps(data)))

    def get_project(self, pid: str) -> dict | None:
        r = self._x("SELECT data FROM projects WHERE id=?", (pid,))
        return json.loads(r[0][0]) if r else None

    def list_projects(self) -> list[dict]:
        return [json.loads(r[0]) for r in self._x("SELECT data FROM projects ORDER BY id")]

    # files
    def put_file(self, pid: str, name: str, kind: str, sha: str, data: bytes, ts: str) -> None:
        self._x("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?, ?)", (pid, name, kind, sha, data, ts))

    def get_file(self, pid: str, name: str) -> bytes | None:
        r = self._x("SELECT data FROM files WHERE project_id=? AND name=?", (pid, name))
        return r[0][0] if r else None

    def del_file(self, pid: str, name: str) -> None:
        self._x("DELETE FROM files WHERE project_id=? AND name=?", (pid, name))

    # rule sets (each save = a new version)
    def put_ruleset(self, pid: str, version: int, data: dict, ts: str, note: str = "") -> None:
        self._x("INSERT OR REPLACE INTO rulesets VALUES (?, ?, ?, ?, ?)", (pid, version, json.dumps(data), ts, note))

    def get_ruleset(self, pid: str, version: int | None = None) -> dict | None:
        if version is None:
            r = self._x("SELECT data FROM rulesets WHERE project_id=? ORDER BY version DESC LIMIT 1", (pid,))
        else:
            r = self._x("SELECT data FROM rulesets WHERE project_id=? AND version=?", (pid, version))
        return json.loads(r[0][0]) if r else None

    def ruleset_versions(self, pid: str) -> list[dict]:
        return [{"version": v, "ts": ts, "note": n} for v, ts, n in
                self._x("SELECT version, ts, note FROM rulesets WHERE project_id=? ORDER BY version", (pid,))]

    def latest_ruleset_version(self, pid: str) -> int:
        r = self._x("SELECT MAX(version) FROM rulesets WHERE project_id=?", (pid,))
        return r[0][0] or 0

    # append-only logs
    def append(self, table: str, pid: str, ts: str, data: dict, extra: str | None = None) -> None:
        assert table in ("runs", "decisions", "activity", "tq_history")
        if table == "runs":
            self._x("INSERT INTO runs VALUES (?, ?, ?, ?)", (data["run_id"], pid, ts, json.dumps(data)))
        elif table == "tq_history":
            self._x("INSERT INTO tq_history VALUES (?, ?, ?, ?)", (pid, extra, ts, json.dumps(data)))
        else:
            self._x(f"INSERT INTO {table} VALUES (?, ?, ?)", (pid, ts, json.dumps(data)))

    def log(self, table: str, pid: str, limit: int = 200) -> list[dict]:
        assert table in ("runs", "decisions", "activity", "tq_history")
        rows = self._x(f"SELECT data FROM {table} WHERE project_id=? ORDER BY rowid DESC LIMIT ?", (pid, limit))
        return [json.loads(r[0]) for r in rows]

    # key/value per project (settings, mapping overrides, revision state, …)
    def put(self, pid: str, key: str, data: Any) -> None:
        self._x("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)", (pid, key, json.dumps(data)))

    def get(self, pid: str, key: str, default: Any = None) -> Any:
        r = self._x("SELECT data FROM kv WHERE project_id=? AND key=?", (pid, key))
        return json.loads(r[0][0]) if r else default

    def delete_project(self, pid: str) -> None:
        for t in ("projects",):
            self._x(f"DELETE FROM {t} WHERE id=?", (pid,))
        for t in ("files", "rulesets", "runs", "decisions", "activity", "tq_history", "kv"):
            self._x(f"DELETE FROM {t} WHERE project_id=?", (pid,))
