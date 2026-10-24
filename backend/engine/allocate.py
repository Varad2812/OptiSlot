"""The allocation engine: pure, deterministic, explainable.

    partition by controller domain
    → cabinets (declared by cabinet-alarm rows, more opened on overflow)
    → reserve: cabinet-alarm baseplate + future-spare baseplates at the END of each cabinet
    → cable blocks sorted family → IO grouping (sequence) → size desc → cable no
    → assign each block to a CIOC (greedy next-fit; CP-SAT may replace this step)
      cioc_strategy compact  = fewest CIOCs; balanced = then re-spread over every CIOC of those cabinets
    → deterministic layout inside each CIOC (no defragmentation, pinned blocks never move)
    → full grid: every slot of every instantiated CIOC → Field / Wired Spare / Spare Slot / Cabinet Alarm
      (balanced: all CIOCs of every cabinet; compact: only CIOCs that hold signals)
    → wired spares per controller per IO type → names → why[] trace

Nothing project-specific lives here: geometry comes from ProjectSettings, everything else from the rule set.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Callable

from app.schemas import (
    BaseplateInfo, CabinetInfo, CiocInfo, ProjectSettings, Signal, Slot, TQ, WhyStep,
)
from engine.hardware import resolve, signal_ctx, spare_slot_hw
from engine.rules import Rules, catalog, derive, first_match, fmt, seg_family, seg_field, seg_level, seg_value
from engine.failsafe import EngineFailure
from engine.tqs import TQBook

FAMILY_RANK = {"A": 0, "B": 1, "-": 2}


def natural(s: str) -> tuple:
    return tuple(int(t) if i % 2 else t for i, t in enumerate(re.split(r"([0-9]+)", s or "")))


# ───────────────────────────── data structures ─────────────────────────────

@dataclass
class Block:
    id: str
    cable: str
    size: int
    span: int                    # whole baseplates (0 = small cable packed inside one baseplate)
    foot: int                    # channel footprint on the 1|2|6|12 chain (12 * span for big cables)
    members: dict[int, Signal]
    family: str
    group: str
    group_rank: int
    domain: str
    first_row: int
    exception_tq: str | None = None
    kind: str = "field"
    # placement
    cab: "Cab | None" = None
    cioc: int | None = None
    bp: int | None = None
    ch: int | None = None
    pinned: bool = False
    pin_pos: tuple[int, int, int, int] | None = None  # (cab seq, cioc local, bp, ch) for revisions
    move_reason: str | None = None
    fams: dict[str, str] = field(default_factory=dict)   # rule id → family, for every segregate rule except the A/B one
    fam_exceptions: dict[str, str] = field(default_factory=dict)  # rule id → TQ id when one cable mixes families

    @property
    def sort_key(self) -> tuple:
        return (FAMILY_RANK.get(self.family, 2), self.group_rank, -self.size, natural(self.cable))

    def pos(self, pair: int) -> tuple[int, int]:
        """(bp, ch) of a pair once placed."""
        assert self.bp is not None and self.ch is not None
        if self.span:
            return self.bp + (pair - 1) // 12, (pair - 1) % 12 + 1
        return self.bp, self.ch + pair - 1


@dataclass
class Cab:
    seq: int
    ns: tuple[str, str]          # (loc, area_code) naming namespace
    domain: str
    declared: bool = False
    dorder: int = 0              # order of the domain's first appearance in the MDB
    controller_seq: int = 1
    reserved: dict[tuple[int, int], str] = field(default_factory=dict)
    blocks: dict[int, list[Block]] = field(default_factory=lambda: defaultdict(list))
    family: dict[int, str | None] = field(default_factory=dict)
    alarms: list[Signal] = field(default_factory=list)
    alarm_why: dict[int, str] = field(default_factory=dict)
    alarm_pos: dict[int, tuple[int, int]] = field(default_factory=dict)
    alarm_exception: str | None = None
    alarm_minority: str | None = None
    alarm_lock: dict[int, str] = field(default_factory=dict)  # CIOC family fixed by cabinet alarms
    locks: dict[tuple[str, int], str] = field(default_factory=dict)  # (rule id, CIOC local or 0 = cabinet) → family


@dataclass
class Geometry:
    ciocs: int
    bps: int
    chs: int
    whole_min: int
    bp_seg: tuple[str, ...] = ()     # segregate rules at baseplate level (e.g. IS / NON-IS): enforced by layout()
    custom: object | None = None     # engine.custom.CustomPlan when baseplate-scope custom rules exist (enforced by layout())

    @property
    def per_cabinet(self) -> int:
        return self.ciocs * self.bps * self.chs


def footprint(size: int, g: Geometry) -> tuple[int, int]:
    """(span, foot). Sizes ≥ whole_min (or > half a baseplate) take whole baseplates; others round onto 1|2|6."""
    if size >= g.whole_min or size > g.chs // 2:
        span = max(1, math.ceil(size / g.chs))
        return span, span * g.chs
    for f in (1, 2, 6):
        if size <= f and g.chs % f == 0:
            return 0, f
    return 1, g.chs


# ───────────────────────────── layout inside one CIOC ─────────────────────────────

def layout(blocks: list[Block], usable: list[int], g: Geometry) -> dict[str, tuple[int, int]] | None:
    """Deterministic placement of blocks inside one CIOC. Pinned blocks keep their position.
    Big blocks take the first run of whole free baseplates (in sequence order); small blocks are packed
    largest-first into aligned channel runs. Returns {block_id: (bp, ch)} or None if they do not fit."""
    free = {bp: [True] * g.chs for bp in usable}
    out: dict[str, tuple[int, int]] = {}
    bp_fam: dict[int, dict[str, str]] = defaultdict(dict)   # baseplate → {rule id: family} (baseplate-level rules)

    def sig(b: Block) -> tuple:
        return tuple(b.fams.get(r) or "" for r in g.bp_seg)

    def mixes(bp: int, b: Block) -> bool:
        return any(bp_fam[bp].get(r) not in (None, f) for r, f in b.fams.items() if r in g.bp_seg)

    def mark(bp: int, b: Block) -> None:
        for r, f in b.fams.items():
            if r in g.bp_seg:
                bp_fam[bp].setdefault(r, f)

    def take(bp: int, ch: int, n: int) -> bool:
        if bp not in free or ch - 1 + n > g.chs or not all(free[bp][ch - 1:ch - 1 + n]):
            return False
        for i in range(ch - 1, ch - 1 + n):
            free[bp][i] = False
        return True

    plan = g.custom                                     # custom baseplate-scope rules
    held: dict[int, list[Block]] = defaultdict(list)    # baseplate → blocks laid on it so far

    def custom_blocks(bp: int, b: Block) -> bool:
        return plan is not None and plan.bp_conflict(held[bp], b) is not None

    def anchored(bps: list[int], b: Block) -> bool:
        """False when a "same baseplate" partner is already laid out elsewhere (b must join it)."""
        if plan is None or not plan.same_bp_rules:
            return True
        allowed = plan.bp_anchor(held, b)
        return allowed is None or all(x in allowed for x in bps)

    def hold(bp: int, b: Block) -> None:
        if plan is not None:
            held[bp].append(b)

    for b in blocks:
        if b.pinned and b.pin_pos:
            _, _, bp, ch = b.pin_pos
            bps = [bp + k for k in range(b.span)] if b.span else [bp]
            if any(mixes(x, b) or custom_blocks(x, b) for x in bps):
                return None
            if b.span:
                if not all(take(bp + k, 1, g.chs) for k in range(b.span)):
                    return None
            elif not take(bp, ch, b.foot):
                return None
            for x in bps:
                mark(x, b)
                hold(x, b)
            out[b.id] = (bp, ch)
    rest = [b for b in blocks if not (b.pinned and b.pin_pos)]
    for b in [b for b in rest if b.span]:
        for i, bp in enumerate(usable):
            run = usable[i:i + b.span]
            if (len(run) == b.span and run == list(range(bp, bp + b.span)) and all(all(free[x]) for x in run)
                    and not any(custom_blocks(x, b) for x in run) and anchored(run, b)):
                for x in run:
                    take(x, 1, g.chs)
                    mark(x, b)
                    hold(x, b)
                out[b.id] = (bp, 1)
                break
        else:
            return None
    # small blocks: largest first; with baseplate-level segregation, one family at a time so families fill whole baseplates
    for b in sorted([b for b in rest if not b.span], key=lambda b: (sig(b), -b.foot, b.sort_key)):
        done = False
        for bp in usable:
            if mixes(bp, b) or custom_blocks(bp, b) or not anchored([bp], b):
                continue
            for ch0 in range(0, g.chs - b.foot + 1, b.foot):
                if take(bp, ch0 + 1, b.foot):
                    mark(bp, b)
                    hold(bp, b)
                    out[b.id] = (bp, ch0 + 1)
                    done = True
                    break
            if done:
                break
        if not done:
            return None
    return out


# ───────────────────────────── the engine ─────────────────────────────

@dataclass
class Baseline:
    """A previous allocation, reduced to what a revision must preserve."""
    cabs: list[tuple[tuple[str, str], int, str, bool]]                    # (ns, seq, domain, declared)
    blocks: dict[str, tuple[tuple[str, str], int, int, int, int, int]]    # cable → (ns, seq, local, bp, ch, size)
    alarms: dict[str, tuple[tuple[str, str], int, int, int, int]]         # tag key → (ns, seq, local, bp, ch)
    spares: dict[tuple[str, int], str]                                    # (cable, pair) → IO type of the wired spare
    slots: dict[str, Slot]                                                # tag key → previous slot (Field / Cabinet Alarm)
    by_id: dict[str, Slot]                                                # slot id → previous slot
    live: int                                                             # previous live signals


@dataclass
class Allocation:
    cabinets: list[CabinetInfo]
    slots: list[Slot]
    blocks: list[Block]
    cabs: list[Cab]
    unplaced: list[Signal]
    method: str = "greedy"


class Engine:
    def __init__(self, signals: list[Signal], rules: Rules, settings: ProjectSettings, book: TQBook,
                 exceptions: dict[str, str] | None = None, baseline: Baseline | None = None):
        self.signals = signals
        self.rules = rules
        self.settings = settings
        self.book = book
        self.exceptions = exceptions or {}
        self.baseline = baseline
        cc = rules.params("cable_contiguous")
        self.g = Geometry(settings.ciocs_per_cabinet, settings.baseplates_per_cioc, settings.channels_per_baseplate,
                          int(cc.get("whole_baseplate_min_pairs", settings.channels_per_baseplate)) if cc else 10 ** 6,
                          tuple(r.id for r in rules.all("segregate") if seg_level(r) == "baseplate"))
        self.strategy = rules.cioc_strategy
        self.names = rules.params("naming_pattern")
        self.patterns = self.names.get("patterns", {})
        from engine.custom import CustomPlan
        self.custom = CustomPlan(rules.rs, signals, book, lambda cab: self.name("marshalling", cab), settings.channels_per_baseplate)
        self.g.custom = self.custom if (self.custom.bp_rules or self.custom.same_bp_rules) else None
        self.cabs: list[Cab] = []
        self.blocks: list[Block] = []
        self.unplaced: list[Signal] = []
        self.alarm_ovf: dict[tuple, dict] = {}   # (namespace, cabinet seq) → extra alarm baseplates and unplaced alarms
        self.by_row = {s.row: s for s in signals}
        self.dorder: dict[str, int] = {}
        self.deleted_pairs = {(s.cable, s.pair): s for s in signals if not s.live and s.cable and s.pair}

    # ── segregation (any number of rules; the A/B one — rules.primary_seg — also drives the family colouring) ──
    @property
    def seg_rules(self):
        return self.rules.all("segregate")

    @staticmethod
    def fam_in(rule, s: Signal) -> str | None:
        return seg_family(rule, seg_value(s, seg_field(rule)))

    @staticmethod
    def scope(rule, local: int) -> int:
        return 0 if seg_level(rule) == "cabinet" else local

    def locked_rules(self) -> dict:
        """Segregate rules enforced by CIOC/cabinet locks (baseplate-level ones are enforced inside layout())."""
        return {r.id: r for r in self.seg_rules if seg_level(r) != "baseplate"}

    # ── naming helpers ──
    def side(self, local: int) -> str:
        sides = self.names.get("sides") or {}
        return sides.get(str(local)) or ("F" if local <= (self.g.ciocs + 1) // 2 else "R")

    def cioc_seq(self, cab: Cab, local: int) -> int:
        return (cab.seq - 1) * self.g.ciocs + local

    def tokens(self, cab: Cab, local: int | None = None, bp: int | None = None, ch: int | None = None) -> dict:
        loc, area = cab.ns
        area4 = derive(self.names.get("derive", {}).get("area4"), area) or area[:4]
        t = dict(loc=loc, area=area, area4=area4, ctrl2=f"{cab.controller_seq:02d}", cab2=f"{cab.seq:02d}",
                 seq2=f"{cab.seq:02d}")
        if local is not None:
            t.update(cioc3=f"{self.cioc_seq(cab, local):03d}", side=self.side(local), local=local)
        if bp is not None:
            t["bp"] = bp
        if ch is not None:
            t["ch"] = ch
        t["dcm"] = fmt(self.patterns.get("marshalling", "{loc}-DCM-{area}-{cab2}"), **t)
        return t

    def name(self, kind: str, cab: Cab, local: int | None = None, bp: int | None = None, ch: int | None = None) -> str:
        defaults = {"system_cabinet": "{loc}-DCS-{area}-{ctrl2}", "controller": "{loc}DPK{area4}{ctrl2}",
                    "marshalling": "{loc}-DCM-{area}-{cab2}", "cioc": "{loc}DCIOC{area4}{cioc3}",
                    "baseplate": "{cioc3}-CBP-{bp}", "wired_spare": "{area4}DSP{ctrl2}{cioc3}{bp}{ch}",
                    "visualization": "{dcm}({side})"}
        return fmt(self.patterns.get(kind, defaults[kind]), **self.tokens(cab, local, bp, ch))

    # ── cabinets ──
    def new_cab(self, domain: str, ns: tuple[str, str], seq: int | None = None, declared: bool = False) -> Cab:
        if seq is None:
            used = [c.seq for c in self.cabs if c.ns == ns]
            seq = max(used, default=0) + 1
        cab = Cab(seq=seq, ns=ns, domain=domain, declared=declared, dorder=self.dorder.get(domain, 0))
        self.reserve(cab)
        self.cabs.append(cab)
        self.renumber_controllers(ns)
        return cab

    def renumber_controllers(self, ns: tuple[str, str]) -> None:
        per = max(1, self.settings.max_cabinets_per_controller)
        for i, c in enumerate(sorted([c for c in self.cabs if c.ns == ns], key=lambda c: c.seq)):
            c.controller_seq = i // per + 1

    def reserve(self, cab: Cab) -> None:
        g = self.g
        alarm = self.rules.first("reserve_baseplate")
        if alarm:
            cab.reserved[(int(alarm.params.get("cioc", 1)), int(alarm.params.get("baseplate", 1)))] = "cabinet_alarm"
        fut = self.rules.first("future_spare_pct")
        if fut:
            total = g.ciocs * g.bps
            pct = float(fut.params.get("pct", 10))
            n = math.ceil(total * pct / 100 - 1e-9) if fut.params.get("rounding", "ceil") == "ceil" else round(total * pct / 100)
            n = min(n, total - 1)
            order = [(c, b) for c in range(g.ciocs, 0, -1) for b in range(g.bps, 0, -1)]
            for key in order:
                if n <= 0:
                    break
                if key not in cab.reserved:
                    cab.reserved[key] = "future"
                    n -= 1

    def usable(self, cab: Cab, local: int) -> list[int]:
        return [bp for bp in range(1, self.g.bps + 1) if (local, bp) not in cab.reserved]

    def cap_units(self, cab: Cab, local: int) -> int:
        """Channels a CIOC offers to field cables (reserved baseplates excluded)."""
        return len(self.usable(cab, local)) * self.g.chs

    def load_units(self, cab: Cab, local: int) -> int:
        return sum(b.foot for b in cab.blocks.get(local, []))

    def fill_permille(self, cab: Cab, local: int) -> int:
        cap = self.cap_units(cab, local)
        return math.ceil(1000 * self.load_units(cab, local) / cap) if cap else 0

    def instantiated(self, cab: Cab) -> list[int]:
        """CIOC positions that exist in the output. balanced: all of them; compact: only those holding signals."""
        if self.strategy != "compact":
            return list(range(1, self.g.ciocs + 1))
        alarm = self.rules.first("reserve_baseplate")
        alarm_local = int(alarm.params.get("cioc", 1)) if alarm else None
        return [l for l in range(1, self.g.ciocs + 1) if cab.blocks.get(l) or (cab.alarms and l == alarm_local)]

    # ── blocks ──
    def build_blocks(self, live: list[Signal]) -> list[Block]:
        group_rank: dict[str, int] = {}
        for s in sorted(live, key=lambda s: s.row):
            if s.group not in ("", "-") and s.group not in group_rank:
                group_rank[s.group] = len(group_rank)
        by_cable: dict[tuple[str, str], list[Signal]] = defaultdict(list)
        for s in live:
            if s.kind == "field":
                by_cable[(s.domain, s.cable)].append(s)
        blocks = []
        for (domain, cable), sigs in by_cable.items():
            size = max(s.cable_size or 0 for s in sigs) or max(s.pair or 1 for s in sigs)
            span, foot = footprint(size, self.g)
            fams = {s.family for s in sigs} - {"-"}
            family = "A" if "A" in fams else ("B" if "B" in fams else "-")
            groups = Counter(s.group for s in sigs if s.group not in ("", "-"))
            group = min(groups, key=lambda gname: (-groups[gname], group_rank[gname])) if groups else "-"
            b = Block(id=cable, cable=cable, size=size, span=span, foot=foot,
                      members={s.pair: s for s in sigs if s.pair}, family=family, group=group,
                      group_rank=group_rank.get(group, 10 ** 6), domain=domain,
                      first_row=min(s.row for s in sigs), exception_tq=self.exceptions.get(cable))
            primary = self.rules.primary_seg
            if primary is not None and seg_level(primary) != "cioc" and family != "-":
                b.fams[primary.id] = family
            for rule in self.seg_rules:
                if rule is primary:
                    continue
                count = Counter(f for f in (self.fam_in(rule, s) for s in sigs) if f)
                found = sorted(count)
                dominant = min(found, key=lambda f: (-count[f], f)) if found else None   # most signals; ties → alphabetical
                if found:
                    b.fams[rule.id] = dominant  # type: ignore[assignment]
                if len(found) > 1:
                    b.fam_exceptions[rule.id] = self.book.add("segregation", "Segregation clash on one cable", "high",
                                  f"Cable {cable} carries {' and '.join(found)} signals — rule {rule.id} ({rule.label}) cannot be met "
                                  f"for this cable; placed with the {dominant} family (the one most of its signals have). "
                                  f"Fix: re-tag or split the cable.",
                                  rows=[s.row for s in sigs], tags=[s.tag for s in sigs], rules=[rule.id],
                                  key=f"segclash:{rule.id}:{cable}").id
            blocks.append(b)
        return sorted(blocks, key=lambda b: (b.domain, b.sort_key))

    # ── cabinet planning per domain ──
    def plan_domain_cabinets(self, domain: str, ns: tuple[str, str], alarms: list[Signal]) -> list[Cab]:
        seq_rx = self.names.get("derive", {}).get("cabinet_seq")
        for s in alarms:
            seq = derive(seq_rx, s.equipment)
            if seq and seq.isascii() and seq.isdigit():
                if not any(c.ns == ns and c.seq == int(seq) for c in self.cabs):
                    self.new_cab(domain, ns, int(seq), declared=True)
        if not [c for c in self.cabs if c.ns == ns and c.domain == domain]:
            self.new_cab(domain, ns)
        return sorted([c for c in self.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)

    def compatible(self, cab: Cab, local: int, b: Block) -> bool:
        primary = self.rules.primary_seg
        if primary and b.family != "-" and seg_level(primary) == "cioc" and cab.family.get(local) not in (None, b.family):
            return False
        rules = self.locked_rules()
        if not all(cab.locks.get((rid, self.scope(rules[rid], local))) in (None, f) for rid, f in b.fams.items() if rid in rules):
            return False
        return self.custom_conflict(cab, local, b) is None

    def custom_conflict(self, cab: Cab, local: int, b: Block):
        """(message, rule id, other cables) when a hard custom rule forbids block `b` on this CIOC, else None."""
        if not self.custom.cab_rules:
            return None
        return self.custom.conflict(cab, local, b, [c for c in self.cabs if c.ns == cab.ns and c.domain == cab.domain])

    def fits(self, cab: Cab, local: int, b: Block) -> bool:
        return layout(cab.blocks[local] + [b], self.usable(cab, local), self.g) is not None

    def commit(self, cab: Cab, local: int, b: Block) -> None:
        cab.blocks[local].append(b)
        b.cab, b.cioc = cab, local
        if b.family != "-":
            cab.family.setdefault(local, b.family)
            if cab.family[local] is None:
                cab.family[local] = b.family
        rules = self.locked_rules()
        for rid, f in b.fams.items():
            if rid in rules:
                cab.locks.setdefault((rid, self.scope(rules[rid], local)), f)

    def fits_fresh(self, b: Block) -> bool:
        probe = Cab(seq=1, ns=("", ""), domain="")
        self.reserve(probe)
        return any(layout([b], self.usable(probe, l), self.g) is not None for l in range(1, self.g.ciocs + 1))

    def assign_greedy(self, domain: str, ns: tuple[str, str], blocks: list[Block]) -> None:
        """Next-fit along the physical CIOC sequence; never goes back (keeps groups in sequence)."""
        cursor = 0
        for b in blocks:
            if b.pinned:
                continue
            if not self.fits_fresh(b):
                t = self.book.add("capacity", "Cable too large", "high",
                                  f"Cable {b.cable} ({b.size} pairs) cannot fit in one CIOC "
                                  f"({self.g.bps} baseplates × {self.g.chs} channels, reserved baseplates excluded) — rule "
                                  f"{self.rules.rid('capacity') or 'r-capacity'} cannot be met; not allocated. "
                                  f"Fix: split the cable or enlarge the CIOC in Project Settings.",
                                  rows=[s.row for s in b.members.values()], tags=[s.tag for s in b.members.values()],
                                  rules=[self.rules.rid("capacity") or "r-capacity"])
                for s in b.members.values():
                    self.book.quarantine_signal(s, "cable larger than a CIOC", t)
                    self.unplaced.append(s)
                continue
            while True:
                cabs = sorted([c for c in self.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)
                seq = [(c, l) for c in cabs for l in range(1, self.g.ciocs + 1)]
                hit = next(((i, c, l) for i, (c, l) in enumerate(seq) if i >= cursor
                            and self.compatible(c, l, b) and self.fits(c, l, b)), None)
                if hit:
                    cursor, c, l = hit
                    self.commit(c, l, b)
                    break
                if len(cabs) >= self.settings.max_cabinets_per_domain:
                    t = self.book.add("capacity", "Cabinet capacity", "high",
                                      f"Domain {domain} is capped at {self.settings.max_cabinets_per_domain} cabinet(s) and every CIOC is "
                                      f"full or segregated away from cable {b.cable} — rule {self.rules.rid('capacity') or 'r-capacity'} "
                                      f"(capacity) cannot be met; not allocated. Raise the cap or free capacity.",
                                      rows=[s.row for s in b.members.values()], tags=[s.tag for s in b.members.values()],
                                      rules=[self.rules.rid("capacity") or "r-capacity"], key=f"cap:{domain}")
                    for s in b.members.values():
                        self.book.quarantine_signal(s, "no capacity left in the domain", t)
                        self.unplaced.append(s)
                    break
                self.new_cab(domain, ns)

    def assign_balanced(self, domain: str, ns: tuple[str, str], blocks: list[Block]) -> None:
        """Compact next-fit first decides how many cabinets the domain needs (and raises any capacity TQ); then every
        unpinned block is re-spread over ALL CIOCs of those cabinets — still in sequence, A and B apart — with the
        lowest per-CIOC fill ceiling that lays out (binary search). Never worse than compact: if no ceiling below 100%
        works, the compact assignment stands."""
        self.assign_greedy(domain, ns, blocks)
        free = sorted([b for b in blocks if b.cab is not None and not b.pinned], key=lambda b: b.sort_key)
        if not free:
            return
        cabs = sorted([c for c in self.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)
        seq = [(c, l) for c in cabs for l in range(1, self.g.ciocs + 1)]
        before = [(b, b.cab, b.cioc) for b in free]
        pinned = [(c, l, b) for c in cabs for l, bl in sorted(c.blocks.items()) for b in bl if b.pinned]

        def reset() -> None:
            for c in cabs:
                c.blocks.clear()
                c.family.clear()
                c.family.update(c.alarm_lock)
                c.locks.clear()
            for b in free:
                b.cab, b.cioc = None, None
            for c, l, b in pinned:
                self.commit(c, l, b)

        def spread(ceiling: int) -> bool:
            reset()
            i = 0
            for b in free:
                while i < len(seq):
                    c, l = seq[i]
                    load = self.load_units(c, l)
                    if (self.compatible(c, l, b) and (load == 0 or 1000 * (load + b.foot) <= ceiling * self.cap_units(c, l))
                            and self.fits(c, l, b)):
                        self.commit(c, l, b)
                        break
                    i += 1
                else:
                    return False
            return True

        lo, hi = 0, 1000
        if spread(hi):
            while lo < hi:
                mid = (lo + hi) // 2
                if spread(mid):
                    hi = mid
                else:
                    lo = mid + 1
            if spread(hi):
                return
        reset()  # nothing better than compact (cannot happen in practice): restore it exactly
        for b, c, l in before:
            self.commit(c, l, b)

    # ── alarms ──
    def place_alarms(self, domain: str, ns: tuple[str, str], alarms: list[Signal]) -> None:
        cabs = sorted([c for c in self.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)
        if not cabs:
            return
        rule = self.rules.first("reserve_baseplate")
        seq_rx = self.names.get("derive", {}).get("cabinet_seq")
        for s in sorted(alarms, key=lambda s: s.row):
            target = None
            dcm = derive(seq_rx, s.equipment)
            if dcm and dcm.isascii() and dcm.isdigit():
                target = next((c for c in cabs if c.seq == int(dcm)), None)
                if target:
                    target.alarm_why[s.row] = f"Equipment {s.equipment} is this marshalling cabinet"
            else:
                m = re.search(r"-(\d+)\s*$", s.equipment or "")
                if m and re.search(r"-DCS-", s.equipment or "", re.I):
                    ctrl = int(m.group(1))
                    target = next((c for c in cabs if c.controller_seq == ctrl), None)
                    if target:
                        target.alarm_why[s.row] = f"Equipment {s.equipment} is the system cabinet of controller {ctrl:02d} → its first marshalling cabinet"
            if target is None:
                target = cabs[0]
                target.alarm_why[s.row] = "No cabinet named in Equipment — first cabinet of the domain"
                self.book.add("data", "Cabinet alarm target", "low",
                              f"Cabinet alarm {s.tag} does not name a known cabinet ('{s.equipment}') — placed in {self.name('marshalling', target)}.",
                              rows=[s.row], tags=[s.tag], rules=[rule.id if rule else "r-alarm-bp"], confidence="candidate",
                              key=f"alarmtarget:{domain}")
            target.alarms.append(s)
        for cab in cabs:
            self.pack_alarms(cab)

    def alarm_overflow(self, cab: Cab, rule, extra_bp: int | None = None, lost: list[Signal] = ()) -> TQ:
        """ONE "Cabinet alarm overflow" TQ per cabinet, however many extra baseplates it reserved or alarms it could not
        place: the message names every extra baseplate and the rows/tags are the locations that were not allocated."""
        st = self.alarm_ovf.setdefault((cab.ns, cab.seq), {"bps": set(), "lost": []})
        if extra_bp is not None:
            st["bps"].add(extra_bp)
        st["lost"].extend(lost)
        name = self.name("marshalling", cab)
        bps = sorted(st["bps"])
        more = (f"baseplate{'s' if len(bps) > 1 else ''} {', '.join(map(str, bps))} also reserved" if bps else "")
        n = len({s.row for s in st["lost"]})
        if n:
            msg = (f"No room left for cabinet alarms in {name} — {n} alarm{'s' if n > 1 else ''} not allocated"
                   + (f"; {more}" if more else "") + ".")
        else:
            msg = f"More cabinet alarms than one baseplate in {name} — {more}."
        t = self.book.add("capacity", "Cabinet alarm overflow", "high" if n else "low", msg,
                          rows=[s.row for s in st["lost"]], tags=[s.tag for s in st["lost"]], rules=[rule.id],
                          key=f"alarmovf:{cab.ns}:{cab.seq}")
        t.message, t.severity = msg, "high" if n else "low"
        return t

    def pack_alarms(self, cab: Cab) -> None:
        """Give each cabinet alarm a channel on the reserved baseplate(s) — BEFORE field cables are assigned,
        so an overflow baseplate is reserved while it is still empty. Alarm cables keep their pairs contiguous."""
        rule = self.rules.first("reserve_baseplate")
        if not rule or not cab.alarms:
            return
        g = self.g
        local, bp0 = int(rule.params.get("cioc", 1)), int(rule.params.get("baseplate", 1))
        units: dict[str, list[Signal]] = defaultdict(list)
        for s in sorted(cab.alarms, key=lambda s: s.row):
            units[s.cable if (s.cable and s.cable_size and s.pair) else f"__{s.row}"].append(s)
        occupied: dict[int, set[int]] = defaultdict(set)
        keep: list[Signal] = []
        pending: list[tuple[str, list[Signal]]] = []
        for key, group in units.items():
            fixed = None
            if self.baseline:  # a revision keeps every cabinet alarm on its previous channel
                prev = [self.baseline.alarms.get(s.tag_key) for s in group]
                if all(p and p[0] == cab.ns and p[1] == cab.seq and p[2] == local for p in prev):
                    chans = [(p[3], p[4]) for p in prev]  # type: ignore[index]
                    if all(cab.reserved.get((local, b)) in (None, "cabinet_alarm") and c not in occupied[b] for b, c in chans):
                        fixed = chans
            if fixed:
                for s, (b, c) in zip(group, fixed):
                    occupied[b].add(c)
                    cab.reserved[(local, b)] = "cabinet_alarm"
                    cab.alarm_pos[s.row] = (b, c)
                    keep.append(s)
            else:
                pending.append((key, group))
        for key, group in pending:
            cabled = not key.startswith("__")
            width = max(s.pair for s in group) if cabled else 1  # type: ignore[type-var]
            spot = None
            b = bp0
            while b <= g.bps and spot is None:
                if cab.reserved.get((local, b)) not in (None, "cabinet_alarm"):
                    break
                for c0 in range(1, g.chs - width + 2):
                    if all(c not in occupied[b] for c in range(c0, c0 + width)):
                        spot = (b, c0)
                        break
                if spot is None:
                    b += 1
            if spot is None:
                t = self.alarm_overflow(cab, rule, lost=group)
                for s in group:
                    self.book.quarantine_signal(s, "no room on the cabinet-alarm baseplates", t)
                    self.unplaced.append(s)
                continue
            b, c0 = spot
            if b != bp0 and cab.reserved.get((local, b)) is None:
                self.alarm_overflow(cab, rule, extra_bp=b)
            cab.reserved[(local, b)] = "cabinet_alarm"
            for s in group:
                c = c0 + ((s.pair or 1) - 1 if cabled else 0)
                occupied[b].add(c)
                cab.alarm_pos[s.row] = (b, c)
                keep.append(s)
            if cabled:
                occupied[b].update(range(c0, c0 + width))
        cab.alarms = keep
        counts = Counter(s.family for s in keep if s.family in ("A", "B"))
        fams = set(counts)
        if fams and self.rules.primary_seg:
            minority = min(("A", "B"), key=lambda f: (counts[f], f != "B"))
            cab.family[local] = ("A" if minority == "B" else "B") if fams == {"A", "B"} else next(iter(fams))
            cab.alarm_lock[local] = cab.family[local]
            cab.alarm_minority = minority
            if fams == {"A", "B"}:
                t = self.book.add("segregation", "A/B cabinet alarms", "medium",
                                  f"Cabinet alarms of both A and B families in {self.name('marshalling', cab)} share the reserved "
                                  f"baseplate — the {minority} alarms are kept there as a TQ-covered exception. Fix: re-tag the alarms.",
                                  rows=[s.row for s in keep], tags=[s.tag for s in keep if s.family == minority],
                                  rules=[self.rules.ab_rid or "r-ab", rule.id])
                cab.alarm_exception = t.id

    @staticmethod
    def alarm_remark(rule, s: Signal) -> str:
        """`remarks` is a string (every alarm) or a first-match table [{when, value}] over the signal's fields."""
        r = rule.params.get("remarks", "-")
        if isinstance(r, list):
            hit = first_match(r, signal_ctx(s))
            return str(hit.get("value", "-")) if hit else "-"
        return str(r)

    # ── revisions ──
    def pin_blocks(self, domain: str, blocks: list[Block]) -> None:
        """Freeze every cable that existed before at its exact position — unless a hard rule now forbids it,
        in which case it is left unpinned (the engine moves it) and the reason is recorded."""
        assert self.baseline is not None
        seg = self.rules.ab_rid or "r-ab"
        for b in sorted(blocks, key=lambda b: b.sort_key):
            pos = self.baseline.blocks.get(b.cable)
            if not pos:
                continue
            bns, seq, local, bp, ch, size = pos
            cab = next((c for c in self.cabs if c.ns == bns and c.seq == seq), None)
            b.pin_pos = (seq, local, bp, ch)
            reason = None
            if cab is None or cab.domain != domain:
                reason = "its cabinet is no longer in this controller domain"
            elif size != b.size:
                reason = f"cable size changed from {size} to {b.size} pairs"
            else:
                bps = range(bp, bp + max(1, b.span))
                res = [(x, cab.reserved[(local, x)]) for x in bps if (local, x) in cab.reserved]
                if res:
                    rid = self.rules.rid("future_spare_pct") if res[0][1] == "future" else self.rules.rid("reserve_baseplate")
                    reason = f"baseplate {res[0][0]} is now reserved ({res[0][1].replace('_', ' ')}, rule {rid})"
                elif not self.compatible(cab, local, b):
                    custom = self.custom_conflict(cab, local, b)
                    if custom is not None:
                        reason = f"{custom[0]}"
                    elif b.family != "-" and cab.family.get(local) not in (None, b.family):
                        reason = (f"the cable is now {b.family}-family but CIOC {self.cioc_seq(cab, local):03d} holds "
                                  f"{cab.family[local]}-family signals (rule {seg})")
                    else:
                        locked = self.locked_rules()
                        rid = next(r for r, f in b.fams.items()
                                   if r in locked and cab.locks.get((r, self.scope(locked[r], local))) not in (None, f))
                        reason = f"its segregation family under rule {rid} now clashes with its neighbours"
                else:
                    b.pinned = True
                    if layout(cab.blocks[local] + [b], self.usable(cab, local), self.g) is None:
                        b.pinned = False
                        reason = ("its previous position now overlaps another cable or mixes segregation families on a "
                                  "baseplate" + (f" (rule {', '.join(self.g.bp_seg)})" if self.g.bp_seg else ""))
            if reason:
                b.pinned = False
                b.move_reason = reason
            else:
                self.commit(cab, local, b)  # type: ignore[arg-type]

    def drop_unfittable(self, cab: Cab, local: int, bl: list[Block]) -> None:
        """Remove the last unpinned block (else the last block) of a CIOC whose blocks cannot all be laid out, and
        quarantine its signals with a TQ that names the rules and the CIOC."""
        victim = next((b for b in sorted(bl, key=lambda b: b.sort_key, reverse=True) if not b.pinned), bl[-1])
        bl.remove(victim)
        victim.cab, victim.cioc = None, None
        rids = [self.rules.rid("capacity") or "r-capacity", self.rules.rid("cable_contiguous") or "r-cable", *self.g.bp_seg]
        t = self.book.add("capacity", "Unsatisfiable layout", "high",
                          f"Cable {victim.cable} ({victim.size} pairs) cannot be laid out on CIOC {self.cioc_seq(cab, local):03d} of "
                          f"{self.name('marshalling', cab)} together with the other cables assigned to it: rules {', '.join(rids)} "
                          f"(capacity, contiguous pairs, baseplate segregation) cannot all be met — not allocated; everything "
                          f"else is placed. Fix: split the cable, relax a rule or raise capacity.",
                          rows=[x.row for x in victim.members.values()], tags=[x.tag for x in victim.members.values()],
                          rules=rids, key=f"nolayout:{victim.cable}")
        for x in victim.members.values():
            self.book.quarantine_signal(x, "no feasible layout for its cable", t)
            self.unplaced.append(x)

    # ── run ──
    def run(self, assign: Callable[["Engine", str, tuple[str, str], list[Block]], None] | None = None) -> Allocation:
        """Any unexpected error is re-raised as EngineFailure(stage, domain) so the pipeline can isolate that domain."""
        self.ctx: tuple[str, str | None] = ("allocate", None)
        try:
            return self._run(assign)
        except EngineFailure:
            raise
        except Exception as e:
            raise EngineFailure(*self.ctx, e) from e

    def _run(self, assign: Callable[["Engine", str, tuple[str, str], list[Block]], None] | None = None) -> Allocation:
        live = [s for s in self.signals if s.live and not s.quarantined]
        domains: dict[str, list[Signal]] = defaultdict(list)
        for s in live:
            domains[s.domain].append(s)
        self.blocks = self.build_blocks(live)
        if self.custom.hard:
            self.ctx = ("allocate", None)
            self.custom.preflight(self.blocks, self.book, self.rules.rid("cable_contiguous"))
        ordered = sorted(domains, key=lambda d: min(s.row for s in domains[d]))
        self.dorder = {d: i for i, d in enumerate(ordered)}
        if self.baseline:  # a revision keeps every previous cabinet (same names, same numbering)
            for ns, seq, domain, declared in self.baseline.cabs:
                self.dorder.setdefault(domain, len(self.dorder))
                if not any(c.ns == ns and c.seq == seq for c in self.cabs):
                    self.new_cab(domain, ns, seq, declared)
        for domain in ordered:
            self.ctx = ("allocate", domain)
            sigs = domains[domain]
            ns = Counter((s.loc, s.area_code) for s in sigs).most_common(1)[0][0]
            alarms = [s for s in sigs if s.kind == "cabinet_alarm"] if self.rules.first("reserve_baseplate") else []
            self.plan_domain_cabinets(domain, ns, alarms)
            self.place_alarms(domain, ns, alarms)
            dblocks = [b for b in self.blocks if b.domain == domain]
            if self.baseline:
                self.pin_blocks(domain, dblocks)
            default = Engine.assign_balanced if self.strategy == "balanced" else Engine.assign_greedy
            (assign or default)(self, domain, ns, dblocks)
        for cab in self.cabs:
            self.ctx = ("layout", cab.domain)
            for local, bl in cab.blocks.items():
                pos = layout(bl, self.usable(cab, local), self.g)
                while pos is None and bl:  # an assignment that does not lay out: place what fits, TQ the rest
                    self.drop_unfittable(cab, local, bl)
                    pos = layout(bl, self.usable(cab, local), self.g)
                for b in bl:
                    b.bp, b.ch = (pos or {})[b.id]
        slots = self.fill()
        self.wired_spares(slots)
        if self.custom.hard:
            self.ctx = ("layout", None)
            self.custom.final_check(slots, self.by_row, self.book)
        cabinets = self.cabinet_infos(slots)
        return Allocation(cabinets=cabinets, slots=slots, blocks=self.blocks, cabs=self.cabs, unplaced=self.unplaced)

    # ── grid ──
    def base_slot(self, cab: Cab, local: int, bp: int, ch: int) -> Slot:
        cioc3 = self.cioc_seq(cab, local)
        charm, tb = spare_slot_hw(self.rules)
        cat = catalog()
        return Slot(
            id=f"{self.name('marshalling', cab)}/{cioc3:03d}/{bp}/{ch}", cabinet=self.name("marshalling", cab), cabinet_seq=cab.seq,
            system_cabinet=self.name("system_cabinet", cab), controller=self.name("controller", cab), controller_seq=cab.controller_seq,
            domain=cab.domain, cioc=self.name("cioc", cab, local), cioc_seq=cioc3, cioc_local=local, side=self.side(local),
            baseplate=self.name("baseplate", cab, local, bp), bp=bp, ch=ch, charm_no=(bp - 1) * self.g.chs + ch,
            status="Spare Slot", charm=charm, charm_desc=cat["charms"].get(charm, charm), tb=tb,
            tb_desc=cat["terminal_blocks"].get(tb, tb), reserved=cab.reserved.get((local, bp)),  # type: ignore[arg-type]
            revision=self.settings.revision,
        )

    def put_signal(self, slot: Slot, s: Signal, status: str, why: list[WhyStep]) -> None:
        hw = resolve(signal_ctx(s), self.rules)
        slot.status = status  # type: ignore[assignment]
        slot.tag, slot.tag_key, slot.io_type = s.tag, s.tag_key, s.io_type
        slot.family, slot.group = s.family, s.group  # type: ignore[assignment]
        slot.charm, slot.charm_desc, slot.tb, slot.tb_desc = hw.charm, hw.charm_desc, hw.tb, hw.tb_desc
        slot.tb1, slot.tb2, slot.tb3, slot.loop_typical = hw.tb1, hw.tb2, hw.tb3, hw.loop_typical
        slot.signal_type, slot.signal_level, slot.service = s.signal_type, s.signal_level, s.extra.get("service", "-")
        slot.instrument_type, slot.source_row, slot.old_tag = s.instrument_desc, s.row, s.extra.get("old_tag", "-")
        slot.why = why + [WhyStep(rule_id=r, text=t) for r, t in hw.why]

    def fill(self) -> list[Slot]:
        g = self.g
        slots: list[Slot] = []
        alarm_rule = self.rules.first("reserve_baseplate")
        for cab in sorted(self.cabs, key=lambda c: (c.dorder, c.ns, c.seq)):
            self.ctx = ("layout", cab.domain)
            locals_ = self.instantiated(cab)
            grid: dict[tuple[int, int, int], Slot] = {}
            for local in locals_:
                for bp in range(1, g.bps + 1):
                    for ch in range(1, g.chs + 1):
                        grid[(local, bp, ch)] = self.base_slot(cab, local, bp, ch)
            # field cable blocks
            for local, bl in cab.blocks.items():
                for b in bl:
                    fam_txt = {"A": "A-family", "B": "B-family"}.get(b.family, "neutral")
                    for pair in range(1, b.size + 1):
                        bp, ch = b.pos(pair)
                        slot = grid[(local, bp, ch)]
                        slot.cable, slot.cable_spec, slot.cable_size = b.cable, "-", b.size
                        slot.pair, slot.block_id = pair, b.id
                        s = b.members.get(pair)
                        slot.pair_label = s.pair_label if s else f"Pair {pair}"
                        if s:
                            slot.cable_spec = s.cable_spec
                        else:
                            sp = next(iter(b.members.values()))
                            slot.cable_spec = sp.cable_spec
                        if s is None:
                            gone = self.deleted_pairs.get((b.cable, pair))
                            if gone:
                                slot.remarks = "Tag Deleted"
                            slot.why = [WhyStep(rule_id=self.rules.rid("cable_contiguous"),
                                                text=f"Unused pair {pair} of {b.cable} — position kept with its cable"
                                                     + (f" (was {gone.tag}, deleted)" if gone else ""))]
                            continue
                        why = [
                            WhyStep(rule_id=None, text=f"Controller domain {cab.domain} → {slot.controller}"),
                            WhyStep(rule_id=self.rules.ab_rid,
                                    text=f"Cable is {fam_txt} (group {b.group}) → CIOC {slot.cioc_seq:03d}"
                                         + (f" locked to {b.family}" if b.family != "-" else " (neutral can share any CIOC)")),
                            WhyStep(rule_id=self.rules.rid("group_together"),
                                    text=f"Sequence: family {b.family}, group '{b.group}', {b.size}-pair, cable {b.cable}"),
                            WhyStep(rule_id=self.rules.rid("cable_contiguous"),
                                    text=(f"{b.size}-pair cable takes {b.span} whole baseplate(s) from BP {b.bp} ch 1"
                                          if b.span else f"{b.size}-pair cable packed in BP {b.bp} ch {b.ch}–{b.ch + b.foot - 1}")
                                         + f"; pair {pair} → BP {bp} ch {ch}"),
                        ]
                        for rid in self.g.bp_seg:
                            if rid in b.fams:
                                why.append(WhyStep(rule_id=rid, text=f"{b.fams[rid]} cable → baseplate {b.bp} holds only "
                                                                    f"{b.fams[rid]} signals"))
                        if s.io_type_raw.upper() != s.io_type:
                            why.insert(0, WhyStep(rule_id=self.rules.rid("io_type_map"), text=f"IO type {s.io_type_raw} → {s.io_type}"))
                        if b.exception_tq and s.family == "B":
                            slot.tq_ids.append(b.exception_tq)
                            slot.remarks = f"Excepted by {b.exception_tq}: A/B on one cable"
                            why.append(WhyStep(rule_id=self.rules.ab_rid,
                                               text=f"A/B clash on {b.cable} — placed on an A CIOC, covered by {b.exception_tq}"))
                        for rid, tq_id in b.fam_exceptions.items():
                            rule = next((r for r in self.seg_rules if r.id == rid), None)
                            if rule and self.fam_in(rule, s) not in (None, b.fams.get(rid)):
                                slot.tq_ids.append(tq_id)
                                slot.remarks = f"Excepted by {tq_id}: segregation clash on one cable"
                        remarks = slot.remarks
                        self.put_signal(slot, s, "Field", why)
                        slot.remarks = remarks
            # cabinet alarms (positions packed before field assignment; see pack_alarms)
            if cab.alarms and alarm_rule:
                local = int(alarm_rule.params.get("cioc", 1))
                for s in cab.alarms:
                    bp, c = cab.alarm_pos[s.row]
                    slot = grid[(local, bp, c)]
                    slot.reserved = "cabinet_alarm"
                    if s.cable and s.cable_size and s.pair:
                        slot.cable, slot.cable_spec, slot.cable_size = s.cable, s.cable_spec, s.cable_size
                        slot.pair, slot.pair_label = s.pair, s.pair_label
                    self.put_signal(slot, s, "Cabinet Alarm", [
                        WhyStep(rule_id=alarm_rule.id, text=f"Internal cabinet signal → reserved BP {bp} of CIOC {local}"),
                        WhyStep(rule_id=alarm_rule.id, text=cab.alarm_why.get(s.row, "")),
                    ])
                    slot.remarks = self.alarm_remark(alarm_rule, s)
                    if cab.alarm_exception and s.family == cab.alarm_minority:
                        slot.tq_ids.append(cab.alarm_exception)
                        slot.remarks = f"Excepted by {cab.alarm_exception}: A/B cabinet alarms"
            for local in locals_:
                for bp in range(1, g.bps + 1):
                    for ch in range(1, g.chs + 1):
                        slot = grid[(local, bp, ch)]
                        if slot.status == "Spare Slot" and not slot.why:
                            r = slot.reserved
                            slot.why = [WhyStep(rule_id=self.rules.rid("future_spare_pct") if r == "future" else
                                                (self.rules.rid("reserve_baseplate") if r == "cabinet_alarm" else None),
                                                text={"future": "Baseplate reserved for future expansion",
                                                      "cabinet_alarm": "Reserved cabinet-alarm baseplate (unused channel)"}.get(
                                                    r or "", "No cable on this channel"))]
                        slots.append(slot)
        return slots

    # ── wired spares ──
    def spare_model(self, b: Block, io: str) -> Signal:
        """The member a wired spare copies (hardware, IS status, …): the lowest pair of that IO type, preferring members
        that are NOT a TQ-excepted segregation clash, so a spare pair carries the family its cable was placed with."""
        rules = {r.id: r for r in self.seg_rules}

        def off(m: Signal) -> int:
            n = sum(1 for rid, f in b.fams.items() if rid in b.fam_exceptions and rid in rules and self.fam_in(rules[rid], m) != f)
            return n + (1 if b.exception_tq and m.family == "B" else 0)

        return min((m for m in b.members.values() if m.io_type == io), key=lambda m: (off(m) > 0, m.pair or 0))

    def wired_spares(self, slots: list[Slot]) -> None:
        rule = self.rules.first("wired_spare_pct")
        extras = any(r.type == "extra_spares" for r in self.custom.rules)
        if not rule and not extras:
            return
        if not rule:       # extra spares on their own: the global percentage is off
            from app.schemas import Rule
            rule = Rule(id="r-extra-spares", type="wired_spare_pct", label="Extra wired spares", params={"pct": 0})
        pct = float(rule.params.get("pct", 10))
        by_ctrl: dict[str, list[Slot]] = defaultdict(list)
        for s in slots:
            by_ctrl[s.controller].append(s)
        io_order = self.rules.io_types()      # unknown types sort after these, alphabetically
        blocks_by_id = {b.id: b for b in self.blocks}
        for ctrl, cs in by_ctrl.items():
            self.ctx = ("layout", cs[0].domain)
            field = Counter(s.io_type for s in cs if s.status == "Field")
            cand: dict[str, list[Slot]] = defaultdict(list)  # block id → free pairs in pair order
            for s in sorted(cs, key=lambda s: (s.block_id or "", s.remarks == "Tag Deleted", s.pair or 0)):
                if s.status == "Spare Slot" and s.block_id and s.pair:
                    cand[s.block_id].append(s)
            used: set[str] = set()
            for io in sorted(field, key=lambda t: (io_order.index(t) if t in io_order else 99, t)):
                target = math.ceil(field[io] * pct / 100 - 1e-9) if rule.params.get("rounding", "ceil") == "ceil" else round(field[io] * pct / 100)
                target += self.custom.extra_target(io, field[io])
                if target <= 0:
                    continue
                got = 0
                if self.baseline:  # a revision keeps the previous wired spares first
                    for (cable, pair), sio in self.baseline.spares.items():
                        if got >= target or sio != io:
                            continue
                        slot = next((x for x in cand.get(cable, []) if x.pair == pair and x.id not in used), None)
                        b = blocks_by_id.get(cable)
                        if slot is None or b is None or not any(m.io_type == io for m in b.members.values()):
                            continue
                        used.add(slot.id)
                        tmpl = self.spare_model(b, io)
                        self.make_spare(slot, tmpl, io, ctrl, field[io], target, pct, got, rule.id, b, kept=True)
                        got += 1
                cables = []
                for bid, free in cand.items():
                    b = blocks_by_id[bid]
                    n_io = sum(1 for m in b.members.values() if m.io_type == io)
                    if n_io:
                        cables.append((-n_io, b.sort_key, bid))
                cables.sort()
                progress = True
                while got < target and progress:
                    progress = False
                    for _, _, bid in cables:
                        if got >= target:
                            break
                        free = [x for x in cand[bid] if x.id not in used]
                        if not free:
                            continue
                        slot = free[0]
                        used.add(slot.id)
                        b = blocks_by_id[bid]
                        tmpl = self.spare_model(b, io)
                        self.make_spare(slot, tmpl, io, ctrl, field[io], target, pct, got, rule.id, b)
                        got += 1
                        progress = True
                if got < target:
                    self.book.add("spare", "Wired spare shortfall", "medium",
                                  f"{ctrl} needs {target} {io} wired spare(s) ({pct:g}% of {field[io]}) but only {got} free pair(s) "
                                  f"exist on its {io} cables. Fix: lower the target, or add a cable with spare pairs.",
                                  field="Tag Status", rules=[rule.id],
                                  fixes=[{"label": f"Accept {got} {io} spare(s)"},
                                         {"label": f"Lower the wired spare target to {math.floor(100 * got / field[io]) if field[io] else 0}%",
                                          "rule_patch": {"rule_id": rule.id, "op": "set", "path": "pct",
                                                         "value": math.floor(100 * got / field[io]) if field[io] else 0}}],
                                  unchanged="No signal moves.", key=f"spare:{ctrl}:{io}")

    def make_spare(self, slot: Slot, tmpl: Signal, io: str, ctrl: str, n_field: int, target: int, pct: float, got: int,
                   rule_id: str, b: Block, kept: bool = False) -> None:
        slot.remarks = "-"
        self.put_signal(slot, tmpl, "Wired Spare", [
            WhyStep(rule_id=rule_id, text=f"{ctrl}: {n_field} {io} field signals → target {target} wired spare(s) ({pct:g}%)"),
            WhyStep(rule_id=rule_id, text=f"Unused pair {slot.pair} of {b.cable} (carries {io}) wired as spare #{got + 1}"
                                          + (" — kept from the previous revision" if kept else "")),
        ])
        cab = next(c for c in self.cabs if self.name("marshalling", c) == slot.cabinet)
        slot.tag = self.name("wired_spare", cab, slot.cioc_local, slot.bp, slot.ch)
        slot.tag_key = slot.tag
        slot.family, slot.group = "-", "-"  # type: ignore[assignment]
        slot.service = fmt(self.patterns.get("spare_service", "SPARE {io2}"), io2=io[:2])
        slot.instrument_type, slot.old_tag = "-", "-"

    # ── summaries ──
    def cabinet_infos(self, slots: list[Slot]) -> list[CabinetInfo]:
        out = []
        by_cab: dict[str, list[Slot]] = defaultdict(list)
        for s in slots:
            by_cab[s.cabinet].append(s)
        for cab in sorted(self.cabs, key=lambda c: (c.dorder, c.ns, c.seq)):
            locals_ = self.instantiated(cab)
            if not locals_:
                continue  # compact: a cabinet with no signal is not instantiated at all
            name = self.name("marshalling", cab)
            cs = by_cab[name]
            ciocs = []
            for local in locals_:
                ss = [s for s in cs if s.cioc_local == local]
                bps = []
                for bp in range(1, self.g.bps + 1):
                    b = [s for s in ss if s.bp == bp]
                    bps.append(BaseplateInfo(bp=bp, name=self.name("baseplate", cab, local, bp), reserved=cab.reserved.get((local, bp)),  # type: ignore[arg-type]
                                             used=sum(s.status in ("Field", "Cabinet Alarm") for s in b),
                                             wired_spares=sum(s.status == "Wired Spare" for s in b)))
                ciocs.append(CiocInfo(name=self.name("cioc", cab, local), seq=self.cioc_seq(cab, local), local=local,
                                      side=self.side(local), family=cab.family.get(local) or "-",  # type: ignore[arg-type]
                                      used=sum(s.status in ("Field", "Cabinet Alarm") for s in ss),
                                      wired_spares=sum(s.status == "Wired Spare" for s in ss),
                                      capacity=self.g.bps * self.g.chs, baseplates=bps))
            out.append(CabinetInfo(name=name, seq=cab.seq, system_cabinet=self.name("system_cabinet", cab),
                                   controller=self.name("controller", cab), controller_seq=cab.controller_seq, domain=cab.domain,
                                   loc=cab.ns[0], area_code=cab.ns[1], declared=cab.declared, ciocs=ciocs))
        return out
