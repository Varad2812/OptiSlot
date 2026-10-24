import { motion, useTransform } from "framer-motion";
import { ArrowUpRight, FlaskConical } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";

import type { Dims, WorldModel } from "@/api/derive";
import { useAllocation, useRuns } from "@/api/hooks";
import { useRevisionImpact } from "@/api/sandbox";
import { Panel, SEV, SEV_RANK } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IO_COLOURS, IO_LABELS, IO_ORDER, ioKey, type IoKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { useSequence } from "@/motion/sequence";
import { EASE, phase, useCalm } from "@/motion/shared";
import { toneOf } from "@/revisions/parts";
import { CountUp } from "@/shell/CountUp";
import { useUi } from "@/store/ui";
import { openInRoom } from "@/world/actions";
import type { DiffKind } from "@/world/DiffOverlay";
import { MINI_CABINETS } from "@/world3d/miniRoomSize";

const MiniRoom = lazy(() => import("@/world3d/MiniRoom"));

/** Big projects (10k ≈ 46 cabinets) show their first few; the rest is one "+N more" away in the 3D Room. */
export const RING_CABINETS = 6;
export const HEAT_CABINETS = 8;

const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div className="space-y-2">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
);

const short = (v: string) => (v.length > 16 ? `${v.slice(0, 10)}…${v.slice(-4)}` : v);
const stripDcm = (n: string) => n.replace("-DCM", "");

/** More cabinets than the card shows → a chip that opens the Room (where all of them live). */
function More({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <Link to="/room" data-stop className={cn("inline-flex items-center gap-1 rounded-chip border border-border bg-raised px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-brand/50 hover:text-text", className)}>
      +{n} more cabinet{n === 1 ? "" : "s"} <ArrowUpRight className="size-3" />
    </Link>
  );
}

// ───────────── cursor tooltip (the heat-map's, like the reference) ─────────────

function useTip() {
  const [t, setT] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const node = t
    ? createPortal(
        <div
          className="pointer-events-none fixed z-50 rounded-chip border border-brand/50 bg-raised px-2.5 py-1.5 font-mono text-[11.5px] leading-snug shadow-xl"
          style={{ left: Math.min(t.x + 14, window.innerWidth - 250), top: t.y - 10 }}
        >
          {t.body}
        </div>,
        document.body,
      )
    : null;
  return { node, show: (e: MouseEvent, body: ReactNode) => setT({ x: e.clientX, y: e.clientY, body }), hide: () => setT(null) };
}

// ───────────── live mini room ─────────────

/** Our World3D engine in its low-cost mode (first few cabinets, slow drift). Click a cabinet → the Room, door open. */
export function MiniRoomCard({ model, dims, hot, setHot, onFail, delay }: { model: WorldModel; dims: Dims; hot: number | null; setHot: (c: number | null) => void; onFail: () => void; delay?: number }) {
  const nav = useNavigate();
  const n = model.cabinets.length;
  const shown = Math.min(n, MINI_CABINETS);
  const hv = hot != null && hot < shown ? model.cabinets[hot] : null;
  return (
    <Panel
      title="Marshalling room" delay={delay} to="/room"
      aside={
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-live" />
          {n > shown ? `first ${shown} of ${n} cabinets` : `${n} cabinet${n === 1 ? "" : "s"}`} · click one to dive in
        </span>
      }
    >
      <div className="relative h-full min-h-[300px] overflow-hidden rounded-card border border-border bg-[#0A0D13]" data-stop data-testid="mini-room-card">
        <Suspense fallback={<Skeleton className="size-full" />}>
          <MiniRoom model={model} dims={dims} hot={hot} onHot={setHot} onPick={(c) => openInRoom(nav, c)} onFail={onFail} />
        </Suspense>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,.5))]" />
        <div className="pointer-events-none absolute bottom-2.5 left-3 right-3 flex items-end justify-between gap-3 font-mono text-[11.5px] text-[#8C95A8]">
          <span className="min-w-0 truncate">
            {hv ? (
              <>
                <b className="font-medium text-[#ECEEF3]">{hv.info.name}</b> · {hv.counts.field} field · {hv.counts.wired} wired spare · click to open
              </>
            ) : (
              "Hover a cabinet to outline it"
            )}
          </span>
          {n > shown && <span className="pointer-events-auto shrink-0"><More n={n - shown} /></span>}
        </div>
      </div>
    </Panel>
  );
}

// ───────────── run certificate ─────────────

/** The independent checks tick in one by one (the Proof Center's sweep, in miniature). */
export function CertCard({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const calm = useCalm();
  const c = a?.certificate;
  const checks = a?.report.checks ?? [];
  const [on, setOn] = useState(0);
  useEffect(() => {
    if (!checks.length) return;
    if (calm) return setOn(checks.length);
    setOn(0);
    let i = 0;
    const iv = window.setInterval(() => {
      setOn(++i);
      if (i >= checks.length) window.clearInterval(iv);
    }, 55);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks.length, a?.run_id, calm]);
  const pass = c?.verdict === "PASS";
  return (
    <Panel
      title="Run certificate" delay={delay} to="/proof"
      aside={c && <span className={cn("rounded-chip px-2 py-0.5 text-[11px] font-semibold", pass ? "bg-ok/15 text-ok" : "bg-err/15 text-err")}>{pass ? "✓ PASS" : "✕ FAIL"}</span>}
    >
      {!c ? <Loading /> : (
        <>
          <div className={cn("text-[26px] font-semibold tnum", pass ? "text-ok" : "text-err")}>
            <CountUp value={c.violations} /> violation{c.violations === 1 ? "" : "s"} <span className="text-muted-foreground">·</span>{" "}
            <span className="text-text">{c.checks_passed === c.checks_total ? <><CountUp value={c.checks_total} /> rule checks</> : <><CountUp value={c.checks_passed} />/{c.checks_total} rule checks</>}</span>
          </div>
          {a?.kpis && <div className="mt-0.5 text-[11.5px] text-muted-foreground tnum">{a.kpis.signals.toLocaleString("en-US")} signals checked</div>}
          <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-1.5 text-[12px]">
            {([["# Input MDB", c.mdb_sha256], ["# Rule set", c.ruleset_hash], ["# Output", c.output_sha256]] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right font-mono text-[11.5px]" title={v}>{short(v)}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">Engine</dt>
            <dd className="text-right font-mono text-[11.5px]">{c.engine_version} · {c.timestamp.replace("T", " ").replace("Z", "")}</dd>
          </dl>
          <div className="mt-3 flex gap-1" aria-label="Verifier checks">
            {checks.map((ch, i) => (
              <i
                key={ch.id}
                title={`${ch.id} ${ch.label} — ${ch.failed ? `${ch.failed} failed` : ch.excepted ? `${ch.excepted} excepted by TQ` : `${ch.passed} passed`}`}
                className={cn(
                  "h-2 flex-1 rounded-[2px] transition-[background-color,box-shadow] duration-300",
                  i >= on ? "bg-border" : ch.failed ? "bg-err shadow-[0_0_6px_rgb(248_113_113/.5)]" : ch.excepted ? "bg-warn" : "bg-ok shadow-[0_0_6px_rgb(52_211_153/.45)]",
                )}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// ───────────── revision stability: arc + needle ─────────────

const KIND_GLYPH: Record<DiffKind, string> = { added: "+", deleted: "−", modified: "~", moved: "↷" };
const KINDS: DiffKind[] = ["added", "deleted", "modified", "moved"];
const CX = 100, CY = 104, R = 80, NEEDLE = 66;
const ARC = `M${CX - R} ${CY}A${R} ${R} 0 0 1 ${CX + R} ${CY}`;

/**
 * The arc sweeps and the needle swings (a small overshoot) to the stability the server computed for the loaded revision pair.
 * Before any revision exists it rests at 0 on the baseline — never an invented value.
 */
export function StabilityCard({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const { data: impact } = useRevisionImpact();
  const nav = useNavigate();
  const calm = useCalm();
  const seq = useSequence(0);
  const live = !!a && a.kpis.stability_pct != null && !!impact;
  const value = live ? impact!.stability_pct : 0;
  useEffect(() => {
    if (live) void seq.play(calm ? 0.3 : 1.8);
  }, [live, seq, calm]);
  const sweep = useTransform(seq.progress, (v) => (value / 100) * phase(v, 0.05, 0.85));
  // the needle runs a touch ahead of the arc through the sweep, then settles back onto the value
  const ang = useTransform(seq.progress, (v) => {
    const q = phase(v, 0.05, 0.95);
    const over = q < 1 ? Math.sin(q * Math.PI) * 0.05 : 0;
    return Math.PI * (1 - (value / 100) * Math.min(1.02, phase(v, 0.05, 0.85) + over));
  });
  const x2 = useTransform(ang, (t) => CX + NEEDLE * Math.cos(t));
  const y2 = useTransform(ang, (t) => CY - NEEDLE * Math.sin(t));
  const follow = useTransform(seq.progress, (v) => phase(v, 0.05, 0.85));
  const inject = () => {
    useUi.getState().requestInject();
    nav("/revisions");
  };
  return (
    <Panel
      title="Revision stability" delay={delay} to="/revisions"
      aside={
        live && impact ? <span className="font-mono text-[11px] text-muted-foreground">Rev {impact.from_rev} → {impact.to_rev}</span>
          : a && <span className="rounded-chip border border-border bg-raised px-1.5 py-0.5 text-[11px] text-muted-foreground">Rev {a.revision} · baseline</span>
      }
    >
      {!a ? <Loading /> : (
        <div className="flex items-center gap-4" data-testid="stability-gauge">
          <svg viewBox="0 0 200 122" className="h-[118px] w-[200px] shrink-0" aria-hidden>
            <defs>
              <linearGradient id="mc-gauge" x1="0" x2="1"><stop offset="0" stopColor="#7C5CFF" /><stop offset="1" stopColor="#22D3EE" /></linearGradient>
            </defs>
            <path d={ARC} fill="none" strokeWidth={10} strokeLinecap="round" className="stroke-border" />
            <motion.path d={ARC} fill="none" strokeWidth={10} strokeLinecap="round" stroke="url(#mc-gauge)" style={{ pathLength: sweep }} />
            {[0, 25, 50, 75, 100].map((t) => {
              const th = Math.PI * (1 - t / 100);
              return <line key={t} x1={CX + (R + 9) * Math.cos(th)} y1={CY - (R + 9) * Math.sin(th)} x2={CX + (R + 14) * Math.cos(th)} y2={CY - (R + 14) * Math.sin(th)} className="stroke-muted-foreground" strokeOpacity={0.5} />;
            })}
            <motion.line x1={CX} y1={CY} x2={x2} y2={y2} strokeWidth={2.5} strokeLinecap="round" className="stroke-text" />
            <circle cx={CX} cy={CY} r={6} className="fill-text" />
            <text x={CX} y={CY + 17} textAnchor="middle" fontSize={9} letterSpacing={2} className="fill-muted-foreground font-mono">STABILITY</text>
          </svg>
          <div className="min-w-0 text-[12.5px] leading-snug text-muted-foreground">
            {live && impact ? (
              <>
                <div className="text-[26px] font-semibold leading-8 text-brand tnum"><CountUp value={impact.stability_pct} decimals={1} suffix="%" follow={follow} /></div>
                <div><span className="tnum font-semibold text-text">{impact.unchanged_in_place}</span> of <span className="tnum">{impact.previous_live}</span> signals sat still.</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {KINDS.map((k) => (
                    <span key={k} className={cn("flex items-center gap-1 rounded-chip px-1.5 py-0.5 text-[11px]", toneOf(k).chip)}>
                      <span className="font-mono font-semibold">{KIND_GLYPH[k]}</span><span className="tnum font-semibold">{impact[k].length}</span><span className="opacity-80">{k}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <>
                Rev {a.revision} is the baseline. All <b className="tnum text-text">{a.kpis.signals}</b> live signals are pinned and stay in their slots when Rev B arrives.
                <div className="mt-2.5"><Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11.5px]" data-stop onClick={inject}><FlaskConical className="size-3.5" /> Inject Rev B</Button></div>
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ───────────── cabinet fill rings ─────────────

const RING_R = 34;

/** The IO family most of a cabinet's field signals belong to — the colour of its ring. */
function dominantIo(slots: WorldModel["cabinets"][number]["slots"]): IoKey {
  const t = new Map<IoKey, number>();
  for (const s of slots) if (s.status === "Field") t.set(ioKey(s), (t.get(ioKey(s)) ?? 0) + 1);
  let best: IoKey = "ai", n = -1;
  for (const [k, v] of t) if (v > n) (best = k), (n = v);
  return best;
}

export function RingsCard({ model, hot, setHot, delay }: { model: WorldModel; hot: number | null; setHot: (c: number | null) => void; delay?: number }) {
  const { data: a } = useAllocation();
  const nav = useNavigate();
  const calm = useCalm();
  const spares = useMemo(() => new Map((a?.kpis.spares_per_cabinet ?? []).map((c) => [c.cabinet, c])), [a]);
  const cabs = useMemo(() => model.cabinets.slice(0, RING_CABINETS), [model]);
  const colours = useMemo(() => cabs.map((c) => IO_COLOURS[dominantIo(c.slots)]), [cabs]);
  return (
    <Panel title="Cabinet fill" delay={delay} to="/room" aside={a && <span className="rounded-chip border border-border bg-raised px-1.5 py-0.5 text-[11px] text-muted-foreground tnum">{a.kpis.fill_pct.toFixed(1)}% overall</span>}>
      {!a ? <Loading /> : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center" data-stop>
            {cabs.map((cv, i) => {
              const sp = spares.get(cv.info.name);
              const pct = sp?.fill_pct ?? 0;
              const col = colours[i];
              return (
                <button
                  key={cv.info.name} data-testid="fill-ring"
                  onClick={() => openInRoom(nav, cv.index)} onMouseEnter={() => setHot(cv.index)} onMouseLeave={() => setHot(null)}
                  onFocus={() => setHot(cv.index)} onBlur={() => setHot(null)}
                  title={`${cv.info.name} — ${pct.toFixed(1)}% full. Open it in the 3D Room.`}
                  className={cn("rounded-card border px-0.5 py-1.5 transition-colors", hot === cv.index ? "border-brand/60 bg-brand/10" : "border-transparent hover:border-brand/40 hover:bg-brand/5")}
                >
                  <svg viewBox="0 0 92 92" className="mx-auto size-[88px]" aria-hidden>
                    <circle cx={46} cy={46} r={RING_R} fill="none" strokeWidth={8} className="stroke-border" />
                    <motion.circle
                      cx={46} cy={46} r={RING_R} fill="none" strokeWidth={8} strokeLinecap="round" stroke={col} transform="rotate(-90 46 46)"
                      style={{ filter: `drop-shadow(0 0 4px ${col}88)` }}
                      initial={{ pathLength: calm ? Math.max(pct / 100, 0.004) : 0 }} animate={{ pathLength: Math.max(pct / 100, 0.004) }}
                      transition={{ duration: calm ? 0.15 : 1.2, delay: calm ? 0 : 0.2 + i * 0.12, ease: EASE }}
                    />
                    <text x={46} y={51} textAnchor="middle" fontSize={16} fontWeight={600} className="fill-text font-mono">{Math.round(pct)}%</text>
                  </svg>
                  <div className="truncate font-mono text-[10.5px] font-semibold" title={cv.info.name}>{stripDcm(cv.info.name)}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{sp ? `${sp.used} used · ${sp.wired_spares} wired` : "—"}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{sp ? `${sp.spare_slots} spare · ${sp.empty_baseplates} BP free` : "—"}</div>
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-end"><More n={model.cabinets.length - cabs.length} /></div>
        </>
      )}
    </Panel>
  );
}

// ───────────── wired spares vs target (bullet charts) ─────────────

const IO_RANK: Record<string, number> = { AIR: 0, AOR: 1, DIR: 2, DOR: 3 };

/** One bullet per IO type, summed over controllers: wired spares as the bar, the rule's target as the white line. */
export function BulletsCard({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const calm = useCalm();
  const rows = useMemo(() => {
    const m = new Map<string, { io: string; wired: number; target: number; ok: boolean }>();
    for (const c of a?.kpis.spare_compliance ?? []) {
      const r = m.get(c.io_type) ?? { io: c.io_type, wired: 0, target: 0, ok: true };
      r.wired += c.wired;
      r.target += c.target;
      r.ok &&= c.ok;
      m.set(c.io_type, r);
    }
    return [...m.values()].sort((x, y) => (IO_RANK[x.io] ?? 9) - (IO_RANK[y.io] ?? 9) || x.io.localeCompare(y.io));
  }, [a]);
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.wired, r.target))) * 1.3;
  const lacking = rows.filter((r) => !r.ok).length;
  return (
    <Panel
      title="Wired spares vs target" delay={delay} to="/rules"
      aside={a && <span className={cn("rounded-chip px-1.5 py-0.5 text-[11px] font-semibold", lacking ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok")}>{lacking ? `${lacking} short` : "all met"}</span>}
    >
      {!a ? <Loading /> : !rows.length ? <p className="text-muted-foreground">No wired-spare target applies to this project.</p> : (
        <div data-testid="bullets">
          {rows.map((r, i) => {
            const col = IO_COLOURS[ioKey({ status: "Field", io_type: r.io })];
            return (
              <div key={r.io} className="mb-3 grid grid-cols-[40px_1fr_auto] items-center gap-2.5 font-mono text-[11.5px]" title={`${r.io}: ${r.wired} wired spares, target ${r.target} (summed over controllers)`}>
                <span style={{ color: col }}>{r.io}</span>
                <div className="relative h-3.5 rounded-[4px] bg-raised">
                  <motion.i
                    className="absolute left-0 top-1 h-1.5 rounded-[3px]" style={{ background: col, boxShadow: `0 0 8px ${col}88` }}
                    initial={{ width: calm ? `${(100 * r.wired) / scale}%` : 0 }} animate={{ width: `${(100 * r.wired) / scale}%` }}
                    transition={{ duration: calm ? 0.15 : 1.1, delay: calm ? 0 : 0.3 + i * 0.12, ease: EASE }}
                  />
                  <u className="absolute -bottom-0.5 -top-0.5 w-0.5 bg-text no-underline shadow-[0_0_6px_rgb(255_255_255/.5)]" style={{ left: `${(100 * r.target) / scale}%` }} />
                </div>
                <span className={cn("min-w-[72px] whitespace-nowrap text-right", r.ok ? "text-text" : "text-warn")}>{r.wired}/{r.target} {r.ok ? "✓" : "!"}</span>
              </div>
            );
          })}
          <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground">
            <span>● wired spares</span><span>| target ⌈% × field⌉</span><span>{a.kpis.wired_spares} / {a.kpis.wired_target}</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ───────────── TQs + run-history sparkline ─────────────

const SPARK_W = 300, SPARK_H = 70;

function Spark({ values }: { values: number[] }) {
  const calm = useCalm();
  const top = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * SPARK_W : SPARK_W, 8 + (1 - v / top) * (SPARK_H - 20)] as const);
  const line = `M${pts.map((p) => p.join(",")).join("L")}`;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="h-[70px] w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id="mc-spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#22D3EE" stopOpacity=".3" /><stop offset="1" stopColor="#22D3EE" stopOpacity="0" /></linearGradient>
      </defs>
      {pts.length > 1 && <path d={`${line}L${SPARK_W},${SPARK_H}L0,${SPARK_H}Z`} fill="url(#mc-spark)" />}
      <motion.path
        d={pts.length > 1 ? line : `M0,${last[1]}L${SPARK_W},${last[1]}`} fill="none" stroke="#22D3EE" strokeWidth={2} vectorEffect="non-scaling-stroke"
        initial={{ pathLength: calm ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: calm ? 0.15 : 1.6, delay: calm ? 0 : 0.4, ease: "easeOut" }}
      />
    </svg>
  );
}

export function TqCard({ delay, limit = 3 }: { delay?: number; limit?: number }) {
  const { data: a } = useAllocation();
  const { data: runs } = useRuns();
  const tqs = useMemo(
    () => [...(a?.tqs ?? [])].sort((x, y) => Number(y.status === "open") - Number(x.status === "open") || (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9)),
    [a],
  );
  const hist = useMemo(() => [...(runs ?? [])].filter((r) => r.kind !== "verify-file").sort((x, y) => x.timestamp.localeCompare(y.timestamp)).slice(-24), [runs]);
  // no recorded history yet → the current run is the only point, and it is real
  const trend = hist.length ? hist.map((r) => r.violations) : a ? [a.report.violations] : [];
  const open = a?.kpis.tqs_open ?? 0;
  return (
    <Panel
      title="Technical queries" delay={delay} to="/tqs"
      aside={a && <span className={cn("rounded-chip px-1.5 py-0.5 text-[11px] font-semibold tnum", open ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok")}>{open} open</span>}
    >
      {!a ? <Loading /> : (
        <>
          {!tqs.length ? <p className="text-muted-foreground">No TQs — every live signal placed cleanly.</p> : (
            <ul className="space-y-2">
              {tqs.slice(0, limit).map((t) => (
                <li key={t.id}>
                  <Link to="/tqs" className="block rounded-card border border-border bg-raised/50 p-2.5 transition-colors hover:border-brand/40 hover:bg-raised">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-muted-foreground">{t.id}</span>
                      <span className={cn("rounded-[4px] px-1.5 py-px font-medium", SEV[t.severity] ?? SEV.low)}>{t.severity}</span>
                      <span className="ml-auto text-muted-foreground">{t.confidence}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{t.message}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {tqs.length > limit && <p className="mt-1.5 text-[11.5px] text-muted-foreground">+{tqs.length - limit} more in the TQ Center</p>}
          <Link to="/proof" data-stop className="mt-3 block rounded-card border border-transparent px-1 pt-1 transition-colors hover:border-brand/30" title="Run history — open the Proof Center">
            <div className="mb-1 text-[11.5px] text-muted-foreground">Run history · violations per run</div>
            <Spark values={trend} />
            <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground">
              <span>{trend.length > 1 ? `${trend.length} runs` : "1 run"}</span>
              <span>{a.run_id} ●</span>
            </div>
          </Link>
        </>
      )}
    </Panel>
  );
}

// ───────────── CIOC fill heat-map ─────────────

/** Cabinet × CIOC, each CIOC drawn as its baseplates. Cell → that CIOC in the 3D Room; a row's name highlights its cabinet in the live room. */
export function HeatCard({ model, dims, setHot, delay }: { model: WorldModel; dims: Dims; setHot: (c: number | null) => void; delay?: number }) {
  const nav = useNavigate();
  const calm = useCalm();
  const tip = useTip();
  const rows = model.cabinets.slice(0, HEAT_CABINETS);
  return (
    <Panel
      title="CIOC fill heat-map" delay={delay} to="/room"
      aside={
        <span className="hidden items-center gap-3 text-[10.5px] text-muted-foreground xl:flex">
          {IO_ORDER.map((k) => <span key={k} className="flex items-center gap-1"><span className="size-2 rounded-[2px]" style={{ background: IO_COLOURS[k] }} />{IO_LABELS[k]}</span>)}
        </span>
      }
    >
      <div data-stop>
        <div className="grid items-center gap-x-3.5 gap-y-2" style={{ gridTemplateColumns: `148px repeat(${dims.ciocsPerCabinet}, minmax(0,1fr))` }} data-testid="heat-map">
          <span />
          {Array.from({ length: dims.ciocsPerCabinet }, (_, i) => (
            <span key={i} className="text-[10.5px] text-muted-foreground">CIOC {i + 1} · {i < dims.ciocsPerSide ? "front" : "rear"}</span>
          ))}
          {rows.map((v) => (
            <div key={v.info.name} className="contents">
              <span
                className="truncate font-mono text-[11px] text-muted-foreground" title={`${v.info.name} · ${v.info.controller}`}
                onMouseEnter={() => setHot(v.index)} onMouseLeave={() => setHot(null)}
              >
                {v.info.name}
              </span>
              {v.info.ciocs.map((c) => {
                const pct = c.capacity ? (100 * (c.used + c.wired_spares)) / c.capacity : 0;
                const bps = v.heat.filter((h) => h.ciocLocal === c.local);
                const usedBps = bps.filter((h) => h.fill > 0).length;
                const face = c.local > dims.ciocsPerSide ? "R" : "F";
                return (
                  <button
                    key={c.local} data-testid="heat-cell"
                    onClick={() => openInRoom(nav, v.index, { cioc: c.local, face })}
                    onMouseMove={(e) => {
                      setHot(v.index);
                      tip.show(e, <>{v.info.name}<br />{c.name} · CIOC {c.local} · {face === "F" ? "front" : "rear"}<br /><b>{pct.toFixed(1)}%</b> fill · {usedBps}/{bps.length} BP · {bps.length - usedBps} empty</>);
                    }}
                    onMouseLeave={() => (tip.hide(), setHot(null))}
                    className="rounded-card border border-border bg-background p-1.5 text-left transition-[border-color,box-shadow] hover:border-brand/60 hover:shadow-[0_0_12px_rgb(124_92_255/.3)] focus-visible:border-brand/60 focus-visible:outline-none"
                  >
                    <div className="flex gap-[3px]">
                      {bps.map((h, i) => {
                        const col = h.io ? IO_COLOURS[h.io] : null;
                        return (
                          <motion.span
                            key={h.bp}
                            initial={calm ? false : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.4, delay: calm ? 0 : 0.15 + (v.index * dims.ciocsPerCabinet + c.local) * 0.03 + i * 0.025, ease: EASE }}
                            className={cn("h-3.5 flex-1 rounded-[3px]", h.fill === 0 && "border border-dashed bg-raised/60", h.fill === 0 && (h.reserved ? "border-muted-foreground/60" : "border-[color:var(--spare)]"))}
                            // intensity rides on the colour's alpha so the entrance animation owns opacity
                            style={h.fill > 0 && col ? { background: `color-mix(in srgb, ${col} ${Math.round(34 + 66 * Math.min(1, h.fill))}%, transparent)`, boxShadow: `0 0 6px ${col}55` } : undefined}
                          />
                        );
                      })}
                    </div>
                    <div className="mt-1.5 font-mono text-[11px] font-semibold">{pct.toFixed(0)}% <span className="font-normal text-muted-foreground">· {usedBps}/{bps.length} BP</span></div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>Each square is a baseplate · tint = fill · dashed = reserved or empty. Click a CIOC to open it in the 3D Room.</span>
          <More n={model.cabinets.length - rows.length} />
        </div>
      </div>
      {tip.node}
    </Panel>
  );
}
