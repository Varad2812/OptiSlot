"""Run certificate: hashes that make every run reproducible and auditable."""
from __future__ import annotations

import datetime as dt
import hashlib
import json

from app.schemas import ENGINE_VERSION, Certificate, RuleCheckReport, RuleSet


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ruleset_hash(rs: RuleSet) -> str:
    return sha256(json.dumps(rs.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode())


def certify(mdb_sha: str, rs: RuleSet, output: bytes, report: RuleCheckReport, settings_json: str = "") -> Certificate:
    rh = ruleset_hash(rs)
    out = sha256(output)
    run_id = "run-" + sha256(f"{mdb_sha}:{rh}:{out}:{ENGINE_VERSION}:{settings_json}".encode())[:12]
    return Certificate(run_id=run_id, timestamp=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       engine_version=ENGINE_VERSION, mdb_sha256=mdb_sha, ruleset_hash=rh, output_sha256=out,
                       verdict=report.verdict, checks_passed=report.checks_passed, checks_total=report.checks_total,
                       violations=report.violations)
