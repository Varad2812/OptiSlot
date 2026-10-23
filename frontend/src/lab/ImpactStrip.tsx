import { motion } from "framer-motion";

import type { AllocationResult } from "@/api/hooks";
import type { Impact } from "@/lib/sandbox";
import { cn } from "@/lib/utils";
import { EASE } from "@/motion/shared";
import { CountUp } from "@/shell/CountUp";

interface TileProps {
  label: string;
  testid: string;
  value: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  was?: string;           // the Current pane's value, shown as "was → now"
  delta?: number;         // proposed − current; sign colours it
  goodWhenLower?: boolean;
  tone?: "ok" | "err";
  sub?: React.ReactNode;
}

function Tile({ label, testid, value, decimals = 0, suffix, prefix, was, delta, goodWhenLower, tone, sub }: TileProps) {
  const better = delta != null && delta !== 0 && goodWhenLower != null ? (goodWhenLower ? delta < 0 : delta > 0) : null;
  return (
    <div className={cn("card-surface relative px-3.5 py-2.5", tone === "err" && "border-err/60")} data-testid={testid}>
      {/* a violation turns the tile red with a single pulse (CLAUDE.md §10.2) */}
      {tone === "err" && (
        <motion.span key={value} className="pointer-events-none absolute inset-0 rounded-card border-2 border-err" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.9, ease: EASE }} />
      )}
      <div className="label-caps">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={cn("text-[22px] font-semibold leading-7", tone === "err" ? "text-err" : tone === "ok" ? "text-ok" : "text-text")}>
          {prefix}
          <CountUp value={value} decimals={decimals} suffix={suffix} />
        </span>
        {delta != null && delta !== 0 && (
          <span className={cn("tnum rounded-chip px-1.5 py-px text-[11px] font-semibold", better === true ? "bg-ok/15 text-ok" : better === false ? "bg-warn/15 text-warn" : "bg-raised text-muted-foreground")}>
            {delta > 0 ? "+" : "−"}{Math.abs(delta).toFixed(decimals)}{suffix}
          </span>
        )}
      </div>
      <div className="mt-0.5 h-4 truncate text-[11px] text-muted-foreground tnum">{sub ?? (was != null ? <>was {was}</> : null)}</div>
    </div>
  );
}

/** §10.5.3 Impact: violations · moves · CIOCs · cabinets · fill % · BOM delta — proposed vs current. */
export function ImpactStrip({ base, impact }: { base: AllocationResult; impact: Impact }) {
  const bk = base.kpis;
  const bom = impact.bom.slice(0, 2).map((b) => `${b.part} ${b.delta > 0 ? "+" : "−"}${Math.abs(b.delta)}`).join(" · ");
  return (
    <div className="grid grid-cols-6 gap-2.5 border-b border-border bg-surface/40 px-4 py-2.5" data-testid="impact">
      <Tile label="Violations" testid="impact-violations" value={impact.violations} tone={impact.violations > 0 ? "err" : "ok"} was={String(base.report.violations)} sub={impact.violations ? "hard rule broken — cannot commit" : `${base.report.violations} before`} />
      <Tile label="Signals moved" testid="impact-moves" value={impact.moves} was="0" sub={impact.moves ? "each carries a reason on commit" : "nothing moved"} />
      <Tile label="CIOCs" testid="impact-ciocs" value={impact.ciocs} delta={impact.ciocs - bk.ciocs} goodWhenLower was={String(bk.ciocs)} />
      <Tile label="Cabinets" testid="impact-cabinets" value={impact.cabinets} delta={impact.cabinets - bk.cabinets} goodWhenLower was={String(bk.cabinets)} />
      <Tile label="Fill" testid="impact-fill" value={impact.fill} decimals={1} suffix="%" delta={Number((impact.fill - bk.fill_pct).toFixed(1))} was={`${bk.fill_pct.toFixed(1)}%`} />
      <Tile label="BOM Δ" testid="impact-bom" value={Math.abs(impact.bomTotal)} prefix={impact.bomTotal > 0 ? "+" : impact.bomTotal < 0 ? "−" : ""} sub={bom || "no hardware change"} />
    </div>
  );
}
