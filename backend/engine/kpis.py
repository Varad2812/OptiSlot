"""Scoreboard numbers, spare compliance and spares per cabinet — all computed, never hard-coded."""
from __future__ import annotations

import math
from collections import Counter, defaultdict

from app.schemas import CabinetInfo, CabinetSpares, Kpis, Signal, Slot, SpareCompliance, TQ
from engine.rules import Rules


def compute_kpis(signals: list[Signal], slots: list[Slot], cabinets: list[CabinetInfo], tqs: list[TQ], rules: Rules,
                 violations: int = 0, stability_pct: float | None = None) -> Kpis:
    live = [s for s in signals if s.live]
    placed = {s.tag_key for s in slots if s.status in ("Field", "Cabinet Alarm")}
    allocated = sum(1 for s in live if s.tag_key in placed)
    tq_rows = {r for t in tqs for r in t.rows}
    explained = sum(1 for s in live if s.tag_key not in placed and (s.row in tq_rows or s.quarantined))
    status = Counter(s.status for s in slots)

    pct = float(rules.params("wired_spare_pct").get("pct", 10)) if rules.first("wired_spare_pct") else 0.0
    compliance = []
    by_ctrl: dict[str, list[Slot]] = defaultdict(list)
    for s in slots:
        by_ctrl[s.controller].append(s)
    for ctrl in sorted(by_ctrl):
        f = Counter(s.io_type for s in by_ctrl[ctrl] if s.status == "Field")
        w = Counter(s.io_type for s in by_ctrl[ctrl] if s.status == "Wired Spare")
        for io in sorted(set(f) | set(w)):
            target = math.ceil(f[io] * pct / 100 - 1e-9) if pct else 0
            compliance.append(SpareCompliance(controller=ctrl, io_type=io, field=f[io], wired=w[io], target=target,
                                              pct=round(100 * w[io] / f[io], 1) if f[io] else 0.0, ok=w[io] >= target))

    spc = []
    used_bps = 0
    for c in cabinets:
        cs = [s for s in slots if s.cabinet == c.name]
        used = sum(s.status in ("Field", "Cabinet Alarm") for s in cs)
        empty = sum(1 for ci in c.ciocs for b in ci.baseplates if b.used == 0 and b.wired_spares == 0
                    and not any(s.cable not in ("-", "") for s in cs if s.cioc_local == ci.local and s.bp == b.bp))
        used_bps += sum(1 for ci in c.ciocs for b in ci.baseplates if b.used or b.wired_spares)
        spc.append(CabinetSpares(cabinet=c.name, controller=c.controller, used=used,
                                 wired_spares=sum(s.status == "Wired Spare" for s in cs),
                                 spare_slots=sum(s.status == "Spare Slot" for s in cs), empty_baseplates=empty,
                                 future_baseplates=sum(1 for ci in c.ciocs for b in ci.baseplates if b.reserved == "future"),
                                 fill_pct=round(100 * used / len(cs), 1) if cs else 0.0))
    bom = Counter(s.charm for s in slots) + Counter(s.tb for s in slots if s.status != "Spare Slot")
    open_tqs = [t for t in tqs if t.status == "open"]
    return Kpis(
        signals=len(live), allocated=allocated,
        allocated_pct=round(100 * (allocated + explained) / len(live), 1) if live else 100.0,
        unallocated_with_tq=explained, tqs_open=len(open_tqs), violations=violations,
        cabinets=len(cabinets), ciocs=sum(len(c.ciocs) for c in cabinets),  # instantiated = the rows and the BOM
        baseplates_used=used_bps,
        fill_pct=round(100 * (status["Field"] + status["Cabinet Alarm"] + status["Wired Spare"]) / len(slots), 1) if slots else 0.0,
        wired_spares=status["Wired Spare"], wired_target=sum(c.target for c in compliance), stability_pct=stability_pct,
        status_counts=dict(status), tq_by_category=dict(Counter(t.category for t in open_tqs)),
        spare_compliance=compliance, spares_per_cabinet=spc, hardware_bom=dict(bom),
    )
