"""Custom rules: a safe, declarative rule language shared by the engine and the independent verifier.

Nothing here allocates anything — it only says what a rule MEANS. The engine feeds it the signals it is placing, the
verifier feeds it the signals it reads back from the output rows; both get the same answer for the same layout.

Rule types (all `params` are validated; a malformed rule is rejected with a plain-English message)

    max_per_scope    at most N signals matching a filter per baseplate | CIOC | cabinet
    scope_relation   signals matching filter A and filter B share (relation "same") or never share ("different") a
                     baseplate | CIOC | cabinet; optional `group_by` field pairs them up per loop / unit / …
    forbid_mix       IO types A and B never meet on one baseplate | CIOC
    zone_cabinets    signals matching a filter may only sit in the listed cabinets (number or name pattern)
    extra_spares     reserve extra wired spares for one IO type, on top of the global wired-spare percentage

Filters are plain data — AND of field conditions, `not`, `any` (OR). Values are globs (`*` and `?` only; no regular
expressions, no eval): {"tag": "440-PI-*", "io_type": ["DOR", "DIR"], "not": {"instrument_type": "XYV"}}
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from app.schemas import Rule, RuleSet, Signal

CUSTOM_TYPES = ("max_per_scope", "scope_relation", "forbid_mix", "zone_cabinets", "extra_spares")
SCOPES = ("baseplate", "cioc", "cabinet")
PLACEMENT_TYPES = ("max_per_scope", "scope_relation", "forbid_mix", "zone_cabinets")   # rules that constrain WHERE a signal goes

# Fields a filter can test. The MDB's passthrough columns are available too.
FILTER_FIELDS = ("tag", "io_type", "instrument_type", "instrument_desc", "cable", "area", "area_code", "room", "group", "family",
                 "signal_type", "signal_level", "equipment", "kind", "status", "operating_area", "unit", "service", "location",
                 "is_type", "external_power", "system2", "old_tag", "loop_name", "section")
MAX_PATTERNS, MAX_NODES, MAX_DEPTH, MAX_PATTERN_LEN = 60, 40, 4, 80
RULE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$")


class RuleError(ValueError):
    """A custom rule is malformed. The message is for the engineer who wrote it."""


# ───────────────────────────── filters ─────────────────────────────

def glob_match(pattern: str, text: str) -> bool:
    """Case-insensitive glob with `*` and `?` only (iterative, linear-ish — no regular expressions, no backtracking blow-up)."""
    p, t = pattern.lower(), text.lower()
    pi = ti = 0
    star = -1
    mark = 0
    while ti < len(t):
        if pi < len(p) and (p[pi] == "?" or p[pi] == t[ti]):
            pi += 1
            ti += 1
        elif pi < len(p) and p[pi] == "*":
            star, mark = pi, ti
            pi += 1
        elif star != -1:
            pi = star + 1
            mark += 1
            ti = mark
        else:
            return False
    while pi < len(p) and p[pi] == "*":
        pi += 1
    return pi == len(p)


def _io_norm(v: str) -> str:
    v = re.sub(r"\s+", "", v or "").upper()
    return v[:2] if len(v) == 3 and v.endswith("R") and v[:2] in ("AI", "AO", "DI", "DO") else v


def filter_ctx(s: Signal) -> dict[str, str]:
    """The fields a filter can see for one signal (the same dictionary for the engine and the verifier)."""
    c = {"tag": s.tag, "tag_key": s.tag_key, "io_type": s.io_type or s.io_type_raw, "instrument_type": s.instrument_type,
         "instrument_desc": s.instrument_desc, "cable": s.cable, "area": s.area, "area_code": s.area_code, "room": s.room,
         "group": s.group, "family": s.family, "signal_type": s.signal_type, "signal_level": s.signal_level,
         "equipment": s.equipment, "kind": s.kind, "status": s.status}
    for k, v in s.extra.items():
        c.setdefault(k, v)
    return {k: ("" if v is None else str(v)) for k, v in c.items()}


class Flt:
    """A compiled filter."""

    def __init__(self, spec: Any, what: str = "filter", _depth: int = 0, _count: list[int] | None = None):
        count = _count if _count is not None else [0]
        count[0] += 1
        if count[0] > MAX_NODES:
            raise RuleError(f"{what}: too many nested conditions (max {MAX_NODES})")
        if _depth > MAX_DEPTH:
            raise RuleError(f"{what}: conditions nested deeper than {MAX_DEPTH} levels")
        if spec is None:
            spec = {}
        if not isinstance(spec, dict):
            raise RuleError(f"{what} must be an object like {{\"io_type\": \"DOR\"}}, not {type(spec).__name__}")
        self.fields: dict[str, list[str]] = {}
        self.neg: Flt | None = None
        self.any: list[Flt] = []
        for k, v in spec.items():
            if k == "not":
                self.neg = Flt(v, f"{what}.not", _depth + 1, count)
            elif k == "any":
                if not isinstance(v, list) or not v:
                    raise RuleError(f"{what}.any must be a non-empty list of filters")
                self.any = [Flt(x, f"{what}.any[{i}]", _depth + 1, count) for i, x in enumerate(v)]
            elif k in FILTER_FIELDS:
                vals = [v] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else v
                if not isinstance(vals, list) or not vals or len(vals) > MAX_PATTERNS:
                    raise RuleError(f"{what}.{k} must be a text pattern or a list of 1–{MAX_PATTERNS} patterns")
                pats = []
                for x in vals:
                    if not isinstance(x, (str, int, float)) or isinstance(x, bool):
                        raise RuleError(f"{what}.{k}: patterns must be text, got {type(x).__name__}")
                    x = str(x).strip()
                    if not x or len(x) > MAX_PATTERN_LEN:
                        raise RuleError(f"{what}.{k}: a pattern must be 1–{MAX_PATTERN_LEN} characters")
                    pats.append(x)
                self.fields[k] = pats
            else:
                raise RuleError(f"{what}: unknown filter field '{k}' (use {', '.join(FILTER_FIELDS[:12])}, …, or 'not' / 'any')")

    def matches(self, ctx: dict[str, str]) -> bool:
        for k, pats in self.fields.items():
            if k == "io_type":
                v = _io_norm(ctx.get(k, ""))
                ok = any(glob_match(_io_norm(p), v) for p in pats)
            elif k == "tag":
                ok = any(glob_match(re.sub(r"\s+", "", p), ctx.get("tag_key", "")) or glob_match(p, ctx.get("tag", "")) for p in pats)
            else:
                v = ctx.get(k, "")
                ok = any(glob_match(p, v) for p in pats)
            if not ok:
                return False
        if self.neg is not None and self.neg.matches(ctx):
            return False
        if self.any and not any(f.matches(ctx) for f in self.any):
            return False
        return True

    def describe(self) -> str:
        parts = [f"{k} {'/'.join(v)}" for k, v in self.fields.items()]
        if self.any:
            parts.append("(" + " or ".join(f.describe() for f in self.any) + ")")
        if self.neg is not None:
            parts.append(f"not ({self.neg.describe()})")
        return " & ".join(parts) or "all signals"


# ───────────────────────────── items and violations ─────────────────────────────

@dataclass
class Item:
    """One signal at a place. The places are opaque hashable ids; the names are only for messages."""
    key: str                                   # tag key
    tag: str
    a: bool = True                             # matches filter A (or the rule's only filter)
    b: bool = False                            # matches filter B (scope_relation / forbid_mix)
    gkey: str = ""                             # group_by value
    domain: str = ""
    cab: Any = None
    cioc: Any = None
    bp: Any = None
    cab_name: str = ""
    cab_no: int | None = None
    cioc_name: str = ""
    bp_name: str = ""

    def scope_id(self, scope: str):
        return self.cab if scope == "cabinet" else self.cioc if scope == "cioc" else self.bp

    def scope_name(self, scope: str) -> str:
        return (self.cab_name if scope == "cabinet" else self.cioc_name if scope == "cioc" else self.bp_name) or "?"


@dataclass
class CViol:
    keys: list[str]                            # tag keys of the signals that break the rule
    tags: list[str]
    message: str


@dataclass
class Outcome:
    violations: list[CViol] = field(default_factory=list)
    checked: int = 0                           # relevant signals looked at


# ───────────────────────────── compiled rule ─────────────────────────────

def _int(v: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v or not lo <= int(v) <= hi:
        raise RuleError(f"{name} must be a whole number between {lo} and {hi}")
    return int(v)


def _unknown(params: dict, allowed: Iterable[str], rtype: str) -> None:
    extra = sorted(set(params) - set(allowed))
    if extra:
        raise RuleError(f"{rtype}: unknown parameter(s) {', '.join(extra)} (allowed: {', '.join(sorted(allowed))})")


class CRule:
    def __init__(self, rule: Rule):
        self.rule = rule
        self.id, self.type, self.severity, self.label = rule.id, rule.type, rule.severity, rule.label
        p = rule.params
        if not isinstance(p, dict):
            raise RuleError("params must be an object")
        self.scope: str = "cioc"
        self.fa = self.fb = self.flt = None
        self.relation = "different"
        self.group_by: str | None = None
        self.max = 0
        self.cabinets: list[str] = []
        self.io_a: list[str] = []
        self.io_b: list[str] = []
        self.io_type = ""
        self.extra_pct = 0.0
        self.extra_count = 0
        t = rule.type
        if t == "max_per_scope":
            _unknown(p, ("filter", "scope", "max"), t)
            self.scope = self._scope(p, SCOPES)
            self.flt = Flt(p.get("filter"), "filter")
            if "max" not in p:
                raise RuleError("max_per_scope needs `max` (the most signals allowed per scope)")
            self.max = _int(p["max"], "max", 0, 100_000)
        elif t == "scope_relation":
            _unknown(p, ("filter_a", "filter_b", "scope", "relation", "group_by"), t)
            self.scope = self._scope(p, SCOPES)
            if "filter_a" not in p or "filter_b" not in p:
                raise RuleError("scope_relation needs `filter_a` and `filter_b`")
            self.fa, self.fb = Flt(p["filter_a"], "filter_a"), Flt(p["filter_b"], "filter_b")
            self.relation = p.get("relation", "different")
            if self.relation not in ("same", "different"):
                raise RuleError("relation must be 'same' or 'different'")
            gb = p.get("group_by")
            if gb not in (None, "") and gb not in FILTER_FIELDS:
                raise RuleError(f"group_by must be one of the filter fields (e.g. loop_name, unit, cable), not '{gb}'")
            self.group_by = gb or None
        elif t == "forbid_mix":
            _unknown(p, ("io_type_a", "io_type_b", "scope"), t)
            self.scope = self._scope(p, ("baseplate", "cioc"))
            for name in ("io_type_a", "io_type_b"):
                v = p.get(name)
                v = [v] if isinstance(v, str) else v
                if not isinstance(v, list) or not v or len(v) > 8 or not all(isinstance(x, str) and x.strip() for x in v):
                    raise RuleError(f"forbid_mix needs `{name}`: an IO type or a list of up to 8 (e.g. [\"AIR\"])")
                setattr(self, "io_a" if name == "io_type_a" else "io_b", [_io_norm(x) for x in v])
            if set(self.io_a) & set(self.io_b):
                raise RuleError("io_type_a and io_type_b overlap — an IO type cannot be forbidden to mix with itself")
            self.fa, self.fb = Flt({"io_type": self.io_a}, "io_type_a"), Flt({"io_type": self.io_b}, "io_type_b")
            self.relation = "different"
        elif t == "zone_cabinets":
            _unknown(p, ("filter", "cabinets"), t)
            self.flt = Flt(p.get("filter"), "filter")
            cabs = p.get("cabinets")
            if not isinstance(cabs, list) or not cabs or len(cabs) > 50:
                raise RuleError("zone_cabinets needs `cabinets`: a list of 1–50 cabinet numbers or name patterns, e.g. [1, 4] or [\"P30-DCM-*-04\"]")
            for c in cabs:
                if isinstance(c, bool) or not isinstance(c, (int, str)) or (isinstance(c, str) and (not c.strip() or len(c) > MAX_PATTERN_LEN)):
                    raise RuleError("cabinets entries must be a cabinet number or a name pattern")
            self.cabinets = [str(c).strip() for c in cabs]
            self.scope = "cabinet"
        elif t == "extra_spares":
            _unknown(p, ("io_type", "extra_pct", "extra_count"), t)
            io = p.get("io_type")
            if not isinstance(io, str) or not io.strip():
                raise RuleError("extra_spares needs `io_type` (e.g. \"AIR\")")
            self.io_type = _io_norm(io)
            pct, cnt = p.get("extra_pct", 0), p.get("extra_count", 0)
            if isinstance(pct, bool) or not isinstance(pct, (int, float)) or not 0 <= pct <= 100:
                raise RuleError("extra_pct must be a percentage between 0 and 100")
            self.extra_pct = float(pct)
            self.extra_count = _int(cnt, "extra_count", 0, 10_000)
            if self.extra_pct == 0 and self.extra_count == 0:
                raise RuleError("extra_spares needs extra_pct and/or extra_count greater than 0")
            self.scope = "cabinet"
        else:
            raise RuleError(f"'{t}' is not a custom rule type (use {', '.join(CUSTOM_TYPES)})")

    @staticmethod
    def _scope_of(p: dict, allowed: tuple[str, ...]) -> str:
        s = p.get("scope", "cioc")
        if s not in allowed:
            raise RuleError(f"scope must be one of {', '.join(allowed)} (got {s!r})")
        return s

    _scope = _scope_of

    # ── what a signal is to this rule ──
    def flags(self, ctx: dict[str, str]) -> tuple[bool, bool, str]:
        """(is A / the only filter, is B, group value). A signal that is neither is irrelevant to the rule."""
        if self.type in ("max_per_scope", "zone_cabinets"):
            return self.flt.matches(ctx), False, ""   # type: ignore[union-attr]
        a, b = self.fa.matches(ctx), self.fb.matches(ctx)    # type: ignore[union-attr]
        return a, b, (ctx.get(self.group_by, "") if self.group_by else "")

    def affects_placement(self) -> bool:
        return self.type in PLACEMENT_TYPES

    def describe(self) -> str:
        t = self.type
        if t == "max_per_scope":
            return f"at most {self.max} signal(s) matching [{self.flt.describe()}] per {self.scope}"      # type: ignore[union-attr]
        if t == "scope_relation":
            return (f"[{self.fa.describe()}] and [{self.fb.describe()}] " + ("share" if self.relation == "same" else "never share")  # type: ignore[union-attr]
                    + f" a {self.scope}" + (f" (per {self.group_by})" if self.group_by else ""))
        if t == "forbid_mix":
            return f"{'/'.join(self.io_a)} and {'/'.join(self.io_b)} never share a {self.scope}"
        if t == "zone_cabinets":
            return f"[{self.flt.describe()}] only in cabinet(s) {', '.join(self.cabinets)}"               # type: ignore[union-attr]
        return f"{self.extra_pct:g}% + {self.extra_count} extra wired spare(s) for {self.io_type}"

    # ── evaluation ──
    @property
    def same_bp(self) -> bool:
        """A "same baseplate" relation: the engine keeps the partners on one CIOC first, then anchors them to one baseplate in layout()."""
        return self.type == "scope_relation" and self.relation == "same" and self.scope == "baseplate"

    def evaluate(self, items: list[Item], scope: str | None = None) -> Outcome:
        """Violations among items already placed (`items` = the relevant signals only; each has cab/cioc/bp set).
        `scope` overrides the rule's scope (the engine checks a "same baseplate" rule at CIOC level before the baseplates exist)."""
        out = Outcome(checked=len(items))
        sc = scope or self.scope
        t = self.type
        if t == "max_per_scope":
            by: dict[Any, list[Item]] = {}
            for it in items:
                by.setdefault((it.domain, it.scope_id(self.scope)), []).append(it)
            for grp in by.values():
                if len(grp) > self.max:
                    grp.sort(key=lambda i: i.key)
                    over = grp[self.max:]
                    out.violations.append(CViol([i.key for i in over], [i.tag for i in over],
                        f"{len(grp)} signals matching [{self.flt.describe()}] in {self.scope} {grp[0].scope_name(self.scope)} "  # type: ignore[union-attr]
                        f"(max {self.max}): {', '.join(i.tag for i in over[:4])}{' …' if len(over) > 4 else ''} over the limit — rule {self.id}"))
        elif t in ("scope_relation", "forbid_mix") and self.relation == "different":
            by = {}
            for it in items:
                by.setdefault((it.domain, it.gkey, it.scope_id(self.scope)), []).append(it)
            for grp in by.values():
                a = [i for i in grp if i.a]
                b = [i for i in grp if i.b]
                if any(x is not y for x in a for y in b):
                    flagged = sorted({i.key: i for i in b if any(x is not i for x in a)}.values(), key=lambda i: i.key)
                    out.violations.append(CViol([i.key for i in flagged], [i.tag for i in flagged],
                        f"{', '.join(i.tag for i in flagged[:4])}{' …' if len(flagged) > 4 else ''} share {self.scope} "
                        f"{grp[0].scope_name(self.scope)} with {', '.join(i.tag for i in a[:3])}{' …' if len(a) > 3 else ''} — "
                        f"{self.describe()} — rule {self.id}"))
        elif t == "scope_relation":                                   # same
            by = {}
            for it in items:
                by.setdefault((it.domain, it.gkey), []).append(it)
            for grp in by.values():
                if not (any(i.a for i in grp) and any(i.b for i in grp)):
                    continue
                places: dict[Any, list[Item]] = {}
                for i in grp:
                    places.setdefault(i.scope_id(sc), []).append(i)
                if len(places) > 1:
                    home = max(places.values(), key=lambda v: (len(v), -min(hash_key(i.key) for i in v)))
                    rest = sorted((i for v in places.values() if v is not home for i in v), key=lambda i: i.key)
                    out.violations.append(CViol([i.key for i in rest], [i.tag for i in rest],
                        f"{', '.join(i.tag for i in rest[:4])}{' …' if len(rest) > 4 else ''} not in {sc} "
                        f"{home[0].scope_name(sc)} with {', '.join(i.tag for i in home[:3])}{' …' if len(home) > 3 else ''} — "
                        f"{self.describe()} — rule {self.id}"))
        elif t == "zone_cabinets":
            for it in sorted(items, key=lambda i: i.key):
                if not self.cabinet_ok(it.cab_name, it.cab_no):
                    out.violations.append(CViol([it.key], [it.tag],
                        f"{it.tag} is in cabinet {it.cab_name} — allowed: {', '.join(self.cabinets)} — rule {self.id}"))
        return out

    def cabinet_ok(self, name: str, no: int | None) -> bool:
        for c in self.cabinets:
            if c.isdigit():
                if no is not None and int(c) == no:
                    return True
            elif glob_match(c, name or ""):
                return True
        return False

    def extra_target(self, n_field: int) -> int:
        return math.ceil(n_field * self.extra_pct / 100 - 1e-9) + self.extra_count if n_field else 0


def hash_key(s: str) -> int:
    """A stable order for tie-breaks (never Python's per-process str hash)."""
    return sum((i + 1) * ord(c) for i, c in enumerate(s))


# ───────────────────────────── validation of whole rules / rule sets ─────────────────────────────

def is_custom(rule: Rule) -> bool:
    return rule.type in CUSTOM_TYPES


def compile_rule(rule: Rule) -> CRule:
    if not RULE_ID.match(rule.id or ""):
        raise RuleError("rule id must be 1–48 characters: letters, digits, '.', '_' or '-' (starting with a letter or digit)")
    if not (rule.label or "").strip() or len(rule.label) > 240:
        raise RuleError("rule label is required (max 240 characters) — it is what the proof certificate and the TQs quote")
    return CRule(rule)


def validate_ruleset(rs: RuleSet) -> list[CRule]:
    """Compile every custom rule (enabled or not). Raises RuleError naming the rule that is malformed."""
    seen: set[str] = set()
    out = []
    for r in rs.rules:
        if r.id in seen:
            raise RuleError(f"duplicate rule id '{r.id}'")
        seen.add(r.id)
        if is_custom(r):
            try:
                out.append(compile_rule(r))
            except RuleError as e:
                raise RuleError(f"rule '{r.id}': {e}") from e
    return out


def compile_enabled(rs: RuleSet) -> tuple[list[CRule], list[tuple[Rule, str]]]:
    """(compiled enabled custom rules, [(rule, error)] for the ones that cannot be compiled) — never raises."""
    ok, bad = [], []
    for r in rs.rules:
        if is_custom(r) and r.enabled:
            try:
                ok.append(compile_rule(r))
            except RuleError as e:
                bad.append((r, str(e)))
            except Exception as e:  # noqa: BLE001 — a rule must never be able to break a run
                bad.append((r, f"{type(e).__name__}: {e}"))
    return ok, bad


def exempt_keys(tqs: list, rule_id: str) -> set[str]:
    """Tag keys a 'Custom rule clash' TQ covers for this rule: they are reported as excepted, never as a silent pass."""
    out: set[str] = set()
    for t in tqs:
        if t.category == "Custom rule clash" and rule_id in t.rules_in_conflict:
            out.update(re.sub(r"\s+", "", g) for g in t.tags)
    return out
