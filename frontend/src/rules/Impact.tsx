import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { RuleChange } from "./api";

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

function Tile({ k, children, sub, tone }: { k: string; children: ReactNode; sub?: ReactNode; tone?: "ok" | "err" | "warn" }) {
  return (
    <div className={cn("rounded-chip border bg-raised/50 px-3 py-2", tone === "err" ? "border-err/50" : tone === "warn" ? "border-warn/40" : "border-border")}>
      <div className="label-caps">{k}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5 text-[15px] font-semibold tnum">{children}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

const Delta = ({ a, b, fmt = String }: { a: number; b: number; fmt?: (n: number) => string }) =>
  a === b ? <span>{fmt(b)}</span> : (
    <span className="inline-flex items-center gap-1"><span className="text-muted-foreground">{fmt(a)}</span><ArrowRight className="size-3 text-muted-foreground" />{fmt(b)}</span>
  );

/**
 * The what-if of one rule change — verifier result, signals moved, wired-spare change, stability, TQs — straight from
 * POST /rules/preview. Nothing here is computed from guesses: the same pipeline a Save runs produced these numbers.
 */
export function Impact({ change, loading, error, className, compact }: { change?: RuleChange; loading: boolean; error: string | null; className?: string; compact?: boolean }) {
  if (error) {
    return (
      <div role="alert" data-testid="rule-rejected" className={cn("flex items-start gap-2.5 rounded-chip border border-err/50 bg-err/10 px-3 py-2.5 text-[12.5px]", className)}>
        <XCircle className="mt-0.5 size-4 shrink-0 text-err" />
        <div><div className="font-medium text-err">Rejected — this rule is not valid</div><div className="mt-0.5 break-words text-muted-foreground">{error}</div></div>
      </div>
    );
  }
  if (!change) {
    return loading ? (
      <div className={cn("flex items-center gap-2 text-[12.5px] text-muted-foreground", className)}><Loader2 className="size-3.5 animate-spin" />Re-running allocate + verify…</div>
    ) : null;
  }
  const { kpis_before: b, kpis_after: a, report } = change;
  const signals = a.allocated || a.signals;
  const stab = a.stability_pct ?? (signals ? ((signals - change.moves) / signals) * 100 : 100);
  const newTq = change.new_tqs?.length ?? 0;
  const gone = change.resolved_tqs?.length ?? 0;
  const bad = report.violations > 0 || !change.allowed;
  return (
    <div className={cn("space-y-2.5", loading && "opacity-60 transition-opacity", className)} data-testid="rule-impact" aria-busy={loading}>
      <div className={cn("grid grid-cols-2 gap-2", !compact && "md:grid-cols-4")}>
        <Tile k="Violations" tone={report.violations ? "err" : "ok"} sub={`${report.checks_passed}/${report.checks_total} checks pass${report.excepted ? ` · ${report.excepted} excepted` : ""}`}>
          <span className={report.violations ? "text-err" : "text-ok"}><Delta a={b.violations} b={a.violations} /></span>
        </Tile>
        <Tile k="Signals moved" tone={change.moves ? "warn" : undefined} sub={change.moves ? `of ${signals} placed` : "every signal keeps its slot"}>{change.moves}</Tile>
        <Tile k="Wired spares" sub={`target ${b.wired_target === a.wired_target ? a.wired_target : `${b.wired_target} → ${a.wired_target}`}`}><Delta a={b.wired_spares} b={a.wired_spares} /></Tile>
        <Tile k="Stability" sub="unchanged in place"><Delta a={100} b={stab} fmt={pct} /></Tile>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span>Open TQs <b className="tnum text-text"><Delta a={b.tqs_open} b={a.tqs_open} /></b></span>
        {newTq > 0 && <span className="text-warn">+{newTq} new: <span className="font-mono">{change.new_tqs!.join(", ")}</span></span>}
        {gone > 0 && <span className="text-ok">{gone} resolved: <span className="font-mono">{change.resolved_tqs!.join(", ")}</span></span>}
        <span>Fill <b className="tnum text-text"><Delta a={b.fill_pct} b={a.fill_pct} fmt={pct} /></b></span>
        <span>Cabinets <b className="tnum text-text"><Delta a={b.cabinets} b={a.cabinets} /></b></span>
      </div>
      {(change.messages?.length ?? 0) > 0 && (bad || newTq > 0) && (
        <ul className="space-y-1">
          {change.messages!.map((m, i) => (
            <li key={i} className={cn("flex items-start gap-2 text-[12px]", bad ? "text-err" : "text-muted-foreground")}>
              {bad ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" />}
              <span>{m}</span>
            </li>
          ))}
        </ul>
      )}
      {!change.allowed && (
        <div className="rounded-chip border border-err/50 bg-err/10 px-3 py-2 text-[12.5px] text-err" data-testid="rule-refused">
          Save is blocked — this change would leave a hard violation or raise a system TQ. Nothing is stored.
        </div>
      )}
    </div>
  );
}
