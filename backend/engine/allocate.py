"""The allocation engine: pure, deterministic, explainable.

    partition by controller domain
    → cabinets (declared by cabinet-alarm rows, more opened on overflow)
    → reserve: cabinet-alarm baseplate + future-spare baseplates at the END of each cabinet
    → cable blocks sorted family → IO grouping (sequence) → size desc → cable no
    → assign each block to a CIOC (greedy next-fit; CP-SAT may replace this step)
    → deterministic layout inside each CIOC (no defragmentation, pinned blocks never move)
    → full grid: every slot of every cabinet → Field / Wired Spare / Spare Slot / Cabinet Alarm
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
    BaseplateInfo, CabinetInfo, CiocInfo, ProjectSettings, Signal, Slot, WhyStep,
)
from engine.hardware import resolve, signal_ctx, spare_slot_hw
from engine.rules import Rules, catalog, derive, fmt
from engine.tqs import TQBook

FAMILY_RANK = {"A": 0, "B": 1, "-": 2}


def natural(s: str) -> tuple:
    return tuple(int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s or ""))


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


@dataclass
class Geometry:
    ciocs: int
    bps: int
    chs: int
    whole_min: int

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

    def take(bp: int, ch: int, n: int) -> bool:
        if bp not in free or ch - 1 + n > g.chs or not all(free[bp][ch - 1:ch - 1 + n]):
            return False
        for i in range(ch - 1, ch - 1 + n):
            free[bp][i] = False
        return True

    for b in blocks:
        if b.pinned and b.pin_pos:
            _, _, bp, ch = b.pin_pos
            if b.span:
                if not all(take(bp + k, 1, g.chs) for k in range(b.span)):
                    return None
            elif not take(bp, ch, b.foot):
                return None
            out[b.id] = (bp, ch)
    rest = [b for b in blocks if not (b.pinned and b.pin_pos)]
    for b in [b for b in rest if b.span]:
        for i, bp in enumerate(usable):
            run = usable[i:i + b.span]
            if len(run) == b.span and run == list(range(bp, bp + b.span)) and all(all(free[x]) for x in run):
                for x in run:
                    take(x, 1, g.chs)
                out[b.id] = (bp, 1)
                break
        else:
            return None
    for b in sorted([b for b in rest if not b.span], key=lambda b: (-b.foot, b.sort_key)):
        done = False
        for bp in usable:
            for ch0 in range(0, g.chs - b.foot + 1, b.foot):
                if take(bp, ch0 + 1, b.foot):
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
class Allocation:
    cabinets: list[CabinetInfo]
    slots: list[Slot]
    blocks: list[Block]
    cabs: list[Cab]
    unplaced: list[Signal]
    method: str = "greedy"


class Engine:
    def __init__(self, signals: list[Signal], rules: Rules, settings: ProjectSettings, book: TQBook,
                 exceptions: dict[str, str] | None = None):
        self.signals = signals
        self.rules = rules
        self.settings = settings
        self.book = book
        self.exceptions = exceptions or {}
        cc = rules.params("cable_contiguous")
        self.g = Geometry(settings.ciocs_per_cabinet, settings.baseplates_per_cioc, settings.channels_per_baseplate,
                          int(cc.get("whole_baseplate_min_pairs", settings.channels_per_baseplate)) if cc else 10 ** 6)
        self.names = rules.params("naming_pattern")
        self.patterns = self.names.get("patterns", {})
        self.cabs: list[Cab] = []
        self.blocks: list[Block] = []
        self.unplaced: list[Signal] = []
        self.by_row = {s.row: s for s in signals}
        self.dorder: dict[str, int] = {}
        self.deleted_pairs = {(s.cable, s.pair): s for s in signals if not s.live and s.cable and s.pair}

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
            blocks.append(Block(id=cable, cable=cable, size=size, span=span, foot=foot,
                                members={s.pair: s for s in sigs if s.pair}, family=family, group=group,
                                group_rank=group_rank.get(group, 10 ** 6), domain=domain,
                                first_row=min(s.row for s in sigs), exception_tq=self.exceptions.get(cable)))
        return sorted(blocks, key=lambda b: (b.domain, b.sort_key))

    # ── cabinet planning per domain ──
    def plan_domain_cabinets(self, domain: str, ns: tuple[str, str], alarms: list[Signal]) -> list[Cab]:
        seq_rx = self.names.get("derive", {}).get("cabinet_seq")
        for s in alarms:
            seq = derive(seq_rx, s.equipment)
            if seq and seq.isdigit():
                if not any(c.ns == ns and c.seq == int(seq) for c in self.cabs):
                    self.new_cab(domain, ns, int(seq), declared=True)
        if not [c for c in self.cabs if c.ns == ns and c.domain == domain]:
            self.new_cab(domain, ns)
        return sorted([c for c in self.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)

    def compatible(self, cab: Cab, local: int, b: Block) -> bool:
        if b.family == "-" or not self.rules.first("segregate"):
            return True
        return cab.family.get(local) in (None, b.family)

    def fits(self, cab: Cab, local: int, b: Block) -> bool:
        return layout(cab.blocks[local] + [b], self.usable(cab, local), self.g) is not None

    def commit(self, cab: Cab, local: int, b: Block) -> None:
        cab.blocks[local].append(b)
        b.cab, b.cioc = cab, local
        if b.family != "-":
            cab.family.setdefault(local, b.family)
            if cab.family[local] is None:
                cab.family[local] = b.family

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
                                  f"({self.g.bps} baseplates × {self.g.chs} channels) — not allocated.",
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
                                      f"Domain {domain} is capped at {self.settings.max_cabinets_per_domain} cabinet(s) — "
                                      f"cable {b.cable} does not fit. Raise the cap or free capacity.",
                                      rows=[s.row for s in b.members.values()], tags=[s.tag for s in b.members.values()],
                                      rules=[self.rules.rid("capacity") or "r-capacity"], key=f"cap:{domain}")
                    for s in b.members.values():
                        self.book.quarantine_signal(s, "no capacity left in the domain", t)
                        self.unplaced.append(s)
                    break
                self.new_cab(domain, ns)

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
            if dcm and dcm.isdigit():
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

    def pack_alarms(self, cab: Cab) -> None:
        """Give each cabinet alarm a channel on the reserved baseplate(s) — BEFORE field cables are assigned,
        so an overflow baseplate is reserved while it is still empty. Alarm cables keep their pairs contiguous."""
        rule = self.rules.first("reserve_baseplate")
        if not rule or not cab.alarms:
            return
        g = self.g
        local, bp, ch = int(rule.params.get("cioc", 1)), int(rule.params.get("baseplate", 1)), 1
        units: dict[str, list[Signal]] = defaultdict(list)
        for s in sorted(cab.alarms, key=lambda s: s.row):
            units[s.cable if (s.cable and s.cable_size and s.pair) else f"__{s.row}"].append(s)
        keep: list[Signal] = []
        for key, group in units.items():
            cabled = not key.startswith("__")
            width = max(s.pair for s in group) if cabled else 1  # type: ignore[type-var]
            if ch + width - 1 > g.chs:
                bp, ch = bp + 1, 1
                if bp <= g.bps and cab.reserved.get((local, bp)) is None:
                    self.book.add("capacity", "Cabinet alarm overflow", "low",
                                  f"More cabinet alarms than one baseplate in {self.name('marshalling', cab)} — baseplate {bp} also reserved.",
                                  rules=[rule.id], key=f"alarmovf:{cab.ns}:{cab.seq}:{bp}")
            if bp > g.bps or cab.reserved.get((local, bp)) not in (None, "cabinet_alarm"):
                t = self.book.add("capacity", "Cabinet alarm overflow", "high",
                                  f"No room left for cabinet alarms in {self.name('marshalling', cab)} — not allocated.",
                                  rows=[s.row for s in group], tags=[s.tag for s in group], rules=[rule.id],
                                  key=f"alarmfull:{cab.ns}:{cab.seq}")
                for s in group:
                    self.book.quarantine_signal(s, "no room on the cabinet-alarm baseplates", t)
                    self.unplaced.append(s)
                continue
            cab.reserved[(local, bp)] = "cabinet_alarm"
            for s in group:
                cab.alarm_pos[s.row] = (bp, ch + ((s.pair or 1) - 1 if cabled else 0))
                keep.append(s)
            ch += width
        cab.alarms = keep
        counts = Counter(s.family for s in keep if s.family in ("A", "B"))
        fams = set(counts)
        if fams and self.rules.first("segregate"):
            minority = min(("A", "B"), key=lambda f: (counts[f], f != "B"))
            cab.family[local] = ("A" if minority == "B" else "B") if fams == {"A", "B"} else next(iter(fams))
            cab.alarm_minority = minority
            if fams == {"A", "B"}:
                t = self.book.add("segregation", "A/B cabinet alarms", "medium",
                                  f"Cabinet alarms of both A and B families in {self.name('marshalling', cab)} share the reserved "
                                  f"baseplate — the {minority} alarms are kept there as a TQ-covered exception. Fix: re-tag the alarms.",
                                  rows=[s.row for s in keep], tags=[s.tag for s in keep if s.family == minority],
                                  rules=[self.rules.rid("segregate") or "r-ab", rule.id])
                cab.alarm_exception = t.id

    # ── run ──
    def run(self, assign: Callable[["Engine", str, tuple[str, str], list[Block]], None] | None = None) -> Allocation:
        live = [s for s in self.signals if s.live and not s.quarantined]
        domains: dict[str, list[Signal]] = defaultdict(list)
        for s in live:
            domains[s.domain].append(s)
        self.blocks = self.build_blocks(live)
        ordered = sorted(domains, key=lambda d: min(s.row for s in domains[d]))
        self.dorder = {d: i for i, d in enumerate(ordered)}
        for domain in ordered:
            sigs = domains[domain]
            ns = Counter((s.loc, s.area_code) for s in sigs).most_common(1)[0][0]
            alarms = [s for s in sigs if s.kind == "cabinet_alarm"] if self.rules.first("reserve_baseplate") else []
            self.plan_domain_cabinets(domain, ns, alarms)
            self.place_alarms(domain, ns, alarms)
            dblocks = [b for b in self.blocks if b.domain == domain]
            (assign or Engine.assign_greedy)(self, domain, ns, dblocks)
        for cab in self.cabs:
            for local, bl in cab.blocks.items():
                pos = layout(bl, self.usable(cab, local), self.g)
                assert pos is not None, "assignment produced an infeasible CIOC"
                for b in bl:
                    b.bp, b.ch = pos[b.id]
        slots = self.fill()
        self.wired_spares(slots)
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
            grid: dict[tuple[int, int, int], Slot] = {}
            for local in range(1, g.ciocs + 1):
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
                            WhyStep(rule_id=self.rules.rid("segregate"),
                                    text=f"Cable is {fam_txt} (group {b.group}) → CIOC {slot.cioc_seq:03d}"
                                         + (f" locked to {b.family}" if b.family != "-" else " (neutral can share any CIOC)")),
                            WhyStep(rule_id=self.rules.rid("group_together"),
                                    text=f"Sequence: family {b.family}, group '{b.group}', {b.size}-pair, cable {b.cable}"),
                            WhyStep(rule_id=self.rules.rid("cable_contiguous"),
                                    text=(f"{b.size}-pair cable takes {b.span} whole baseplate(s) from BP {b.bp} ch 1"
                                          if b.span else f"{b.size}-pair cable packed in BP {b.bp} ch {b.ch}–{b.ch + b.foot - 1}")
                                         + f"; pair {pair} → BP {bp} ch {ch}"),
                        ]
                        if s.io_type_raw.upper() != s.io_type:
                            why.insert(0, WhyStep(rule_id=self.rules.rid("io_type_map"), text=f"IO type {s.io_type_raw} → {s.io_type}"))
                        if b.exception_tq and s.family == "B":
                            slot.tq_ids.append(b.exception_tq)
                            slot.remarks = f"Excepted by {b.exception_tq}: A/B on one cable"
                            why.append(WhyStep(rule_id=self.rules.rid("segregate"),
                                               text=f"A/B clash on {b.cable} — placed on an A CIOC, covered by {b.exception_tq}"))
                        self.put_signal(slot, s, "Field", why)
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
                    slot.remarks = alarm_rule.params.get("remarks", "Internal Cabinet Alarm.")
                    if cab.alarm_exception and s.family == cab.alarm_minority:
                        slot.tq_ids.append(cab.alarm_exception)
                        slot.remarks = f"Excepted by {cab.alarm_exception}: A/B cabinet alarms"
            for local in range(1, g.ciocs + 1):
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
    def wired_spares(self, slots: list[Slot]) -> None:
        rule = self.rules.first("wired_spare_pct")
        if not rule:
            return
        pct = float(rule.params.get("pct", 10))
        by_ctrl: dict[str, list[Slot]] = defaultdict(list)
        for s in slots:
            by_ctrl[s.controller].append(s)
        io_order = list(dict.fromkeys(self.rules.params("io_type_map").get("map", {}).values())) or ["AIR", "AOR", "DIR", "DOR"]
        blocks_by_id = {b.id: b for b in self.blocks}
        for ctrl, cs in by_ctrl.items():
            field = Counter(s.io_type for s in cs if s.status == "Field")
            cand: dict[str, list[Slot]] = defaultdict(list)  # block id → free pairs in pair order
            for s in sorted(cs, key=lambda s: (s.block_id or "", s.remarks == "Tag Deleted", s.pair or 0)):
                if s.status == "Spare Slot" and s.block_id and s.pair:
                    cand[s.block_id].append(s)
            used: set[str] = set()
            for io in sorted(field, key=lambda t: (io_order.index(t) if t in io_order else 99, t)):
                target = math.ceil(field[io] * pct / 100 - 1e-9) if rule.params.get("rounding", "ceil") == "ceil" else round(field[io] * pct / 100)
                if target <= 0:
                    continue
                cables = []
                for bid, free in cand.items():
                    b = blocks_by_id[bid]
                    n_io = sum(1 for m in b.members.values() if m.io_type == io)
                    if n_io:
                        cables.append((-n_io, b.sort_key, bid))
                cables.sort()
                got, progress = 0, True
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
                        slot.remarks = "-"
                        b = blocks_by_id[bid]
                        tmpl = min((m for m in b.members.values() if m.io_type == io), key=lambda m: m.pair or 0)
                        self.put_signal(slot, tmpl, "Wired Spare", [
                            WhyStep(rule_id=rule.id, text=f"{ctrl}: {field[io]} {io} field signals → target {target} wired spare(s) ({pct:g}%)"),
                            WhyStep(rule_id=rule.id, text=f"Unused pair {slot.pair} of {b.cable} (carries {io}) wired as spare #{got + 1}"),
                        ])
                        cab = next(c for c in self.cabs if self.name("marshalling", c) == slot.cabinet)
                        slot.tag = self.name("wired_spare", cab, slot.cioc_local, slot.bp, slot.ch)
                        slot.tag_key = slot.tag
                        slot.family, slot.group = "-", "-"
                        slot.service = fmt(self.patterns.get("spare_service", "SPARE {io2}"), io2=io[:2])
                        slot.instrument_type, slot.old_tag = "-", "-"
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

    # ── summaries ──
    def cabinet_infos(self, slots: list[Slot]) -> list[CabinetInfo]:
        out = []
        by_cab: dict[str, list[Slot]] = defaultdict(list)
        for s in slots:
            by_cab[s.cabinet].append(s)
        for cab in sorted(self.cabs, key=lambda c: (c.dorder, c.ns, c.seq)):
            name = self.name("marshalling", cab)
            cs = by_cab[name]
            ciocs = []
            for local in range(1, self.g.ciocs + 1):
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
