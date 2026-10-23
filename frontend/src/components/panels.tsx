import { motion } from "framer-motion";
import { ArrowUpRight, CheckCircle2, CircleAlert, Download, FileSpreadsheet, Hash, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  useAllocation, useExports, useImportSummary, useProjectId, useRules, useRuns, type AllocationResult,
} from "@/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { IO_COLOURS, ioKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { EASE } from "@/motion/shared";

/**
 * The card every screen is built from: an uppercase label, optional aside, hairline surface, hover lift.
 * With `to` the whole card is a link (inner links/buttons keep their own target); the arrow in the header is the keyboard path.
 */
export function Panel({ title, aside, children, className, delay = 0, to }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; delay?: number; to?: string }) {
  const nav = useNavigate();
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay, ease: EASE }}
      whileHover={{ y: -2 }}
      onClick={to ? (e) => !(e.target as HTMLElement).closest("a,button,input,[data-stop]") && nav(to) : undefined}
      className={cn("card-surface group/panel flex min-h-0 flex-col p-4 transition-colors", to && "cursor-pointer hover:border-brand/40", className)}
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="label-caps">{title}</h2>
        <div className="flex items-center gap-2">
          {aside}
          {to && (
            <Link to={to} aria-label={`Open ${title}`} className="rounded-chip p-0.5 text-muted-foreground transition-colors group-hover/panel:text-brand focus-visible:text-brand">
              <ArrowUpRight className="size-3.5" />
            </Link>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </motion.section>
  );
}

const short = (h?: string) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : "—");

function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export function CertificatePanel({ delay, to }: { delay?: number; to?: string }) {
  const { data: a } = useAllocation();
  const c = a?.certificate;
  const pass = c?.verdict === "PASS";
  return (
    <Panel title="Run certificate" delay={delay} to={to} aside={c && <Verdict pass={pass} />}>
      {!c ? <Loading /> : (
        <>
          <div className={cn("text-[26px] font-semibold tnum", pass ? "text-ok" : "text-err")}>
            {c.violations} violations <span className="text-muted-foreground">·</span> <span className="text-text">{c.checks_passed}/{c.checks_total}</span>
            <span className="ml-1 text-[13px] font-normal text-muted-foreground">checks</span>
          </div>
          <dl className="mt-3 grid grid-cols-[96px_1fr] gap-y-1.5 text-[12px]">
            {([["Input MDB", c.mdb_sha256], ["Rule set", c.ruleset_hash], ["Output", c.output_sha256]] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="flex items-center gap-1.5 text-muted-foreground"><Hash className="size-3" />{k}</dt>
                <dd className="font-mono text-[11.5px]" title={v}>{short(v)}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">Engine</dt>
            <dd className="font-mono text-[11.5px]">{c.engine_version} · {c.timestamp.replace("T", " ").replace("Z", "")}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-1" aria-label="Verifier checks">
            {a!.report.checks.map((ch) => (
              <span
                key={ch.id}
                title={`${ch.label} — ${ch.failed ? `${ch.failed} failed` : ch.excepted ? `${ch.excepted} excepted by TQ` : `${ch.passed} passed`}`}
                className={cn("h-2 w-4 rounded-[2px]", ch.failed ? "bg-err" : ch.excepted ? "bg-warn" : "bg-ok/80")}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function Verdict({ pass }: { pass: boolean }) {
  return (
    <span className={cn("flex items-center gap-1 rounded-chip px-2 py-0.5 text-[11px] font-semibold", pass ? "bg-ok/15 text-ok" : "bg-err/15 text-err")}>
      {pass ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />} {pass ? "PASS" : "FAIL"}
    </span>
  );
}

export function ChecksPanel({ delay, limit = 20 }: { delay?: number; limit?: number }) {
  const { data: a } = useAllocation();
  return (
    <Panel title="Independent checks" delay={delay} aside={a && <span className="text-[11px] text-muted-foreground tnum">{a.report.checks_passed}/{a.report.checks_total}</span>}>
      {!a ? <Loading rows={8} /> : (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 xl:grid-cols-2">
          {a.report.checks.slice(0, limit).map((ch, i) => (
            <motion.li key={ch.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: (delay ?? 0) + i * 0.04 }} className="flex items-center gap-2 py-0.5 text-[12.5px]">
              {ch.failed ? <XCircle className="size-3.5 shrink-0 text-err" /> : ch.excepted ? <CircleAlert className="size-3.5 shrink-0 text-warn" /> : <CheckCircle2 className="size-3.5 shrink-0 text-ok" />}
              <span className="truncate">{ch.label}</span>
              <span className="ml-auto text-[11px] text-muted-foreground tnum">{ch.passed}{ch.excepted ? ` +${ch.excepted} TQ` : ""}</span>
            </motion.li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const SEV: Record<string, string> = { critical: "bg-err/20 text-err", high: "bg-err/15 text-err", medium: "bg-warn/15 text-warn", low: "bg-raised text-muted-foreground", info: "bg-raised text-muted-foreground" };

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function TqPanel({ delay, limit = 5, to }: { delay?: number; limit?: number; to?: string }) {
  const { data: a } = useAllocation();
  // open first, then by severity; the register keeps the engine's order
  const tqs = [...(a?.tqs ?? [])].sort((x, y) => Number(y.status === "open") - Number(x.status === "open") || (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9));
  return (
    <Panel title="Technical queries" delay={delay} to={to} aside={a && <span className="text-[11px] text-muted-foreground tnum">{a.kpis.tqs_open} open</span>}>
      {!a ? <Loading /> : !tqs.length ? <p className="text-muted-foreground">No TQs — every live signal placed cleanly.</p> : (
        <ul className="space-y-2">
          {tqs.slice(0, limit).map((t) => (
            <li key={t.id}>
              <Link to="/tqs" className="block rounded-chip border border-border bg-raised/50 p-2.5 transition-colors hover:border-brand/40 hover:bg-raised">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-muted-foreground">{t.id}</span>
                  <span className={cn("rounded-[4px] px-1.5 py-px font-medium", SEV[t.severity] ?? SEV.low)}>{t.severity}</span>
                  <span className="truncate text-muted-foreground">{t.category}</span>
                  <span className="ml-auto rounded-[4px] bg-surface px-1.5 py-px text-muted-foreground">{t.confidence}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug">{t.message}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {a && tqs.length > limit && <p className="mt-2 text-[11.5px] text-muted-foreground">+{tqs.length - limit} more in the TQ Center</p>}
    </Panel>
  );
}

export function SparesPanel({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  return (
    <Panel title="Spares per cabinet" delay={delay}>
      {!a ? <Loading /> : (
        <table className="w-full text-[12px] tnum">
          <thead className="text-left text-[11px] text-muted-foreground">
            <tr><th className="pb-1.5 font-medium">Cabinet</th><th className="font-medium">Used</th><th className="font-medium">Wired</th><th className="font-medium">Spare</th><th className="font-medium">Empty BP</th><th className="w-28 font-medium">Fill</th></tr>
          </thead>
          <tbody>
            {a.kpis.spares_per_cabinet.slice(0, 8).map((c) => (
              <tr key={c.cabinet} className="border-t border-border">
                <td className="py-1.5 font-mono text-[11.5px]">{c.cabinet}</td>
                <td>{c.used}</td><td>{c.wired_spares}</td><td>{c.spare_slots}</td><td>{c.empty_baseplates}</td>
                <td><Bar pct={c.fill_pct} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function Bar({ pct, tone = "brand" }: { pct: number; tone?: "brand" | "ok" | "warn" }) {
  return (
    <div className="flex min-w-[64px] flex-1 items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
        <motion.div className={cn("h-full rounded-full", tone === "brand" ? "bg-brand" : tone === "ok" ? "bg-ok" : "bg-warn")} initial={{ width: 0 }} animate={{ width: `${Math.min(100, pct)}%` }} transition={{ duration: 0.6, ease: EASE }} />
      </div>
      <span className="w-10 text-right text-[11px] text-muted-foreground">{pct.toFixed(0)}%</span>
    </div>
  );
}

export function SpareCompliancePanel({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  return (
    <Panel title="Wired spares vs target" delay={delay}>
      {!a ? <Loading /> : (
        <ul className="space-y-2">
          {a.kpis.spare_compliance.slice(0, 8).map((c) => (
            <li key={`${c.controller}-${c.io_type}`} className="grid grid-cols-[120px_44px_1fr] items-center gap-2 text-[12px]">
              <span className="truncate font-mono text-[11px] text-muted-foreground">{c.controller}</span>
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: IO_COLOURS[ioKey({ status: "Field", io_type: c.io_type })] }} />{c.io_type}</span>
              <div className="flex items-center gap-2 tnum">
                <Bar pct={c.target ? (100 * c.wired) / c.target : 100} tone={c.ok ? "ok" : "warn"} />
                <span className="w-12 text-right text-[11px] text-muted-foreground">{c.wired}/{c.target}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const KIND_DOT: Record<string, string> = {
  import: "bg-io-ai", allocate: "bg-brand", verify: "bg-ok", tq: "bg-warn", rule: "bg-io-ao", revision: "bg-io-alarm", export: "bg-io-di", whatif: "bg-muted-foreground",
};
const KIND_TO: Record<string, string> = {
  import: "/import", allocate: "/explorer", verify: "/proof", tq: "/tqs", rule: "/rules", revision: "/revisions", export: "/export", whatif: "/lab",
};

/**
 * The decision log as a vertical timeline: a dot per event kind, each row links to the screen that owns it.
 * `columns` > 1 fills column-first (wide tiles); every item draws its own connector so the line restarts per column.
 */
export function ActivityPanel({ delay, kinds, to, limit = 8, columns = 1 }: { delay?: number; kinds?: string[]; to?: string; limit?: number; columns?: number }) {
  const { data: a } = useAllocation();
  const items = (a?.activity ?? []).filter((e) => !kinds || kinds.includes(e.kind)).slice(0, limit);
  const rows = Math.ceil(items.length / columns);
  return (
    <Panel title="Activity" delay={delay} to={to} aside={a && <span className="text-[11px] text-muted-foreground">decision log</span>}>
      {!a ? <Loading /> : !items.length ? <p className="text-muted-foreground">Nothing yet.</p> : (
        <ol className={cn("grid gap-x-8", columns > 1 && "xl:grid-flow-col")} style={columns > 1 ? { gridTemplateRows: `repeat(${rows}, auto)` } : undefined}>
          {items.map((e, i) => {
            const first = i % rows === 0;
            const last = i % rows === rows - 1 || i === items.length - 1;
            return (
              <li key={i} className="relative">
                <span className={cn("absolute left-[3.5px] w-px bg-border", first ? "top-[15px]" : "top-0", last ? "h-[15px]" : "bottom-0")} />
                <Link to={KIND_TO[e.kind] ?? "/"} className="relative flex gap-3 rounded-chip py-1.5 pl-5 pr-1.5 text-[12.5px] transition-colors hover:bg-raised/70">
                  <span className={cn("absolute left-0 top-[11px] size-2 rounded-full ring-2 ring-surface", KIND_DOT[e.kind] ?? "bg-muted-foreground")} />
                  <span className="w-10 shrink-0 font-mono text-[11px] leading-[18px] text-muted-foreground">{e.ts.slice(11, 16)}</span>
                  <span className="min-w-0 flex-1 leading-[18px]"><span className="mr-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{e.kind}</span>{e.text}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

export function RunsPanel({ delay }: { delay?: number }) {
  const { data: runs } = useRuns();
  return (
    <Panel title="Run history" delay={delay} aside={<span className="text-[11px] text-muted-foreground">same inputs → same hash</span>}>
      {!runs ? <Loading /> : !runs.length ? <p className="text-muted-foreground">No runs recorded yet in this session — press <kbd className="rounded-[4px] border border-border px-1 font-mono text-[11px]">A</kbd> to allocate and hash a run.</p> : (
        <table className="w-full text-[12px]">
          <tbody>
            {runs.slice(0, 8).map((r) => (
              <tr key={r.run_id} className="border-t border-border first:border-0">
                <td className="py-1.5 font-mono text-[11px] text-muted-foreground">{r.timestamp.slice(5, 16).replace("T", " ")}</td>
                <td className="text-[11px]">{r.kind}</td>
                <td className="font-mono text-[11px]" title={r.output_sha256}>{short(r.output_sha256)}</td>
                <td className={cn("text-right text-[11px] font-semibold", r.verdict === "PASS" ? "text-ok" : "text-err")}>{r.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function MappingPanel({ delay }: { delay?: number }) {
  const { data: imp } = useImportSummary();
  return (
    <Panel title="Column mapping" delay={delay} aside={imp && <span className="font-mono text-[11px] text-muted-foreground">{imp.file}</span>}>
      {!imp ? <Loading rows={8} /> : (
        <div className="flex flex-wrap gap-1.5">
          {imp.mapping.map((m) => (
            <span key={m.field} className={cn("flex items-center gap-1.5 rounded-chip border px-2 py-1 text-[11.5px]", m.source ? "border-border bg-raised/60" : "border-warn/40 bg-warn/10 text-warn")}>
              <span className="text-muted-foreground">{m.label}</span>
              <span className="font-mono">{m.source ?? "unmapped"}</span>
              {m.source && <span className={cn("tnum text-[10.5px]", m.confidence >= 0.9 ? "text-ok" : "text-warn")}>{Math.round(m.confidence * 100)}%</span>}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function ImportStatsPanel({ delay }: { delay?: number }) {
  const { data: imp } = useImportSummary();
  return (
    <Panel title="Pre-flight" delay={delay}>
      {!imp ? <Loading /> : (
        <div className="grid grid-cols-3 gap-3">
          {([["Rows", imp.rows], ["Live", imp.live_rows], ["Quarantined", imp.quarantined]] as const).map(([k, v]) => (
            <div key={k} className="rounded-chip bg-raised/60 p-3">
              <div className="label-caps">{k}</div>
              <div className={cn("mt-1 text-[22px] font-semibold tnum", k === "Quarantined" && v ? "text-warn" : "")}>{v}</div>
            </div>
          ))}
          <div className="col-span-3 font-mono text-[11px] text-muted-foreground">sheet {imp.sheet} · header row {imp.header_row} · sha256 {short(imp.sha256)}</div>
        </div>
      )}
    </Panel>
  );
}

export function RulesPanel({ delay }: { delay?: number }) {
  const { data: rs } = useRules();
  return (
    <Panel title="Rule set" delay={delay} aside={rs && <span className="font-mono text-[11px] text-muted-foreground">{rs.id} · v{rs.version} · {rs.settings?.cioc_strategy ?? "balanced"}</span>}>
      {!rs ? <Loading rows={8} /> : (
        <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {rs.rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 rounded-chip border border-border bg-raised/40 px-2.5 py-2">
              <span className={cn("h-4 w-7 rounded-full p-0.5 transition-colors", r.enabled ? "bg-brand" : "bg-border")}>
                <span className={cn("block size-3 rounded-full bg-white transition-transform", r.enabled && "translate-x-3")} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.label}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{r.type}</span>
              <span className={cn("rounded-[4px] px-1.5 text-[10.5px]", r.severity === "hard" ? "bg-brand/15 text-brand" : "bg-raised text-muted-foreground")}>{r.severity}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function ExportsPanel({ delay }: { delay?: number }) {
  const { data: files } = useExports();
  const pid = useProjectId();
  return (
    <Panel title="Output files" delay={delay}>
      {!files ? <Loading /> : (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {files.map((f) => (
            <li key={f.kind}>
              <a href={`/api/projects/${pid}/export/${f.kind}`} download={f.filename} className="flex items-center gap-3 rounded-chip border border-border bg-raised/40 p-3 transition-colors hover:border-brand/50 hover:bg-raised">
                <FileSpreadsheet className="size-5 text-ok" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px]">{f.filename}</div>
                  <div className="text-[11px] text-muted-foreground tnum">{f.rows} rows{f.sha256 ? ` · ${short(f.sha256)}` : ""}</div>
                </div>
                <Download className="size-4 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function StatusPanel({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const counts = a?.kpis.status_counts ?? {};
  const total = Object.values(counts).reduce((x, y) => x + y, 0) || 1;
  const tone: Record<string, string> = { Field: "bg-brand", "Wired Spare": "bg-ok", "Cabinet Alarm": "bg-io-alarm", "Spare Slot": "bg-border" };
  return (
    <Panel title="Rows by tag status" delay={delay} aside={a && <span className="text-[11px] text-muted-foreground tnum">{a.slots.length} rows</span>}>
      {!a ? <Loading /> : (
        <>
          <div className="flex h-2.5 overflow-hidden rounded-full">
            {Object.entries(counts).map(([k, v]) => (
              <div key={k} className={tone[k] ?? "bg-muted"} style={{ width: `${(100 * v) / total}%` }} />
            ))}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
            {Object.entries(counts).map(([k, v]) => (
              <li key={k} className="flex items-center gap-2"><span className={cn("size-2 rounded-full", tone[k] ?? "bg-muted")} />{k}<span className="ml-auto tnum text-muted-foreground">{v}</span></li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

export function RowsPreviewPanel({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const rows = (a?.slots ?? []).filter((s) => s.status !== "Spare Slot").slice(0, 14);
  const cols: [string, (s: AllocationResult["slots"][number]) => string | number][] = [
    ["Tag", (s) => s.tag], ["Status", (s) => s.status], ["IO", (s) => s.io_type], ["Cabinet", (s) => s.cabinet], ["CIOC", (s) => s.cioc], ["BP", (s) => s.baseplate], ["Ch", (s) => s.ch], ["CHARM", (s) => s.charm], ["TB", (s) => s.tb], ["Cable", (s) => s.cable], ["Pair", (s) => s.pair_label],
  ];
  return (
    <Panel title="IO Assignment — first rows" delay={delay}>
      {!a ? <Loading rows={10} /> : (
        <div className="overflow-hidden rounded-chip border border-border">
          <table className="w-full text-[11.5px]">
            <thead className="bg-raised text-left text-[11px] text-muted-foreground">
              <tr>{cols.map(([c]) => <th key={c} className="px-2 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  {cols.map(([c, f]) => <td key={c} className="truncate px-2 py-1">{f(s)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function OptimiserPanel({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const o = a?.optimiser;
  return (
    <Panel title="Optimiser" delay={delay}>
      {!o ? <Loading /> : (
        <div className="space-y-2 text-[12.5px]">
          <div className="flex items-baseline gap-2"><span className="text-[22px] font-semibold uppercase">{o.method}</span><span className="text-muted-foreground">{o.adopted ? "adopted" : "greedy kept"} · {o.status}</span></div>
          <div className="grid grid-cols-3 gap-2 tnum">
            <Stat k="Greedy CIOCs" v={o.greedy_ciocs} /><Stat k="CP-SAT CIOCs" v={o.cpsat_ciocs ?? "—"} /><Stat k="Solve" v={`${Math.round(o.time_ms)} ms`} />
          </div>
          {o.note && <p className="text-muted-foreground">{o.note}</p>}
        </div>
      )}
    </Panel>
  );
}

export function Stat({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="rounded-chip bg-raised/60 p-2.5">
      <div className="label-caps">{k}</div>
      <div className="mt-0.5 text-[16px] font-semibold tnum">{v}</div>
    </div>
  );
}

export function MdbPreviewPanel({ delay }: { delay?: number }) {
  const { data: imp } = useImportSummary();
  const rows = imp?.preview ?? [];
  const cols = rows.length ? Object.keys(rows[0]).slice(0, 10) : [];
  return (
    <Panel title="MDB preview" delay={delay} aside={imp && <span className="text-[11px] text-muted-foreground tnum">first {rows.length} of {imp.rows} rows</span>}>
      {!imp ? <Loading rows={8} /> : !rows.length ? <p className="text-muted-foreground">No preview rows in this summary.</p> : (
        <div className="overflow-x-auto rounded-chip border border-border">
          <table className="w-full text-[11.5px]">
            <thead className="bg-raised text-left text-[11px] text-muted-foreground">
              <tr>{cols.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody className="font-mono">
              {rows.slice(0, 12).map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {cols.map((c) => <td key={c} className="max-w-[220px] truncate whitespace-nowrap px-2 py-1">{r[c] || "-"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function BomPanel({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const bom = Object.entries(a?.kpis.hardware_bom ?? {}).sort((x, y) => y[1] - x[1]);
  const max = Math.max(1, ...bom.map(([, v]) => v));
  return (
    <Panel title="Hardware bill of materials" delay={delay} aside={a && <span className="text-[11px] text-muted-foreground tnum">{a.kpis.cabinets} cabinets · {a.kpis.ciocs} CIOCs · {a.kpis.baseplates_used} BPs</span>}>
      {!a ? <Loading rows={6} /> : (
        <ul className="space-y-1.5">
          {bom.map(([part, n]) => (
            <li key={part} className="grid grid-cols-[110px_1fr_48px] items-center gap-3 text-[12px]">
              <span className="font-mono text-[11.5px]">{part}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                <motion.div className="h-full rounded-full bg-brand/80" initial={{ width: 0 }} animate={{ width: `${(100 * n) / max}%` }} transition={{ duration: 0.6, ease: EASE }} />
              </div>
              <span className="text-right tnum text-muted-foreground">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
