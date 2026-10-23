"""Rule-set access for the engine. The rule language itself lives in app.ruleslang (shared with the verifier)."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from app.ruleslang import (  # noqa: F401  (re-exported for engine modules)
    ASSIGNABLE, ExprError, SafeDict, catalog, compiled_expr, derive, eval_cond, first_match, fmt, match_value,
    match_when, parse_expr, pattern_regex,
)
from app.schemas import Rule, RuleSet

ROOT = Path(__file__).resolve().parents[2]
RULESETS = ROOT / "rulesets"


def load_ruleset(name_or_path: str | Path = "default") -> RuleSet:
    p = Path(name_or_path)
    if not p.suffix:
        p = RULESETS / f"{name_or_path}.json"
    return RuleSet.model_validate_json(p.read_text())


def ruleset_hash(rs: RuleSet) -> str:
    return hashlib.sha256(rs.model_dump_json().encode()).hexdigest()


class Rules:
    """Convenience view over a RuleSet: enabled rules by type."""

    def __init__(self, rs: RuleSet):
        self.rs = rs
        self.by_id = {r.id: r for r in rs.rules}

    def all(self, rtype: str) -> list[Rule]:
        return [r for r in self.rs.rules if r.type == rtype and r.enabled]

    def first(self, rtype: str) -> Rule | None:
        rules = self.all(rtype)
        return rules[0] if rules else None

    def params(self, rtype: str) -> dict[str, Any]:
        r = self.first(rtype)
        return r.params if r else {}

    def rid(self, rtype: str) -> str | None:
        r = self.first(rtype)
        return r.id if r else None
