"""The rule LANGUAGE shared by the engine and the independent verifier.

This module interprets rule-set data (conditions, the custom_expr mini-language, naming patterns, the
hardware catalogue). It contains no allocation logic, so the verifier can use it without trusting the engine.

`when` dicts: {field: expected}
  - "VALUE"        case-insensitive equality
  - ["A", "B"]     membership
  - "@list_name"   membership in params.lists[list_name]
  - "~regex"       re.search on the value
An empty `when` always matches.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

CATALOG_PATH = Path(__file__).resolve().parents[1] / "catalog.json"


@lru_cache
def catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text())


def _norm(v: Any) -> str:
    return "" if v is None else str(v).strip()


def match_value(expected: Any, actual: Any, lists: dict[str, list[str]] | None = None) -> bool:
    a = _norm(actual)
    if isinstance(expected, list):
        return a.upper() in {_norm(x).upper() for x in expected}
    e = _norm(expected)
    if e.startswith("@"):
        return a.upper() in {_norm(x).upper() for x in (lists or {}).get(e[1:], [])}
    if e.startswith("~"):
        try:
            return re.search(e[1:], a) is not None
        except re.error:
            return False
    return a.upper() == e.upper()


def match_when(when: dict[str, Any] | None, ctx: dict[str, Any], lists: dict[str, list[str]] | None = None) -> bool:
    return all(match_value(exp, ctx.get(k), lists) for k, exp in (when or {}).items())


def first_match(rows: Iterable[dict], ctx: dict[str, Any], lists: dict | None = None) -> dict | None:
    for row in rows:
        if match_when(row.get("when"), ctx, lists):
            return row
    return None


def derive(spec: dict | None, value: str) -> str | None:
    """Apply {"regex": ..., "format": "P{1}"} to a value; None when it does not match."""
    if not spec or not value:
        return None
    m = re.search(spec.get("regex", "(.*)"), value)
    if not m:
        return None
    out = spec.get("format", "{0}")
    groups = [m.group(0), *m.groups()]
    return re.sub(r"\{(\d+)\}", lambda g: groups[int(g.group(1))] or "", out)


class SafeDict(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def fmt(pattern: str, **tokens: Any) -> str:
    return pattern.format_map(SafeDict({k: "" if v is None else v for k, v in tokens.items()}))


def pattern_regex(pattern: str) -> re.Pattern:
    """Turn a naming pattern into a regex (tokens become non-greedy wildcards) — used by the verifier."""
    parts = re.split(r"(\{[a-z0-9_]+\})", pattern)
    rx = "".join(".+?" if p.startswith("{") else re.escape(p) for p in parts)
    return re.compile("^" + rx + "$")


# ───────────────────────── custom_expr: a safe mini-language ─────────────────────────
#   expr   := cond "->" assign ("," assign)*
#   cond   := or ;  or := and ("or" and)* ;  and := not ("and" not)* ;  not := "not" not | atom
#   atom   := "(" cond ")" | FIELD op VALUE | FIELD ["not"] "in" "[" VALUE ("," VALUE)* "]"
#   op     := "==" | "!=" | "~="          (~= is a regex search)
#   assign := FIELD "=" STRING

ASSIGNABLE = {"charm", "tb", "tb1", "tb2", "tb3", "loop_typical"}
_TOK = re.compile(r'\s*(->|==|!=|~=|\(|\)|\[|\]|,|=|"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?)')


class ExprError(ValueError):
    pass


def _tokenize(s: str) -> list[str]:
    pos, out = 0, []
    s = s.strip()
    while pos < len(s):
        m = _TOK.match(s, pos)
        if not m or m.end() == pos:
            raise ExprError(f"unexpected text at {pos}: {s[pos:pos + 12]!r}")
        out.append(m.group(1))
        pos = m.end()
    return out


class _Parser:
    def __init__(self, toks: list[str]):
        self.t, self.i = toks, 0

    def peek(self) -> str | None:
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self, expect: str | None = None) -> str:
        tok = self.peek()
        if tok is None or (expect is not None and tok != expect):
            raise ExprError(f"expected {expect or 'token'}, got {tok!r}")
        self.i += 1
        return tok

    def value(self) -> str:
        tok = self.take()
        if tok[0] in "\"'":
            return bytes(tok[1:-1], "utf-8").decode("unicode_escape")
        if re.fullmatch(r"-?\d+(\.\d+)?", tok):
            return tok
        raise ExprError(f"expected a quoted value, got {tok!r}")

    def field(self) -> str:
        tok = self.take()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", tok) or tok in {"and", "or", "not", "in"}:
            raise ExprError(f"expected a field name, got {tok!r}")
        return tok

    def cond(self):
        node = self.and_()
        while self.peek() == "or":
            self.take()
            node = ("or", node, self.and_())
        return node

    def and_(self):
        node = self.not_()
        while self.peek() == "and":
            self.take()
            node = ("and", node, self.not_())
        return node

    def not_(self):
        if self.peek() == "not":
            self.take()
            return ("not", self.not_())
        return self.atom()

    def atom(self):
        if self.peek() == "(":
            self.take("(")
            node = self.cond()
            self.take(")")
            return node
        f = self.field()
        op = self.take()
        if op == "not":
            self.take("in")
            return ("not", ("in", f, self.list_()))
        if op == "in":
            return ("in", f, self.list_())
        if op in ("==", "!=", "~="):
            return (op, f, self.value())
        raise ExprError(f"unknown operator {op!r}")

    def list_(self) -> list[str]:
        self.take("[")
        vals = [self.value()]
        while self.peek() == ",":
            self.take(",")
            vals.append(self.value())
        self.take("]")
        return vals


def parse_expr(src: str) -> tuple[Any, dict[str, str]]:
    toks = _tokenize(src)
    if "->" not in toks:
        raise ExprError("missing '->' between condition and assignments")
    p = _Parser(toks)
    cond = p.cond()
    p.take("->")
    assigns: dict[str, str] = {}
    while True:
        f = p.field()
        if f not in ASSIGNABLE:
            raise ExprError(f"cannot assign {f!r}; allowed: {sorted(ASSIGNABLE)}")
        p.take("=")
        assigns[f] = p.value()
        if p.peek() != ",":
            break
        p.take(",")
    if p.peek() is not None:
        raise ExprError(f"unexpected {p.peek()!r} after assignments")
    return cond, assigns


def eval_cond(node, ctx: dict[str, Any]) -> bool:
    kind = node[0]
    if kind == "or":
        return eval_cond(node[1], ctx) or eval_cond(node[2], ctx)
    if kind == "and":
        return eval_cond(node[1], ctx) and eval_cond(node[2], ctx)
    if kind == "not":
        return not eval_cond(node[1], ctx)
    a = _norm(ctx.get(node[1])).upper()
    if kind == "in":
        return a in {v.upper() for v in node[2]}
    if kind == "==":
        return a == node[2].upper()
    if kind == "!=":
        return a != node[2].upper()
    if kind == "~=":
        try:
            return re.search(node[2], _norm(ctx.get(node[1])), re.I) is not None
        except re.error:
            return False
    raise ExprError(f"bad node {kind}")


@lru_cache(maxsize=256)
def compiled_expr(src: str):
    return parse_expr(src)
