import { motion, useMotionValueEvent, useTransform, type MotionValue } from "framer-motion";
import { ChevronDown, CircleAlert, Copy, Crosshair, FileSpreadsheet, Link2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { RuleCheckReport, RunRecord, Slot } from "@/api/hooks";
import { Panel } from "@/components/panels";
import { ruleChecks } from "@/lib/checks";
import { cn } from "@/lib/utils";
import { easeOut, phase } from "@/motion/shared";
import { CountUp } from "@/shell/CountUp";

import { lastTick, STAMP, tickAt, TICKS_FROM, type CheckResult, type Fail } from "./scan";
import { copyText, middle } from "./util";

// ───────────── certificate + stamp ─────────────

export interface CertView {
  kind: "run" | "file";
  /** the tamper test: a modified copy of our export, not the user's allocation */
  demo?: boolean;
  title: string;
  rows: [label: string, value: string | null | undefined, copy?: string][];
  note?: ReactNode;
  engine: string;
  at: string;
}

/** Hashes, engine, time and the verdict. The seal lands (scale 1.15 → 1, short glow) when the scan has read every check. */
export function CertStamp({ report, cert, p, signals }: { report: RuleCheckReport; cert: CertView; p: MotionValue<number>; signals?: number | null }) {
  const pass = report.verdict === "PASS";
  const land = useTransform(p, (v) => easeOut(phase(v, STAMP[0], STAMP[1])));
  const scale = useTransform(land, (t) => 1.15 - 0.15 * t);
  const opacity = useTransform(p, (v) => phase(v, STAMP[0] - 0.02, STAMP[0] + 0.04));
  const glow = useTransform(p, (v) => Math.sin(Math.PI * phase(v, STAMP[0], STAMP[1] + 0.1)));
  const follow = useTransform(p, (v) => phase(v, TICKS_FROM, lastTick(report.checks.length) + 0.02));
  const tone = cert.demo ? { text: "text-warn", ring: "border-warn", glow: "shadow-[0_0_32px_6px_rgb(var(--warn)/0.45)]", grad: "from-warn/10" } : pass ? { text: "text-ok", ring: "border-ok", glow: "shadow-[0_0_32px_6px_rgb(var(--ok)/0.55)]", grad: "from-ok/10" } : { text: "text-err", ring: "border-err", glow: "shadow-[0_0_32px_6px_rgb(var(--err)/0.55)]", grad: "from-err/10" };
  return (
    <section className={cn("card-surface relative overflow-hidden bg-gradient-to-br to-transparent p-4", tone.grad, cert.demo && "border-dashed border-warn/50")} data-testid={cert.demo ? "demo-certificate" : "certificate"} data-verdict={report.verdict}>
      <header className="mb-3 flex items-center justify-between gap-2 pr-[132px]">
        <h2 className="label-caps">{cert.title}</h2>
      </header>
      {/* the seal */}
      <motion.div className="absolute right-4 top-3 z-10 origin-center -rotate-6" style={{ scale, opacity }} data-testid="stamp">
        <motion.div className={cn("absolute inset-0 rounded-md", tone.glow)} style={{ opacity: glow }} />
        <div className={cn("relative flex items-center gap-1.5 rounded-md border-2 bg-surface/80 px-2.5 py-1 text-[11.5px] font-bold uppercase tracking-[0.16em] backdrop-blur", tone.ring, tone.text)}>
          {pass ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}
          {cert.demo ? "Caught" : pass ? "Verified" : "Rejected"}
        </div>
      </motion.div>

      <div className={cn("text-[23px] font-semibold leading-8 tnum", tone.text)} data-testid="verdict-line">
        <CountUp value={report.violations} follow={follow} /> violation{report.violations === 1 ? "" : "s"} <span className="text-muted-foreground">·</span>{" "}
        <span className="text-text">
          {report.checks_passed === report.checks_total ? <><CountUp value={report.checks_total} follow={follow} /> rule checks</> : <><CountUp value={report.checks_passed} follow={follow} />/{report.checks_total} rule checks</>}
        </span>
      </div>
      {signals != null && <div className="mt-0.5 text-[11.5px] text-muted-foreground tnum">{signals.toLocaleString("en-US")} signals checked</div>}
      {(report.excepted > 0 || report.warnings > 0) && (
        <div className="mt-0.5 text-[11.5px] text-muted-foreground tnum">
          {report.excepted > 0 && <>{report.excepted} excepted by a TQ</>}{report.excepted > 0 && report.warnings > 0 && " · "}{report.warnings > 0 && <>{report.warnings} soft warning{report.warnings === 1 ? "" : "s"}</>}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-[104px_1fr] items-center gap-y-1.5 text-[12px]">
        {cert.rows.map(([k, v, copy]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]" title={copy ?? v ?? ""}>
              <span className="truncate">{v ?? "—"}</span>
              {copy && (
                <button onClick={() => void copyText(copy, k)} aria-label={`Copy ${k}`} className="shrink-0 rounded-[4px] p-0.5 text-muted-foreground transition-colors hover:text-text"><Copy className="size-3" /></button>
              )}
            </dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Engine</dt>
        <dd className="font-mono text-[11.5px]">{cert.engine} · {cert.at.replace("T", " ").replace("Z", "")}</dd>
      </dl>
      {cert.note && <div className="mt-3">{cert.note}</div>}
    </section>
  );
}

export const hashRow = (label: string, h?: string | null): [string, string | null, string?] => [label, h ? middle(h) : null, h ?? undefined];

// ───────────── the checks ─────────────

const ROW_VISIBLE = 6;

/** One verifier check. Pending until its tick (a pure function of p), then ✓ / ✗ / ⚠ pops in. Failures expand with their rows. */
export function CheckRow({
  ch, i, n, p, fails, exceptions, focusKey, pulseKey, onFly, defaultOpen,
}: {
  ch: CheckResult; i: number; n: number; p: MotionValue<number>; fails: Fail[]; exceptions: Fail[]; focusKey: string | null; pulseKey: number;
  onFly: (f: Fail) => void; defaultOpen: boolean;
}) {
  const t = tickAt(i, n);
  const failed = ch.failed > 0;
  const hard = ch.severity === "hard";
  const [ticked, setTicked] = useState(() => p.get() >= t);
  useMotionValueEvent(p, "change", (v) => setTicked((o) => (v >= t) === o ? o : v >= t));
  const [open, setOpen] = useState<boolean | null>(null);
  const [all, setAll] = useState(false);
  const rows = failed ? fails : exceptions;
  const expandable = rows.length > 0;
  const isOpen = ticked && expandable && (open ?? defaultOpen);

  const done = useTransform(p, (v) => phase(v, t, t + 0.03));
  const pop = useTransform(done, (d) => 0.35 + 0.65 * d + 0.3 * Math.sin(Math.PI * d));
  const pending = useTransform(done, (d) => 1 - d);
  const labelOpacity = useTransform(done, (d) => 0.45 + 0.55 * d);
  const flash = useTransform(p, (v) => (failed ? Math.max(0.12, 0.4 * (1 - phase(v, t, t + 0.12))) * Math.min(1, done.get() * 6) : 0));
  const tone = failed ? (hard ? "text-err" : "text-warn") : ch.excepted ? "text-warn" : "text-ok";
  const Icon = failed && hard ? XCircle : failed || ch.excepted ? CircleAlert : ShieldCheck;
  const shown = all ? rows : rows.slice(0, ROW_VISIBLE);
  return (
    <li className={cn("relative rounded-chip", failed && ticked && "ring-1 ring-err/40")} data-testid="check-row" data-check={ch.id} data-failed={failed || undefined} data-ticked={ticked || undefined}>
      {failed && <motion.div className="pointer-events-none absolute inset-0 rounded-chip bg-err" style={{ opacity: flash }} />}
      <button
        onClick={() => expandable && ticked && setOpen(!isOpen)} disabled={!expandable || !ticked}
        className={cn("relative flex w-full items-center gap-2.5 px-2 py-1 text-left text-[12.5px]", expandable && ticked && "cursor-pointer hover:bg-raised/60")}
      >
        <span className="relative size-4 shrink-0">
          <motion.span className="absolute inset-0 flex items-center justify-center" style={{ opacity: pending }}><span className="size-2.5 rounded-full border border-muted-foreground/50" /></motion.span>
          <motion.span className={cn("absolute inset-0 flex items-center justify-center", tone)} style={{ opacity: done, scale: pop }}><Icon className="size-4" strokeWidth={2.2} /></motion.span>
        </span>
        <motion.span className="min-w-0 flex-1 truncate" style={{ opacity: labelOpacity }}>{ch.label}</motion.span>
        <motion.span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tnum" style={{ opacity: done }}>
          {failed ? <span className={cn("rounded-[4px] px-1.5 font-semibold", hard ? "bg-err/15 text-err" : "bg-warn/15 text-warn")}>{ch.failed} {hard ? "failed" : "warn"}</span> : <>{ch.passed}{ch.excepted ? <span className="text-warn"> +{ch.excepted} TQ</span> : null}</>}
          {expandable && <ChevronDown className={cn("size-3.5 transition-transform", isOpen && "rotate-180")} />}
        </motion.span>
      </button>
      {isOpen && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={{ duration: 0.2 }} className="relative overflow-hidden">
          {!failed && <p className="px-2 pb-1 pl-[34px] text-[11px] text-warn">Excepted by a TQ — the verifier reports it instead of passing it silently.</p>}
          <ul className="space-y-1 px-2 pb-2 pl-[34px]">
            {shown.map((f) => (
              <FailItem key={f.key} f={f} soft={!failed} focused={f.key === focusKey} pulseKey={pulseKey} onFly={onFly} />
            ))}
            {rows.length > ROW_VISIBLE && (
              <li><button onClick={() => setAll(!all)} className="text-[11.5px] font-medium text-brand hover:underline">{all ? "Show fewer" : `Show all ${ch.failed || ch.excepted} (${rows.length} listed)`}</button></li>
            )}
          </ul>
        </motion.div>
      )}
    </li>
  );
}

/** A failing (or excepted) row: where it is, what is wrong, and a button that flies the camera there. The focused one pulses red three times. */
function FailItem({ f, soft, focused, pulseKey, onFly }: { f: Fail; soft: boolean; focused: boolean; pulseKey: number; onFly: (f: Fail) => void }) {
  return (
    <motion.li
      key={focused ? pulseKey : "idle"}
      animate={focused ? { backgroundColor: ["rgb(var(--err) / 0)", "rgb(var(--err) / 0.38)", "rgb(var(--err) / 0.04)", "rgb(var(--err) / 0.38)", "rgb(var(--err) / 0.04)", "rgb(var(--err) / 0.38)", "rgb(var(--err) / 0.14)"] } : undefined}
      transition={{ duration: 1.5 }}
      className={cn("rounded-chip border bg-raised/50 px-2.5 py-1.5", soft ? "border-warn/30" : "border-err/30")}
      data-testid="fail-item" data-fail={f.key}
    >
      <div className="flex items-center gap-2 text-[11px]">
        {f.v.row != null && <span className="rounded-[4px] bg-surface px-1.5 py-px font-mono text-muted-foreground">row {f.v.row}</span>}
        {f.v.tag && <span className="truncate font-mono text-[11.5px]">{f.v.tag}</span>}
        {f.slot ? (
          <button onClick={() => onFly(f)} data-testid="fly-to-slot" className="ml-auto flex shrink-0 items-center gap-1 rounded-chip border border-border bg-surface px-1.5 py-0.5 font-medium text-brand transition-colors hover:border-brand/60">
            <Crosshair className="size-3" /> Fly to slot
          </button>
        ) : (
          <span className="ml-auto shrink-0 text-muted-foreground" title="This row is not a slot of the current allocation">not on the plant</span>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{f.v.message}</p>
    </motion.li>
  );
}

// ───────────── run history ─────────────

const KIND_CHIP: Record<string, string> = { allocate: "bg-brand/15 text-brand", revision: "bg-io-alarm/15 text-io-alarm", "verify-file": "bg-live/15 text-live", stress: "bg-raised text-muted-foreground" };

/** Every run is hashed. Rows that re-derive an earlier (input, rule set, output) triple are tagged — the same inputs give the same hash. */
export function RunHistory({ runs, certified }: { runs: RunRecord[] | undefined; certified?: string }) {
  const rows = (runs ?? []).slice(0, 12);
  // newest first. An engine run "reproduces" when an older engine run carries the identical (input, rule set, output) triple.
  // Re-verifying the same uploaded file always gives the same hash — that proves nothing about the engine, so those rows are not tagged.
  const seen = new Map<string, number>();
  const older = new Map<string, number>();
  [...(runs ?? [])].reverse().forEach((r, k) => {
    if (r.kind === "verify-file") return older.set(r.run_id, -1);
    const key = `${r.mdb_sha256}|${r.ruleset_hash}|${r.output_sha256}`;
    older.set(r.run_id, seen.get(key) ?? -1);
    if (!seen.has(key)) seen.set(key, k);
  });
  const reproduced = rows.filter((r) => older.get(r.run_id)! >= 0).length;
  return (
    <Panel
      title="Run history" className="shrink-0"
      aside={<span className="text-[11px] text-muted-foreground">same inputs → same hash{reproduced ? ` · ${reproduced} reproduced` : ""}</span>}
    >
      {!runs ? null : !rows.length ? (
        <p className="text-[12.5px] text-muted-foreground">No runs recorded yet — press <kbd className="rounded-[4px] border border-border px-1 font-mono text-[11px]">A</kbd> to allocate and hash a run.</p>
      ) : (
        <ul className="divide-y divide-border" data-testid="run-history">
          {rows.map((r) => {
            const repro = older.get(r.run_id)! >= 0;
            const isCertified = certified && r.output_sha256 === certified && r.kind === "verify-file";
            return (
              <li key={r.run_id} className="flex items-center gap-2 py-1.5 text-[11.5px]">
                <span className="w-[74px] shrink-0 font-mono text-[10.5px] text-muted-foreground">{r.timestamp.slice(5, 16).replace("T", " ")}</span>
                <span className={cn("w-[68px] shrink-0 rounded-[4px] px-1.5 py-px text-center text-[10.5px] font-medium", KIND_CHIP[r.kind] ?? KIND_CHIP.stress)}>{r.kind}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <button onClick={() => void copyText(r.output_sha256, "Output hash")} title={`${r.output_sha256} — click to copy`} className="truncate font-mono text-[11px] hover:text-brand">{middle(r.output_sha256, 10, 4)}</button>
                  {repro && <span title="An older run has the identical input hash, rule-set hash and output hash" className="flex shrink-0 items-center gap-0.5 rounded-[4px] bg-brand/15 px-1 text-[10px] font-medium text-brand"><Link2 className="size-2.5" />reproduced</span>}
                  {isCertified && <span title="This file is byte-identical to the certified output" className="flex shrink-0 items-center gap-0.5 rounded-[4px] bg-ok/15 px-1 text-[10px] font-medium text-ok"><FileSpreadsheet className="size-2.5" />= certified</span>}
                </span>
                <span className={cn("w-9 shrink-0 text-right text-[11px] font-semibold", r.verdict === "PASS" ? "text-ok" : "text-err")}>{r.verdict}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export type { Slot };

/** The tamper test is a demo on a modified copy: this card says so, and says the real allocation is untouched. */
export function DemoBanner({ t, onBack }: { t: { row?: number; column?: string; tag?: string; from?: string; to?: string }; onBack: () => void }) {
  return (
    <div className="rounded-card border border-dashed border-warn/60 bg-warn/[0.07] px-3.5 py-2.5 text-[12.5px]" data-testid="demo-banner">
      <div className="flex items-center gap-2 font-semibold text-warn"><ShieldAlert className="size-4 shrink-0" /> Demo — tamper caught in a modified copy</div>
      <p className="mt-0.5 text-muted-foreground">Your allocation is untouched. One cell was changed in a copy of the export{t.row ? <> (row {t.row}, {t.column}: <span className="font-mono">{t.from} → {t.to}</span>)</> : null} and the independent verifier was asked to read it.</p>
      <button onClick={onBack} className="mt-1.5 text-[11.5px] text-brand hover:underline" data-testid="demo-back">Back to the real certificate</button>
    </div>
  );
}

/** The real verifier status, always visible while a demo or an uploaded file is on screen. */
export function RealStatus({ report, signals }: { report: RuleCheckReport; signals?: number | null }) {
  const pass = report.verdict === "PASS";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-chip border px-2.5 py-1.5 text-[12px]", pass ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err")} data-testid="real-status">
      {pass ? <ShieldCheck className="size-3.5 shrink-0" /> : <XCircle className="size-3.5 shrink-0" />}
      <span className="text-muted-foreground">Your allocation</span>
      <span className="tnum font-semibold">{report.violations} violations · {ruleChecks(report)}{signals != null ? ` · ${signals.toLocaleString("en-US")} signals` : ""}</span>
    </div>
  );
}
