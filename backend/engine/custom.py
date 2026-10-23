"""Custom rules inside the engine: placement hooks and the final check.

`CustomPlan` is built once per run. It answers three questions for the allocator:
  conflict(cab, local, block)   may this cable join that CIOC? (CIOC- and cabinet-scope rules, zones, "same" relations)
  bp_conflict(occupants, block) may this cable share that baseplate? (baseplate-scope rules, used by layout())
  final_check(slots)            after the grid is filled: any rule still broken? → one "Custom rule clash" TQ per rule

Only HARD rules constrain placement. A soft rule is advisory: it is not enforced here, only reported by the verifier as a
warning. A cable whose own signals already break a rule (e.g. two forbidden IO types on one cable) cannot satisfy it
wherever it lands: that is raised as a TQ once and the cable is exempt from that rule — reported as "excepted", never
as a silent pass (the verifier reads the same TQ).
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Callable

from app.customrules import CRule, Item, compile_enabled, filter_ctx
from app.schemas import Signal
from engine.failsafe import sys_tq
from engine.tqs import TQBook

Hit = tuple[str, str, list[str]]       # (message, rule id, other cables)


def _tk(tag: str) -> str:
    return re.sub(r"\s+", "", tag or "")


class CustomPlan:
    def __init__(self, rs, signals: list[Signal], book: TQBook | None, cab_name: Callable, chs: int = 12,
                 exempt: dict[str, set[str]] | None = None):
        self.rules, bad = compile_enabled(rs)
        self.hard = [r for r in self.rules if r.severity == "hard" and r.affects_placement()]
        self.same_bp_rules = [r for r in self.hard if r.same_bp]
        self.bp_rules = [r for r in self.hard if r.scope == "baseplate" and not r.same_bp]
        self.cab_rules = [r for r in self.hard if r.scope != "baseplate" or r.same_bp]
        self.cab_name = cab_name
        self.chs = chs
        self.exempt: dict[str, set[str]] = {r.id: set(exempt.get(r.id, ())) if exempt else set() for r in self.rules}
        self._ctx: dict[int, dict] = {}
        self._mem: dict[tuple[str, int], list[tuple[Signal, bool, bool, str]]] = {}
        self._names: dict[tuple, str] = {}
        self.errors = bad
        if book is not None:
            for rule, err in bad:
                sys_tq(book, "custom", f"Custom rule '{rule.id}' ({rule.label}) is malformed and was skipped: {err}. Edit or delete it "
                       f"in Rules Studio.", severity="high", tags=[], fixes=[{"label": f"Delete rule {rule.id}"}])
        self.by_id = {r.id: r for r in self.rules}
        self.signals = signals

    @property
    def active(self) -> bool:
        return bool(self.hard)

    # ── members of a block, as the rule sees them ──
    def ctx(self, s: Signal) -> dict:
        c = self._ctx.get(id(s))
        if c is None:
            c = self._ctx[id(s)] = filter_ctx(s)
        return c

    def members(self, rule: CRule, b) -> list[tuple[Signal, bool, bool, str]]:
        """(signal, is A, is B, group) for the block's signals that matter to the rule and are not exempt."""
        k = (rule.id, id(b))            # the object, not b.id: two controller domains can both have a cable of the same name
        got = self._mem.get(k)
        if got is None:
            ex = self.exempt.get(rule.id, set())
            got = []
            for s in b.members.values():
                if s.tag_key in ex:
                    continue
                a, bb, g = rule.flags(self.ctx(s))
                if a or bb:
                    got.append((s, a, bb, g))
            self._mem[k] = got
        return got

    def _cab_label(self, cab) -> str:
        if not hasattr(cab, "domain"):          # a probe cabinet (pre-flight): no name
            return ""
        k = (cab.ns, cab.seq, cab.domain)
        if k not in self._names:
            self._names[k] = self.cab_name(cab)
        return self._names[k]

    def _items(self, rule: CRule, b, cab, local: int, bp_of=None) -> list[Item]:
        out = []
        name = self._cab_label(cab)
        for s, a, bb, g in self.members(rule, b):
            bp = bp_of(s) if bp_of else None
            out.append(Item(key=s.tag_key, tag=s.tag, a=a, b=bb, gkey=g, domain=b.domain, cab=(cab.ns, cab.seq),
                            cioc=(cab.ns, cab.seq, local), bp=(cab.ns, cab.seq, local, bp), cab_name=name,
                            cab_no=cab.seq, cioc_name=f"{local}", bp_name=f"{bp}"))
        return out

    # ── placement ──
    def conflict(self, cab, local: int, b, domain_cabs: list) -> Hit | None:
        """Would block `b` placed on CIOC `local` of `cab` break a hard CIOC/cabinet-scope rule?"""
        for rule in self.cab_rules:
            mine = self.members(rule, b)
            if not mine:
                continue
            here = self._items(rule, b, cab, local)
            others: list[Item] = []
            for c in domain_cabs:
                for l, bl in c.blocks.items():
                    if rule.type == "scope_relation" and rule.relation == "same":
                        pass                                   # a "same" rule looks at every placed partner in the domain
                    elif rule.scope == "cioc" and not (c is cab and l == local):
                        continue
                    elif rule.scope == "cabinet" and c is not cab:
                        continue
                    elif rule.type == "zone_cabinets":
                        continue
                    for o in bl:
                        if o is not b:
                            others.extend(self._items(rule, o, c, l))
            v = self._new_violation(rule, others, here, "cioc" if rule.same_bp else None)
            if v is not None:
                others_cables = sorted({o.cable for c in domain_cabs for bl in c.blocks.values() for o in bl
                                        if o is not b and any(s.tag in v.message for s in o.members.values())})
                return v.message, rule.id, others_cables
        return None

    @staticmethod
    def _new_violation(rule: CRule, others: list[Item], here: list[Item], scope: str | None = None):
        """The first violation that exists only because `here` joined `others` (a clash among `others` alone is not this block's)."""
        res = rule.evaluate(others + here, scope)
        if not res.violations:
            return None
        before = {(tuple(v.keys), v.message) for v in rule.evaluate(others, scope).violations} if others else set()
        return next((v for v in res.violations if (tuple(v.keys), v.message) not in before), None)

    def bp_conflict(self, occupants: list, b) -> Hit | None:
        """Would block `b` on a baseplate that already holds `occupants` break a hard baseplate-scope rule?
        Each block is judged by the baseplate it sits on (a cable of 12+ pairs fills its baseplates alone)."""
        for rule in self.bp_rules:
            mine = self.members(rule, b)
            if not mine:
                continue
            probe = type("P", (), {"ns": ("", ""), "seq": 0})()
            others: list[Item] = []
            for o in occupants:
                others += self._items(rule, o, probe, 1, lambda s: 1)
            v = self._new_violation(rule, others, self._items(rule, b, probe, 1, lambda s: 1))
            if v is not None:
                return v.message, rule.id, sorted({o.cable for o in occupants})
        return None

    def bp_anchor(self, held: dict, b) -> set[int] | None:
        """Baseplates block `b` must use so that "same baseplate" partners already laid out stay with it (None = free choice)."""
        allowed: set[int] | None = None
        for rule in self.same_bp_rules:
            for g in {g for *_, g in self.members(rule, b)}:
                bps = {bp for bp, blocks in held.items() for o in blocks if any(gg == g for *_, gg in self.members(rule, o))}
                if bps:
                    allowed = bps if allowed is None else allowed & bps
        return allowed

    def assignment_ok(self, cabs: list) -> bool:
        """CP-SAT guard: does an assignment of blocks to CIOCs keep every hard CIOC/cabinet-scope rule? (baseplates are unknown yet)"""
        for rule in self.cab_rules:
            items: list[Item] = []
            for c in cabs:
                for l, bl in c.blocks.items():
                    for o in bl:
                        items += self._items(rule, o, c, l)
            if rule.evaluate(items, "cioc" if rule.same_bp else None).violations:
                return False
        return True

    # ── pre-flight: cables that cannot satisfy a rule on their own ──
    def preflight(self, blocks: list, book: TQBook, rid_contiguous: str | None) -> None:
        for rule in self.hard:
            for b in blocks:
                mine = self.members(rule, b)
                if not mine:
                    continue

                def bp_of(s, b=b) -> int:
                    return ((s.pair or 1) - 1) // self.chs if b.span else 0
                probe = type("P", (), {"ns": ("", ""), "seq": 1})()
                res = rule.evaluate(self._items(rule, b, probe, 1, bp_of))
                if rule.type == "zone_cabinets" or not res.violations:
                    continue
                tags = [s.tag for s, *_ in mine]
                self.exempt[rule.id] |= {s.tag_key for s, *_ in mine}
                self._mem = {k: v for k, v in self._mem.items() if k[0] != rule.id}
                book.add("custom", "Custom rule clash", "high",
                         f"Cable {b.cable} carries signals that rule {rule.id} ({rule.label}) cannot allow together — {res.violations[0].message}. "
                         f"A cable always lands together ({rid_contiguous or 'r-cable'}), so the rule cannot be met for it; it is placed as a "
                         f"TQ-covered exception. Fix: re-tag or split the cable, or relax the rule.",
                         rows=[s.row for s, *_ in mine], tags=tags, field="Cable", rules=[rule.id, *([rid_contiguous] if rid_contiguous else [])],
                         fixes=[{"label": "Split the cable"}, {"label": f"Switch rule {rule.id} off",
                                                              "rule_patch": {"rule_id": rule.id, "op": "toggle", "value": False}}],
                         unchanged="Everything else unchanged.", key=f"custom:{rule.id}:{b.cable}")

    # ── after the grid is filled ──
    def final_check(self, slots: list, by_row: dict[int, Signal], book: TQBook) -> list:
        """Any hard rule still broken (capacity forced it, or a position was pinned) becomes ONE TQ per rule that names the
        signals — a covered exception, never silence."""
        made = []
        for rule in self.hard:
            ex = self.exempt.get(rule.id, set())
            items = []
            for sl in slots:
                if sl.status != "Field" or sl.source_row is None:
                    continue
                s = by_row.get(sl.source_row)
                if s is None or s.tag_key in ex:
                    continue
                a, b, g = rule.flags(self.ctx(s))
                if a or b:
                    items.append(Item(key=s.tag_key, tag=s.tag, a=a, b=b, gkey=g, domain=sl.domain, cab=sl.cabinet,
                                      cioc=(sl.cabinet, sl.cioc), bp=(sl.cabinet, sl.cioc, sl.baseplate), cab_name=sl.cabinet,
                                      cab_no=sl.cabinet_seq, cioc_name=sl.cioc, bp_name=sl.baseplate))
            res = rule.evaluate(items)
            if res.violations:
                keys = sorted({k for v in res.violations for k in v.keys})
                tags = [t for v in res.violations for t in v.tags]
                made.append(book.add("custom", "Custom rule clash", "high",
                    f"Rule {rule.id} ({rule.label}) could not be met: {res.violations[0].message}"
                    + (f" (+{len(res.violations) - 1} more)" if len(res.violations) > 1 else "")
                    + ". Capacity or another hard rule leaves no valid slot; the signals are allocated and covered by this TQ. "
                      "Fix: relax the rule, add capacity, or re-tag the signals.",
                    rows=[sl.source_row for sl in slots if sl.status == "Field" and by_row.get(sl.source_row or -1) is not None
                          and by_row[sl.source_row].tag_key in keys],
                    tags=list(dict.fromkeys(tags)), field="Placement", rules=[rule.id],
                    fixes=[{"label": f"Switch rule {rule.id} off", "rule_patch": {"rule_id": rule.id, "op": "toggle", "value": False}},
                           {"label": "Raise the cabinet limit or free capacity"}],
                    unchanged="Signals outside the clash keep their slots.", key=f"custom-final:{rule.id}"))
        return made

    # ── wired spares ──
    def extra_target(self, io_type: str, n_field: int) -> int:
        from app.customrules import _io_norm
        want = _io_norm(io_type)
        return sum(r.extra_target(n_field) for r in self.rules if r.type == "extra_spares" and r.io_type == want)
