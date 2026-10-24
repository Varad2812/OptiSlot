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


def seg_field(rule: Rule) -> str:
    """The signal field a segregate rule splits on (default: the IO grouping)."""
    return rule.params.get("field") or "group"


def seg_level(rule: Rule) -> str:
    return rule.params.get("level", "cioc")


def seg_value(s, f: str) -> str:
    v = getattr(s, f, None) if f in type(s).model_fields and f != "extra" else s.extra.get(f)
    return "" if v is None else str(v).strip()


def seg_family(rule: Rule, value: str) -> str | None:
    """Family of a value under a segregate rule; a blank or unrecognised value falls back to `default_family`
    (when the rule has one — preflight raises ONE TQ per rule for those rows)."""
    g = (value or "").strip().upper()
    for fam, members in rule.params.get("families", {}).items():
        if g in {m.upper() for m in members}:
            return fam
    return rule.params.get("default_family")


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

    @property
    def primary_seg(self) -> Rule | None:
        """The A/B rule: the first segregate rule on the IO grouping at CIOC or cabinet level. It drives the A/B
        family colouring; every other segregate rule (e.g. IS / NON-IS per baseplate) is a secondary rule."""
        return next((r for r in self.all("segregate") if seg_field(r) == "group" and seg_level(r) != "baseplate"), None)

    def io_types(self) -> list[str]:
        """The IO types this rule set knows, in a stable order: the IO map's targets, then the hardware map's."""
        mapped = self.params("io_type_map").get("map", {}).values()
        hw = [r.get("when", {}).get("io_type") for r in self.params("hardware_map").get("rows", [])]
        return [t for t in dict.fromkeys([*mapped, *hw]) if isinstance(t, str) and t]

    @property
    def ab_rid(self) -> str | None:
        r = self.primary_seg
        return r.id if r else None

    @property
    def cioc_strategy(self) -> str:
        return self.rs.settings.cioc_strategy

    def rid(self, rtype: str) -> str | None:
        r = self.first(rtype)
        return r.id if r else None
