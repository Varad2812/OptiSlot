"""CLI: python -m engine.run <mdb.xlsx> [--ruleset default]

Prints counts per Tag Status, cabinets/CIOCs used, TQs by category and runtime.
"""
from __future__ import annotations

import argparse
from collections import Counter

from engine.pipeline import run
from engine.rules import load_ruleset


def main() -> None:
    ap = argparse.ArgumentParser(description="OptiSlot allocation engine")
    ap.add_argument("mdb")
    ap.add_argument("--ruleset", default="default")
    a = ap.parse_args()
    out = run(a.mdb, load_ruleset(a.ruleset))
    k = out.kpis
    print(f"\n  OptiSlot · {out.table.file} · sheet {out.table.sheet} (header row {out.table.header_row})")
    print(f"  {k.signals} live signals → {k.allocated} allocated ({k.allocated_pct}% placed, {k.accounted_pct}% placed or TQ-explained)")
    print("\n  Tag Status")
    for st in ("Field", "Wired Spare", "Cabinet Alarm", "Spare Slot"):
        print(f"    {st:14} {k.status_counts.get(st, 0):6}")
    print(f"    {'total':14} {sum(k.status_counts.values()):6}")
    print(f"\n  Cabinets {k.cabinets} · CIOCs in use {k.ciocs} · baseplates in use {k.baseplates_used} · fill {k.fill_pct}%")
    for c in out.alloc.cabinets:
        fams = " ".join(f"{ci.seq:03d}:{ci.family}:{ci.used}" for ci in c.ciocs)
        print(f"    {c.name}  {c.controller}  {'declared' if c.declared else 'opened'}  [{fams}]")
    print(f"\n  Wired spares {k.wired_spares} / target {k.wired_target}")
    for sc in k.spare_compliance:
        print(f"    {sc.controller} {sc.io_type}: field {sc.field:3} wired {sc.wired:2} target {sc.target:2} {'ok' if sc.ok else 'SHORT'}")
    cats = Counter(t.category for t in out.tqs)
    print(f"\n  TQs {len(out.tqs)} · quarantined rows {len(out.quarantine)}")
    for c, n in cats.most_common():
        print(f"    {c:28} {n}")
    for t in out.tqs:
        print(f"    {t.id:12} {t.severity:8} {t.message[:120]}")
    print("\n  Runtime " + " · ".join(f"{k_[:-3]} {v:.0f} ms" for k_, v in out.timings.items()) + "\n")


if __name__ == "__main__":
    main()
