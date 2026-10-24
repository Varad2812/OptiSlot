"""Self-healing for a database written by an older build.

A project stores its own copy of the rule set. When rulesets/default.json grows a field (a new rule, a new parameter)
the stored copy lacks it, and the newer engine and verifier then judge the old rule set by rules it never had. The
fix is additive: copy the missing fields from the current default into the stored rule set and never overwrite a value
the user may have edited. Custom rules and rules the user deleted on purpose are left alone.

ENGINE_VERSION is not bumped per commit, so the stamp also carries the hash of the default rule set — the thing
the engine and the verifier actually expect. A project whose stored stamp differs gets one migration pass."""
from __future__ import annotations

import copy
from typing import Any

from app.schemas import ENGINE_VERSION
from engine.rules import RULESETS, load_ruleset
from verify.certificate import ruleset_hash

_cache: dict[str, Any] = {"key": None, "stamp": None, "default": None}


def _default() -> tuple[dict, dict]:
    """(stamp, default rule set as a dict) — re-read only when rulesets/default.json changes on disk."""
    p = RULESETS / "default.json"
    st = p.stat()
    key = (st.st_mtime_ns, st.st_size)
    if _cache["key"] != key:
        rs = load_ruleset("default")
        _cache.update(key=key, default=rs.model_dump(mode="json"),
                      stamp={"engine_version": ENGINE_VERSION, "rules_baseline": ruleset_hash(rs)})
    return _cache["stamp"], _cache["default"]


def current_stamp() -> dict:
    """What a project must have been stamped with to be considered up to date."""
    return dict(_default()[0])


def _fill(dst: dict, src: dict, path: str, added: list[str]) -> None:
    for k, v in src.items():
        if k not in dst:
            dst[k] = copy.deepcopy(v)
            added.append(f"{path}{k}")
        elif isinstance(dst[k], dict) and isinstance(v, dict):
            _fill(dst[k], v, f"{path}{k}.", added)


def merge_defaults(stored: dict, deleted_ids: set[str] | frozenset[str] = frozenset()) -> tuple[dict, list[str]]:
    """The stored rule set (as a dict) plus every field of the current default it lacks, and what was added.

    Existing values, labels, severities, enabled flags and custom rules are never changed. A default rule the user
    deleted on purpose (`deleted_ids`, read from the decision log) is not brought back."""
    default = _default()[1]
    merged = copy.deepcopy(stored)
    added: list[str] = []
    _fill(merged, {k: v for k, v in default.items() if k != "rules"}, "", added)
    rules: list[dict] = merged.setdefault("rules", [])
    by_id = {r.get("id"): r for r in rules}
    prev: str | None = None
    for d in default["rules"]:
        have = by_id.get(d["id"])
        if have is not None:
            have.setdefault("params", {})
            _fill(have["params"], d.get("params", {}), f"{d['id']}.params.", added)
        elif d["id"] not in deleted_ids:
            at = next((i + 1 for i, r in enumerate(rules) if r.get("id") == prev), 0)   # keep the default's order
            rules.insert(at, copy.deepcopy(d))
            by_id[d["id"]] = rules[at]
            added.append(f"{d['id']} (new rule)")
        prev = d["id"]
    return merged, added
