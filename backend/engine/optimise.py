"""CP-SAT optimiser (OR-Tools): decides which CIOC each cable block goes to, per controller domain.

Greedy always runs first and stays the safe answer. CP-SAT is seeded with it and is adopted only when it is
strictly better on the lexicographic score AND every CIOC still lays out exactly AND (in the pipeline) the
independent verifier passes.

    hard:  capacity in pair units (≥12-pair blocks take whole baseplates; small blocks fill 12·k ≥ units),
           reserved baseplates, A/B families never on one CIOC (alarm locks included), pinned blocks fixed
    min (cioc_strategy compact):   cabinets holding field cables → CIOCs → IO groups spread → sequence inversions
                                   → moves → compactness
    min (cioc_strategy balanced):  IO groups spread (at the group rule's level) → max CIOC fill → moves vs the
                                   pinned baseline → sequence inversions
"""
from __future__ import annotations

import math
import time
from collections import defaultdict
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from engine.allocate import Block, Cab, Engine, layout

W_CAB, W_CIOC, W_GROUP, W_INV, W_MOVE, W_POS = 10 ** 10, 10 ** 7, 10 ** 5, 10 ** 3, 10 ** 2, 1


@dataclass
class DomainScore:
    cabinets: int        # cabinets holding field cables
    ciocs: int
    group_spread: int
    inversions: int
    compactness: int     # sum of CIOC positions (lower = filled from the front)
    strategy: str = "compact"
    max_fill: int = 0    # ‰ of the fullest CIOC's usable channels (balanced)
    group_scope_spread: int = 0  # group spread at the group rule's level (balanced)
    moves: int = 0       # blocks off their pinned-baseline CIOC (balanced)

    def key(self) -> tuple:
        if self.strategy == "balanced":
            return (self.group_scope_spread, self.max_fill, self.moves, self.inversions)
        return (self.cabinets, self.ciocs, self.group_spread, self.inversions, self.compactness)


@dataclass
class OptReport:
    domains: dict[str, dict] = field(default_factory=dict)
    adopted_any: bool = False
    time_ms: float = 0.0

    def totals(self, which: str) -> int:
        return sum(d[which]["ciocs"] for d in self.domains.values() if d.get(which))


def seq_of(engine: Engine, domain: str, ns) -> list[tuple[Cab, int]]:
    cabs = sorted([c for c in engine.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)
    return [(c, l) for c in cabs for l in range(1, engine.g.ciocs + 1)]


def score(engine: Engine, domain: str, ns, blocks: list[Block]) -> DomainScore:
    seq = seq_of(engine, domain, ns)
    index = {(id(c), l): i for i, (c, l) in enumerate(seq)}
    pos = {b.id: index[(id(b.cab), b.cioc)] for b in blocks if b.cab is not None}
    used = {(id(b.cab), b.cioc) for b in blocks if b.cab is not None}
    used_cabs = {id(b.cab) for b in blocks if b.cab is not None}
    groups: dict[str, set] = defaultdict(set)
    for b in blocks:
        if b.group not in ("", "-") and b.id in pos:
            groups[b.group].add(pos[b.id])
    order = [b for b in sorted(blocks, key=lambda b: b.sort_key) if b.id in pos]
    inv = sum(max(0, pos[a.id] - pos[b.id]) for a, b in zip(order, order[1:]))
    sc = DomainScore(len(used_cabs), len(used), sum(len(v) - 1 for v in groups.values()), inv, sum(pos.values()))
    if getattr(engine, "strategy", "compact") == "balanced":
        cabinet = group_level(engine) == "cabinet"
        scopes: dict[str, set] = defaultdict(set)
        for b in blocks:
            if b.group not in ("", "-") and b.cab is not None:
                scopes[b.group].add(id(b.cab) if cabinet else (id(b.cab), b.cioc))
        sc.strategy = "balanced"
        sc.group_scope_spread = sum(len(v) - 1 for v in scopes.values())
        sc.max_fill = max((engine.fill_permille(c, l) for c, l in seq), default=0)
        sc.moves = sum(1 for b in blocks if b.pin_pos and not b.pinned and b.cab is not None
                       and (b.cab.seq, b.cioc) != b.pin_pos[:2])
    return sc


def group_level(engine: Engine) -> str:
    return engine.rules.params("group_together").get("level", "cabinet") if engine.rules.first("group_together") else "cabinet"


def make_cpsat_assign(time_limit_s: float = 2.0, window: int = 6, report: OptReport | None = None):
    report = report if report is not None else OptReport()

    def assign(engine: Engine, domain: str, ns, blocks: list[Block]) -> None:
        balanced = engine.strategy == "balanced"
        (Engine.assign_balanced if balanced else Engine.assign_greedy)(engine, domain, ns, blocks)
        placed = [b for b in blocks if b.cab is not None]
        g_score = score(engine, domain, ns, placed)
        info = {"greedy": g_score.__dict__, "cpsat": None, "adopted": False, "status": "skipped"}
        report.domains[domain] = info
        if len(placed) < 2:
            info["status"] = "trivial"
            return
        t0 = time.perf_counter()
        seq = seq_of(engine, domain, ns)
        n = len(seq)
        greedy_pos = {b.id: next(i for i, (c, l) in enumerate(seq) if c is b.cab and l == b.cioc) for b in placed}
        reach = max(window, 8) if balanced else window  # balanced may move a block across the whole cabinet row
        m = cp_model.CpModel()
        x: dict[tuple[str, int], cp_model.IntVar] = {}
        cand: dict[str, list[int]] = {}
        for b in placed:
            if b.pinned:
                cand[b.id] = [greedy_pos[b.id]]
            else:
                lo, hi = max(0, greedy_pos[b.id] - reach), min(n - 1, greedy_pos[b.id] + reach)
                cand[b.id] = [i for i in range(lo, hi + 1)
                              if layout([b], engine.usable(seq[i][0], seq[i][1]), engine.g) is not None]
                if greedy_pos[b.id] not in cand[b.id]:
                    cand[b.id].append(greedy_pos[b.id])
            for i in cand[b.id]:
                x[(b.id, i)] = m.NewBoolVar(f"x[{b.id}|{i}]")
            m.AddExactlyOne(x[(b.id, i)] for i in cand[b.id])
        by_cioc: dict[int, list[Block]] = defaultdict(list)
        for b in placed:
            for i in cand[b.id]:
                by_cioc[i].append(b)
        used = [m.NewBoolVar(f"u{i}") for i in range(n)]
        primary = engine.rules.primary_seg
        seg_on = primary is not None and primary.params.get("level", "cioc") == "cioc"
        bp_seg = engine.g.bp_seg
        for i, (cab, local) in enumerate(seq):
            bl = by_cioc.get(i, [])
            usable = len(engine.usable(cab, local))
            big = [b for b in bl if b.span]
            small = [b for b in bl if not b.span]
            # small blocks need whole baseplates per baseplate-segregation signature (one signature when there is none)
            sigs: dict[tuple, list[Block]] = defaultdict(list)
            for b in small:
                sigs[tuple(b.fams.get(r) or "" for r in bp_seg)].append(b)
            ks = []
            for j, (_, sb) in enumerate(sorted(sigs.items())):
                k = m.NewIntVar(0, usable, f"k{i}_{j}")
                m.Add(engine.g.chs * k >= sum(b.foot * x[(b.id, i)] for b in sb))
                ks.append(k)
            m.Add(sum(b.span * x[(b.id, i)] for b in big) + sum(ks) <= usable)
            for b in bl:
                m.AddImplication(x[(b.id, i)], used[i])
            if not bl:
                m.Add(used[i] == 0)
            if seg_on:
                lock = cab.alarm_lock.get(local)
                fa, fb = m.NewBoolVar(f"A{i}"), m.NewBoolVar(f"B{i}")
                m.Add(fa + fb <= 1)
                if lock == "A":
                    m.Add(fa == 1)
                elif lock == "B":
                    m.Add(fb == 1)
                for b in bl:
                    if b.family == "A":
                        m.AddImplication(x[(b.id, i)], fa)
                    elif b.family == "B":
                        m.AddImplication(x[(b.id, i)], fb)
        cab_ids = list(dict.fromkeys(id(c) for c, _ in seq))  # physical order (never memory addresses: reproducible)
        cab_of = [cab_ids.index(id(c)) for c, _ in seq]
        # every further segregate rule (or a cabinet-level primary): one family per scope (CIOC or cabinet)
        for rule in engine.seg_rules:
            if rule.id in bp_seg:
                continue  # baseplate level: enforced by the layout capacity above and by layout()
            fams = sorted({b.fams[rule.id] for b in placed if rule.id in b.fams})
            if not fams:
                continue
            cabinet = rule.params.get("level", "cioc") == "cabinet"
            scopes: dict[int, dict[str, cp_model.IntVar]] = {}
            for i in range(n):
                key = cab_of[i] if cabinet else i
                if key not in scopes:
                    scopes[key] = {f: m.NewBoolVar(f"s{rule.id}{key}{f}") for f in fams}
                    m.Add(sum(scopes[key].values()) <= 1)
                for b in by_cioc.get(i, []):
                    f = b.fams.get(rule.id)
                    if f:
                        m.AddImplication(x[(b.id, i)], scopes[key][f])
        cab_used = [m.NewBoolVar(f"c{j}") for j in range(len(cab_ids))]
        for i in range(n):
            m.AddImplication(used[i], cab_used[cab_of[i]])
        # opened (undeclared) cabinets are used in sequence order: never leave a gap in the numbering
        opened = [j for j, cid in enumerate(cab_ids) if not next(c for c, _ in seq if id(c) == cid).declared]
        for a, b2 in zip(opened, opened[1:]):
            m.AddImplication(cab_used[b2], cab_used[a])
        # group spread
        spread = []
        groups: dict[str, list[Block]] = defaultdict(list)
        for b in placed:
            if b.group not in ("", "-"):
                groups[b.group].append(b)
        for gname, gb in groups.items():
            idxs = sorted({i for b in gb for i in cand[b.id]})
            z = {i: m.NewBoolVar(f"g{gname}{i}") for i in idxs}
            for b in gb:
                for i in cand[b.id]:
                    m.AddImplication(x[(b.id, i)], z[i])
            spread.append(sum(z.values()))
        # sequence inversions
        pos = {b.id: m.NewIntVar(0, n - 1, f"p{b.id}") for b in placed}
        for b in placed:
            m.Add(pos[b.id] == sum(i * x[(b.id, i)] for i in cand[b.id]))
        order = sorted(placed, key=lambda b: b.sort_key)
        inv = []
        for a, b in zip(order, order[1:]):
            v = m.NewIntVar(0, n, f"inv{a.id}")
            m.Add(v >= pos[a.id] - pos[b.id])
            inv.append(v)
        if balanced:
            # groups together at the group rule's level → lowest max CIOC fill → fewest moves vs the pinned
            # baseline → sequence. Weights are sized from the bounds of each lower term, so the order is strict.
            scope_of = (lambda i: cab_of[i]) if group_level(engine) == "cabinet" else (lambda i: i)
            g_spread = []
            for gname, gb in groups.items():
                z = {k: m.NewBoolVar(f"G{gname}{k}") for k in sorted({scope_of(i) for b in gb for i in cand[b.id]})}
                for b in gb:
                    for i in cand[b.id]:
                        m.AddImplication(x[(b.id, i)], z[scope_of(i)])
                g_spread.append(sum(z.values()))
            max_fill = m.NewIntVar(0, 1000, "max_fill")
            for i, (cab, local) in enumerate(seq):
                cap = engine.cap_units(cab, local)
                if cap and by_cioc.get(i):
                    m.Add(1000 * sum(b.foot * x[(b.id, i)] for b in by_cioc[i]) <= cap * max_fill)
            index = {(c.seq, l): i for i, (c, l) in enumerate(seq)}
            b_moves = []
            for b in placed:
                home = index.get(b.pin_pos[:2]) if b.pin_pos and not b.pinned else None
                if home is not None and home in cand[b.id]:
                    b_moves.append(1 - x[(b.id, home)])
            w_move = n * len(placed) + 1
            w_fill = w_move * (len(placed) + 1)
            w_group = w_fill * 1001
            m.Minimize(w_group * sum(g_spread) + w_fill * max_fill + w_move * sum(b_moves) + sum(inv))
        else:
            moves = [1 - x[(b.id, greedy_pos[b.id])] for b in placed if b.pin_pos and not b.pinned]
            m.Minimize(W_CAB * sum(cab_used) + W_CIOC * sum(used) + W_GROUP * sum(spread) + W_INV * sum(inv)
                       + W_MOVE * sum(moves) + W_POS * sum(pos.values()))
        for b in placed:
            for i in cand[b.id]:
                m.AddHint(x[(b.id, i)], 1 if i == greedy_pos[b.id] else 0)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = time_limit_s
        solver.parameters.num_workers = 1
        solver.parameters.random_seed = 42
        st = solver.Solve(m)
        info["status"] = solver.StatusName(st)
        info["time_ms"] = round((time.perf_counter() - t0) * 1e3, 1)
        if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return
        choice = {b.id: next(i for i in cand[b.id] if solver.Value(x[(b.id, i)])) for b in placed}
        if all(choice[b.id] == greedy_pos[b.id] for b in placed):
            info["cpsat"] = g_score.__dict__
            return
        # tentatively re-commit and check layout + score; roll back if not strictly better
        snapshot = {id(c): ({l: list(v) for l, v in c.blocks.items()}, dict(c.family), dict(c.locks)) for c, _ in seq}
        for c, _ in seq:
            c.blocks.clear()
            c.family.clear()
            c.family.update(c.alarm_lock)
            c.locks.clear()
        for b in sorted(placed, key=lambda b: b.sort_key):
            cab, local = seq[choice[b.id]]
            engine.commit(cab, local, b)
        feasible = all(layout(c.blocks[l], engine.usable(c, l), engine.g) is not None
                       for c, l in seq if c.blocks.get(l))
        c_score = score(engine, domain, ns, placed)
        info["cpsat"] = c_score.__dict__
        if feasible and c_score.key() < g_score.key():
            info["adopted"] = True
            report.adopted_any = True
            # drop opened cabinets that CP-SAT emptied (only trailing ones, so numbering stays contiguous)
            cabs = sorted([c for c in engine.cabs if c.ns == ns and c.domain == domain], key=lambda c: c.seq)
            for c in reversed(cabs):
                if c.declared or c.alarms or any(c.blocks.values()):
                    break
                engine.cabs.remove(c)
            engine.renumber_controllers(ns)
        else:
            for c, _ in seq:
                blocks_, fam, locks = snapshot[id(c)]
                c.blocks.clear()
                c.blocks.update(blocks_)
                c.family.clear()
                c.family.update(fam)
                c.locks.clear()
                c.locks.update(locks)
            for c, _ in seq:
                for l, bl in c.blocks.items():
                    for b in bl:
                        b.cab, b.cioc = c, l
            info["status"] += "" if feasible else " (layout check failed — greedy kept)"

    assign.report = report  # type: ignore[attr-defined]
    return assign
