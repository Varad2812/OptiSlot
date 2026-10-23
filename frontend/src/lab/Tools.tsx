import { motion } from "framer-motion";
import { ArrowRight, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { RuleSet } from "@/api/hooks";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { EASE } from "@/motion/shared";

import type { Pending, Strategy } from "./useSandbox";

type Rule = RuleSet["rules"][number];

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3.5">
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="label-caps">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

interface ToolsProps {
  rules: RuleSet;
  pending: Pending;
  orig: Strategy;
  busy: boolean;
  onStrategy: (s: Strategy) => void;
  onToggle: (id: string, on: boolean) => void;
  onPct: (rule: Rule, pct: number) => void;
  onDropMove: (blockId: string) => void;
  onReset: (key: "toggles" | "params", id: string) => void;
}

const STRATEGIES: { key: Strategy; label: string; hint: string }[] = [
  { key: "balanced", label: "Balanced", hint: "Every CIOC installed, cables spread for even headroom" },
  { key: "compact", label: "Compact", hint: "Fewest CIOCs — only CIOCs that hold signals are installed" },
];

/** Right column: strategy switch, spare sliders, rule toggles, and the list of pending changes. */
export function Tools({ rules, pending, orig, busy, onStrategy, onToggle, onPct, onDropMove, onReset }: ToolsProps) {
  const strat = pending.strategy ?? orig;
  const spareRules = rules.rules.filter((r) => (r.type === "wired_spare_pct" || r.type === "future_spare_pct") && typeof r.params?.pct === "number");
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="lab-tools">
      <Section title="CIOC strategy" aside={busy && <Loader2 className="size-3.5 animate-spin text-live" />}>
        <div className="grid grid-cols-2 gap-1 rounded-chip border border-border bg-raised p-0.5" role="radiogroup" aria-label="CIOC strategy">
          {STRATEGIES.map((s) => (
            <button
              key={s.key} role="radio" aria-checked={strat === s.key} disabled={busy} onClick={() => strat !== s.key && onStrategy(s.key)}
              data-testid={`strategy-${s.key}`}
              className={cn(
                "h-7 rounded-[4px] text-[12px] font-medium transition-colors disabled:opacity-60",
                strat === s.key ? "bg-surface text-text inner-hi" : "text-muted-foreground hover:text-text",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">{STRATEGIES.find((s) => s.key === strat)?.hint}</p>
      </Section>

      <Section title="Pending changes" aside={<span className="tnum text-[11px] text-muted-foreground">{countOf(pending)}</span>}>
        {countOf(pending) === 0 ? (
          <p className="text-[12px] text-muted-foreground">Nothing yet. Pick up a cable in <span className="text-text">Proposed</span>, then click a green target.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="pending-list">
            {pending.strategy && <Row label={`Strategy → ${pending.strategy}`} />}
            {pending.moves.map((m) => (
              <Row key={m.block_id} label={m.block_id ?? "slot"} sub={`CIOC …${m.target_cioc.slice(-3)} · BP ${m.target_bp}${m.target_ch > 1 ? ` · ch ${m.target_ch}` : ""}`} onRemove={() => m.block_id && onDropMove(m.block_id)} />
            ))}
            {Object.entries(pending.toggles).map(([id, v]) => <Row key={id} label={`${id} ${v ? "on" : "off"}`} onRemove={() => onReset("toggles", id)} />)}
            {Object.entries(pending.params).map(([id, p]) => <Row key={id} label={`${id} → ${Object.values(p).join(", ")}%`} onRemove={() => onReset("params", id)} />)}
          </ul>
        )}
      </Section>

      <Section title="Spares">
        <div className="space-y-4">
          {spareRules.map((r) => (
            <PctSlider key={r.id} rule={r} value={pending.params[r.id]?.pct} onCommit={(v) => onPct(r, v)} onReset={() => onReset("params", r.id)} />
          ))}
        </div>
      </Section>

      <Section title="Rules" aside={<span className="text-[11px] text-muted-foreground">toggle to preview</span>}>
        <ul className="space-y-1.5">
          {rules.rules.map((r) => {
            const on = pending.toggles[r.id] ?? r.enabled;
            const changed = r.id in pending.toggles;
            return (
              <li key={r.id} className={cn("flex items-center gap-2.5 rounded-chip px-1.5 py-1", changed && "bg-warn/10")}>
                <Switch checked={on} onCheckedChange={(v) => onToggle(r.id, v)} className="h-4 w-7 shrink-0 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3" aria-label={r.label} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] leading-tight" title={r.label}>{r.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{r.id} · {r.severity}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

    </div>
  );
}

const countOf = (p: Pending) => p.moves.length + Object.keys(p.toggles).length + Object.keys(p.params).length + (p.strategy ? 1 : 0);

function Row({ label, sub, onRemove }: { label: string; sub?: string; onRemove?: () => void }) {
  return (
    <motion.li layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }} className="flex items-center gap-2 rounded-chip bg-raised px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11.5px]">{label}</div>
        {sub && (
          <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground"><ArrowRight className="size-3" />{sub}</div>
        )}
      </div>
      {onRemove && (
        <button onClick={onRemove} aria-label="Remove change" className="rounded-[4px] p-0.5 text-muted-foreground hover:bg-surface hover:text-text"><X className="size-3.5" /></button>
      )}
    </motion.li>
  );
}

function PctSlider({ rule, value, onCommit, onReset }: { rule: Rule; value: number | undefined; onCommit: (v: number) => void; onReset: () => void }) {
  const base = rule.params?.pct as number;
  const shown = value ?? base;
  const [local, setLocal] = useState(shown);
  useEffect(() => setLocal(shown), [shown]);
  const label = rule.type === "wired_spare_pct" ? "Wired spares" : "Future-spare baseplates";
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px]">{label}</span>
        <span className="tnum text-[12px] font-semibold">
          {local}% {local !== base && <button onClick={onReset} className="ml-1 text-[10.5px] font-normal text-muted-foreground underline-offset-2 hover:text-text hover:underline">was {base}%</button>}
        </span>
      </div>
      <Slider min={0} max={50} step={1} value={[local]} onValueChange={([v]) => setLocal(v)} onValueCommit={([v]) => v !== shown && onCommit(v)} aria-label={label} />
    </div>
  );
}
