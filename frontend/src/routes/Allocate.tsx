import { motion } from "framer-motion";
import { ArrowRight, Check, Circle, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAllocate, useAllocation, useProject, type AllocationResult } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ruleChecks } from "@/lib/checks";
import { cn } from "@/lib/utils";
import { EASE, useCalm } from "@/motion/shared";
import { CountUp } from "@/shell/CountUp";
import { PageError } from "@/shell/states";
import { openInRoom } from "@/world/actions";

const MAX_CARDS = 12;

interface Phase {
  key: string;
  label: string;
  /** what the finished run says about this phase — real numbers from the allocation */
  done: (a: AllocationResult) => string;
}

const PHASES: Phase[] = [
  { key: "pre", label: "Read the MDB and run pre-flight checks", done: (a) => `${a.kpis.signals} signals read · ${a.quarantine.length} row${a.quarantine.length === 1 ? "" : "s"} quarantined · ${a.tqs.length} question${a.tqs.length === 1 ? "" : "s"} raised` },
  { key: "part", label: "Split into controller domains", done: (a) => `${new Set(a.cabinets.map((c) => c.domain)).size} domain${new Set(a.cabinets.map((c) => c.domain)).size === 1 ? "" : "s"} · ${new Set(a.cabinets.map((c) => c.controller)).size} controller${new Set(a.cabinets.map((c) => c.controller)).size === 1 ? "" : "s"}` },
  { key: "place", label: "Place cable blocks first-fit, keeping groups together", done: (a) => `${a.optimiser.greedy_ciocs} CIOCs by the greedy placer` },
  {
    key: "opt", label: "Search for a tighter layout (CP-SAT)",
    done: (a) => (a.optimiser.method === "cpsat" ? `${a.optimiser.cpsat_ciocs ?? "—"} CIOCs found · ${a.optimiser.adopted ? "adopted — it scored better and verified" : "kept the greedy layout"}` : "Not needed — the greedy layout stands"),
  },
  { key: "fill", label: "Fill every slot, wire the spares, name everything", done: (a) => `${a.kpis.wired_spares} wired spares (target ${a.kpis.wired_target}) · ${a.kpis.baseplates_used} baseplates used` },
  { key: "ver", label: "Verify with the independent checker", done: (a) => `${a.report.violations} violations · ${ruleChecks(a.report)} · ${a.kpis.signals} signals` },
];

/** Progress while the server works: it eases towards 92 % and only reaches 100 % when the real answer lands. */
function useRunProgress(running: boolean, calm: boolean) {
  const [p, setP] = useState(0);
  const t0 = useRef(0);
  useEffect(() => {
    if (!running) return;
    t0.current = performance.now();
    setP(2);
    const id = window.setInterval(() => {
      const s = (performance.now() - t0.current) / 1000;
      setP(Math.min(92, 92 * (1 - Math.exp(-s / (calm ? 1.2 : 2.2)))));
    }, 80);
    return () => window.clearInterval(id);
  }, [running, calm]);
  return p;
}

/** Allocate (reference step 02): run the solver, watch its phases, see every cabinet's fill. */
export default function Allocate() {
  const nav = useNavigate();
  const calm = useCalm();
  const { data: a, isLoading, isError, error, refetch } = useAllocation();
  const { data: p } = useProject();
  const run = useAllocate();
  const running = run.isPending;
  const prog = useRunProgress(running, calm);
  const [ranHere, setRanHere] = useState(false);

  const phaseIdx = running ? Math.min(PHASES.length - 1, Math.floor((prog / 92) * PHASES.length)) : PHASES.length;
  const pct = running ? prog : a ? 100 : 0;
  const spares = useMemo(() => new Map((a?.kpis.spares_per_cabinet ?? []).map((s) => [s.cabinet, s])), [a]);

  if (isError && !a) return <PageError title="The allocation could not be loaded" error={error} onRetry={() => void refetch()} />;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1280px] p-6" data-testid="allocate-page">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-page">Allocate</h1>
            <p className="mt-1 text-muted-foreground">
              Deterministic solver — segregation, spares and loading rules applied. The same input always gives the same layout.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-2" onClick={() => nav("/room")} disabled={!a}>3D Room <ArrowRight className="size-4" /></Button>
            <Button className="gap-2" onClick={() => (setRanHere(true), run.mutate())} disabled={running || !p?.mdb_file} data-testid="run-allocation">
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {running ? "Allocating…" : a ? "Run allocation again" : "Run allocation"}
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-4">
          <section className="card-surface col-span-12 p-5 xl:col-span-7" data-testid="solver-card">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="label-caps">{running ? "Solving" : a ? "Last run" : "Not run yet"}</div>
                <div className="mt-1 text-[34px] font-semibold leading-none tnum" data-testid="alloc-pct">
                  {isLoading ? <Skeleton className="h-9 w-24" /> : <><CountUp value={Math.round(pct)} />%</>}
                </div>
              </div>
              {a && !running && (
                <div className="text-right text-[12px] text-muted-foreground tnum">
                  <div><b className="text-text"><CountUp value={a.kpis.allocated} /></b> of {a.kpis.signals} signals placed</div>
                  <div>solved in {(a.runtime_ms / 1000).toFixed(1)} s · rule set v{p?.ruleset_version ?? "—"}</div>
                </div>
              )}
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
              <motion.div className="h-full rounded-full bg-gradient-to-r from-brand to-live" animate={{ width: `${pct}%` }} transition={{ duration: calm ? 0.1 : 0.25, ease: EASE }} />
            </div>

            <ol className="mt-5 space-y-1" data-testid="phases">
              {PHASES.map((ph, i) => {
                const state = !a && !running ? "idle" : i < phaseIdx ? "done" : i === phaseIdx ? "now" : "idle";
                return (
                  <li key={ph.key} className={cn("flex items-start gap-3 rounded-chip px-2.5 py-2 transition-colors", state === "now" && "bg-brand/10")}>
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center">
                      {state === "done" ? <Check className="size-4 text-ok" strokeWidth={3} /> : state === "now" ? <Loader2 className="size-4 animate-spin text-live" /> : <Circle className="size-3.5 text-muted-foreground/50" />}
                    </span>
                    <div className="min-w-0">
                      <div className={cn("text-[13px]", state === "idle" ? "text-muted-foreground" : "text-text")}>{ph.label}</div>
                      {state === "done" && a && !running && <div className="mt-0.5 text-[12px] text-muted-foreground tnum">{ph.done(a)}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
            {!p?.mdb_file && !isLoading && (
              <p className="mt-4 rounded-chip border border-dashed border-border px-3 py-2.5 text-[12.5px] text-muted-foreground">No MDB is loaded in this project yet. Import one first, then run the allocation here.</p>
            )}
            {run.isError && !running && <p role="alert" className="mt-4 rounded-chip border border-err/40 bg-err/10 px-3 py-2 text-[12.5px] text-err">The allocation did not run: {(run.error as Error).message}</p>}
          </section>

          <section className="card-surface col-span-12 p-5 xl:col-span-5" data-testid="outcome-card">
            <h2 className="label-caps">What came out</h2>
            {!a ? (
              <div className="mt-3 space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-3">
                <Stat k="Cabinets" v={a.kpis.cabinets} sub={`${new Set(a.cabinets.map((c) => c.controller)).size} controllers`} />
                <Stat k="CIOCs" v={a.kpis.ciocs} sub={`${a.kpis.baseplates_used} baseplates used`} />
                <Stat k="Fill" v={a.kpis.fill_pct} decimals={1} suffix="%" sub="of every slot" />
                <Stat k="Open questions" v={a.kpis.tqs_open} sub={`${a.kpis.unallocated_with_tq} signals unplaced`} tone={a.kpis.tqs_open ? "warn" : "ok"} />
                <Stat k="Violations" v={a.report.violations} sub={`${ruleChecks(a.report)} · ${a.kpis.signals} signals`} tone={a.report.violations ? "err" : "ok"} />
                <Stat k="Wired spares" v={a.kpis.wired_spares} sub={`target ${a.kpis.wired_target}`} />
              </dl>
            )}
            {a && ranHere && !running && run.isSuccess && (
              <Button variant="outline" size="sm" className="mt-4 w-full gap-2" onClick={() => nav("/proof")}>Prove it — open the verifier <ArrowRight className="size-4" /></Button>
            )}
          </section>

          <section className="col-span-12" aria-label="Cabinets">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="label-caps">Cabinet fill</h2>
              {a && a.cabinets.length > MAX_CARDS && <span className="text-[12px] text-muted-foreground">first {MAX_CARDS} of {a.cabinets.length} · all of them are in the 3D Room</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="cabinet-cards">
              {!a
                ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-36 w-full" />)
                : a.cabinets.slice(0, MAX_CARDS).map((c, i) => {
                    const sp = spares.get(c.name);
                    const used = c.ciocs.reduce((n, x) => n + x.used, 0);
                    const cap = c.ciocs.reduce((n, x) => n + x.capacity, 0);
                    const fill = sp?.fill_pct ?? (cap ? (used / cap) * 100 : 0);
                    return (
                      <motion.button
                        key={c.name} type="button" onClick={() => openInRoom(nav, i)}
                        initial={calm ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: Math.min(i, 8) * 0.04, ease: EASE }}
                        whileHover={{ y: -2 }}
                        className="card-surface flex flex-col gap-3 p-4 text-left transition-colors hover:border-brand/50"
                        data-testid="cabinet-card" aria-label={`${c.name}, ${fill.toFixed(1)} percent full — open in the 3D Room`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-mono text-[12.5px] font-medium">{c.name}</div>
                            <div className="truncate text-[11.5px] text-muted-foreground">{c.controller}</div>
                          </div>
                          <span className="text-[18px] font-semibold tnum">{fill.toFixed(1)}%</span>
                        </div>
                        <div className="flex gap-1" aria-hidden>
                          {c.ciocs.map((ci) => (
                            <div key={ci.name} className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" title={`${ci.name}: ${ci.used}/${ci.capacity}`}>
                              <div className="h-full rounded-full bg-brand" style={{ width: `${ci.capacity ? (ci.used / ci.capacity) * 100 : 0}%` }} />
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground tnum">
                          <span><b className="text-text">{used}</b> signals</span>
                          <span><b className="text-text">{sp?.wired_spares ?? c.ciocs.reduce((n, x) => n + x.wired_spares, 0)}</b> wired spares</span>
                          {sp && <span><b className="text-text">{sp.empty_baseplates}</b> empty baseplates</span>}
                        </div>
                      </motion.button>
                    );
                  })}
            </div>
            {a && !a.cabinets.length && <p className="rounded-chip border border-dashed border-border px-3 py-3 text-[12.5px] text-muted-foreground">No cabinet was needed — there is nothing allocated yet.</p>}
          </section>
        </div>
      </div>
    </ScrollArea>
  );
}

function Stat({ k, v, sub, decimals, suffix, tone }: { k: string; v: number; sub?: string; decimals?: number; suffix?: string; tone?: "ok" | "warn" | "err" }) {
  return (
    <div className="rounded-chip border border-border bg-raised/40 px-3 py-2.5">
      <dt className="label-caps">{k}</dt>
      <dd className={cn("mt-0.5 text-[22px] font-semibold leading-tight tnum", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "err" && "text-err")}>
        <CountUp value={v} decimals={decimals} />{suffix}
      </dd>
      {sub && <div className="text-[11.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

