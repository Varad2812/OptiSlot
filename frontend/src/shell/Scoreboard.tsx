import { motion } from "framer-motion";
import { Link } from "react-router-dom";

import { useAllocation } from "@/api/hooks";
import { cn } from "@/lib/utils";

import { CountUp } from "./CountUp";

interface Tile {
  label: string;
  to: string;
  value: number | null;
  decimals?: number;
  suffix?: string;
  tone?: "ok" | "err" | "warn" | "brand";
  sub?: string;
}

/** §10.2 scoreboard strip — the judging criteria as live numbers. Every tile links to its screen. */
export function Scoreboard() {
  const { data: a } = useAllocation();
  const k = a?.kpis;
  const tiles: Tile[] = [
    { label: "Allocated", to: "/grid", value: k?.allocated_pct ?? null, decimals: k && k.allocated_pct % 1 ? 1 : 0, suffix: "%", tone: k && k.allocated_pct >= 100 ? "ok" : "warn", sub: k ? `${k.allocated}/${k.signals} live` : undefined },
    { label: "Violations", to: "/proof", value: a?.report.violations ?? null, tone: a && a.report.violations > 0 ? "err" : "ok", sub: a ? `${a.report.checks_passed}/${a.report.checks_total} checks` : undefined },
    { label: "Open TQs", to: "/tqs", value: k?.tqs_open ?? null, tone: k && k.tqs_open > 0 ? "warn" : "ok", sub: k ? `${k.unallocated_with_tq} explain a gap` : undefined },
    { label: "Untouched", to: "/revisions", value: k?.stability_pct ?? null, decimals: 1, suffix: "%", tone: "brand", sub: k?.stability_pct == null ? "after Rev B" : "in place vs Rev A" },
    { label: "Cabinets", to: "/explorer", value: k?.cabinets ?? null, sub: k ? `${new Set(a?.cabinets.map((c) => c.controller)).size} controllers` : undefined },
    { label: "CIOCs", to: "/explorer", value: k?.ciocs ?? null, sub: k ? `${k.baseplates_used} BPs used` : undefined },
    { label: "Fill", to: "/explorer", value: k?.fill_pct ?? null, decimals: 1, suffix: "%", sub: k ? `${k.wired_spares}/${k.wired_target} wired spares` : undefined },
  ];
  return (
    <div className="grid grid-cols-7 gap-px border-b border-border bg-border/60" data-testid="scoreboard">
      {tiles.map((t) => (
        <ScoreTile key={t.label} t={t} />
      ))}
    </div>
  );
}

const TONE: Record<NonNullable<Tile["tone"]>, string> = {
  ok: "text-ok",
  err: "text-err",
  warn: "text-warn",
  brand: "text-brand",
};

function ScoreTile({ t }: { t: Tile }) {
  const bad = t.tone === "err";
  return (
    <Link to={t.to} className="group relative block bg-bg/80 px-4 py-2.5 transition-colors hover:bg-raised/70">
      {bad && (
        <motion.span
          key={t.value}
          className="pointer-events-none absolute inset-0 bg-err/15"
          initial={{ opacity: 0.9 }}
          animate={{ opacity: 0.35 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <div className="label-caps flex items-center gap-1.5">
        {t.tone === "ok" && <span className="size-1.5 rounded-full bg-ok" />}
        {t.tone === "warn" && <span className="size-1.5 rounded-full bg-warn" />}
        {bad && <span className="size-1.5 rounded-full bg-err" />}
        {t.label}
      </div>
      <div className={cn("mt-0.5 text-[22px] font-semibold leading-7", t.tone ? TONE[t.tone] : "text-text")}>
        {t.value == null ? <span className="text-muted-foreground">—</span> : <CountUp value={t.value} decimals={t.decimals} suffix={t.suffix} />}
      </div>
      <div className="truncate text-[11px] text-muted-foreground tnum">{t.sub ?? " "}</div>
    </Link>
  );
}
