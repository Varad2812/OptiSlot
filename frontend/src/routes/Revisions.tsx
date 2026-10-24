import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CheckCircle2, FlaskConical, Loader2, RefreshCw, RotateCcw, ShieldCheck, Upload, XCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject, useProjectId, type AllocationResult, type Project } from "@/api/hooks";
import { useRevisionImpact, type RevisionImpact } from "@/api/sandbox";
import { Panel } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { demoMode, registerDemo } from "@/motion/demoHooks";
import { useSequence } from "@/motion/sequence";
import { EASE, useCalm } from "@/motion/shared";
import { diff3d } from "@/revisions/diff3d";
import { ChangeList, KindCard, StabilityGauge } from "@/revisions/parts";
import { useRevisionFlow } from "@/revisions/useRevisionFlow";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { CabinetWorld } from "@/world/CabinetWorld";
import { buildDiff, DiffOverlay, type DiffItem, type DiffKind } from "@/world/DiffOverlay";
import { sideOf, type Insets } from "@/world/geometry";
import { PlantStrip } from "@/world/PlantStrip";
import { useStage } from "@/world/useStage";
import type { World3DEngine } from "@/world3d/engine";
import { hasWebGL } from "@/world3d/support";

const World3D = lazy(() => import("@/world3d/World3D"));

const INSETS: Insets = { top: 56, right: 18, bottom: 56, left: 18 };
const PLAY_S = 3.4;
const PLAY_CALM_S = 0.8;
const KINDS: DiffKind[] = ["added", "deleted", "modified", "moved"];

export default function Revisions() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const { data: impact } = useRevisionImpact();
  if (!a) {
    return (
      <div className="grid h-full grid-rows-[48px_110px_1fr] gap-3 p-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return <RevisionInner a={a} p={p} impact={impact ?? null} />;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function RevisionInner({ a, p, impact }: { a: AllocationResult; p: Project | undefined; impact: RevisionImpact | null }) {
  const pid = useProjectId();
  const qc = useQueryClient();
  const calm = useCalm();
  const ui = useUi();
  const flow = useRevisionFlow();
  const seq = useSequence(1);
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => worldModel(a, dims), [a, dims]);
  const stage = useStage(model.cabinets.length, dims, INSETS);
  const { data: revA } = useQuery({ queryKey: ["revA", pid], queryFn: async () => null as AllocationResult | null, enabled: false, staleTime: Infinity });

  const items = useMemo(() => (impact ? buildDiff(impact, model, revA) : []), [impact, model, revA]);

  // 3D stage (§10.7 motion 5): the same sequence drives the 3D diff — unchanged CHARMs dim, new fade in cyan, removed
  // dissolve red, changed pulse amber, moved fly. 2D World as the fallback.
  const use3d = useUi((s) => s.view3d) && hasWebGL();
  const eng = useRef<World3DEngine | null>(null);
  const onEngine = useCallback((e: World3DEngine | null) => (eng.current = e), []);
  const revAModel = useMemo(() => (revA ? worldModel(revA, dimsOf(revA, p)) : null), [revA, p]);
  const d3 = useMemo(() => (impact ? diff3d(impact, model, revAModel) : null), [impact, model, revAModel]);
  const d3Ref = useRef(d3);
  d3Ref.current = d3;
  const diffOn = useRef(false);
  useEffect(() => {
    if (!use3d) return;
    return seq.progress.on("change", (v) => {
      const e = eng.current, d = d3Ref.current;
      if (!e || !d || !diffOn.current) return;
      if (e.momentName !== "revdiff") void e.playRevDiff(d, { drive: true, follow: true });
      e.seek(v);
    });
  }, [use3d, seq]);
  const playSeq = useCallback(async (s: number) => {
    diffOn.current = true;
    await seq.play(s);
    diffOn.current = false;
  }, [seq]);
  const [filter, setFilter] = useState<DiffKind | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const listed = useMemo(() => (filter ? items.filter((i) => i.kind === filter) : items), [items, filter]);
  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k, impact?.[k].length ?? 0])) as Record<DiffKind, number>, [impact]);

  /** Put the camera on the busiest cabinet (and the side holding most of its changes). */
  const showFirst = useCallback((its: DiffItem[]) => {
    const tally = new Map<string, { cab: number; side: "F" | "R"; n: number }>();
    for (const it of its) {
      const l = it.to ?? it.from;
      if (!l) continue;
      const side = sideOf(l.local, dims);
      const k = `${l.cab}/${side}`;
      tally.set(k, { cab: l.cab, side, n: (tally.get(k)?.n ?? 0) + 1 });
    }
    const best = [...tally.values()].sort((x, y) => y.n - x.n || x.cab - y.cab)[0];
    if (!best) return false;
    const move = useUi.getState().cabIdx !== best.cab;
    useUi.setState({ cabIdx: best.cab, side: best.side, level: "cabinet", focusCioc: null, inspectorSlot: null });
    return move;
  }, [dims]);

  /** Inject / upload → refresh → re-verify → (optionally) play the diff. */
  const start = useCallback(
    async (source: "gauntlet" | File, play = true) => {
      seq.seek(0);
      setFilter(null);
      setFocus(null);
      const r = await flow.run(source);
      if (!r) return;
      const m = worldModel(r.alloc, dimsOf(r.alloc, p));
      const its = buildDiff(r.impact, m, qc.getQueryData<AllocationResult>(["revA", pid]));
      const moved = showFirst(its);
      if (!play) return;
      await sleep(moved && !calm ? 800 : 250);
      void playSeq(calm ? PLAY_CALM_S : PLAY_S);
      toast.success(`Rev ${r.impact.to_rev}: ${r.impact.stability_pct.toFixed(1)}% stable`, {
        description: `${r.impact.added.length} added · ${r.impact.deleted.length} deleted · ${r.impact.modified.length} modified · ${r.impact.moved.length} moved`,
      });
    },
    [flow, seq, p, qc, pid, showFirst, calm, playSeq],
  );

  // top-bar "Inject Rev B"
  const wanted = ui.injectPending;
  useEffect(() => {
    if (!wanted || flow.busy) return;
    ui.requestInject(false);
    void start("gauntlet");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, flow.busy]);

  // ?demo=1 hooks for scripts/shots.mjs
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!demoMode) return;
    return registerDemo("revb", {
      inject: () => startRef.current("gauntlet", false),
      seek: (pp: number) => {
        diffOn.current = true;
        seq.seek(pp);
        diffOn.current = pp < 1;
      },
      replay: () => playSeq(PLAY_S),
    });
  }, [seq, playSeq]);

  const pick = useCallback(
    (it: DiffItem) => {
      const l = it.to ?? it.from;
      if (!l) return;
      setFocus(it.key);
      useUi.setState({ cabIdx: l.cab, side: sideOf(l.local, dims) });
      ui.inspect(l.id);
    },
    [dims, ui],
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (!/\.xlsx?$/i.test(f.name)) return void toast.error("Not an Excel file", { description: "Upload an IO MDB .xlsx" });
    void start(f);
  };

  const overlay = useMemo(
    () => impact && <DiffOverlay items={items} p={seq.progress} cabIdx={stage.idx} side={stage.side} dims={dims} calm={calm} focus={focus} />,
    [impact, items, seq.progress, stage.idx, stage.side, dims, calm, focus],
  );

  const touched = useMemo(() => new Set(items.flatMap((i) => [i.to?.cab, i.from?.cab]).filter((x): x is number => x != null)), [items]);
  const rep = flow.verified ?? a.report;

  return (
    <div className="flex h-full flex-col" data-testid="revisions">
      <input ref={fileRef} type="file" accept=".xlsx,.xls" hidden onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ""))} />
      {/* header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface/50 px-5">
        <h1 className="text-[14px] font-semibold">Revision Center</h1>
        <span className="rounded-chip border border-border bg-raised px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {impact ? `Rev ${impact.from_rev} → Rev ${impact.to_rev}` : `Rev ${a.revision} only`}
        </span>
        <VerifyChip busy={flow.phase === "verifying"} violations={rep.violations} passed={rep.checks_passed} total={rep.checks_total} shown={!!impact || !!flow.verified} />
        <div className="ml-auto flex items-center gap-1.5">
          {impact && (
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => (seq.seek(0), void playSeq(calm ? PLAY_CALM_S : PLAY_S))} data-testid="replay-diff">
              <RotateCcw className="size-3.5" /> Replay diff
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => fileRef.current?.click()} disabled={flow.busy} data-testid="upload-revb">
            <Upload className="size-3.5" /> Upload your own Rev B
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => void start("gauntlet")} disabled={flow.busy} data-testid="inject-revb">
            {flow.phase === "injecting" ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />} Inject Rev B
          </Button>
        </div>
      </div>

      {impact ? (
        <>
          <div className="grid shrink-0 grid-cols-6 gap-2.5 border-b border-border bg-surface/30 px-5 py-3">
            <div className="card-surface col-span-2 px-4 py-2.5">
              <div className="label-caps mb-1">Stability</div>
              <StabilityGauge value={impact.stability_pct} p={seq.progress} unchanged={impact.unchanged_in_place} previous={impact.previous_live} />
            </div>
            {KINDS.map((k) => (
              <KindCard key={k} kind={k} count={counts[k]} p={seq.progress} active={filter === k} onClick={() => setFilter(filter === k ? null : k)} />
            ))}
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              {use3d ? (
                <div className="absolute inset-0 bg-[#0A0D13]" data-testid="revisions-3d">
                  <Suspense fallback={<Skeleton className="h-full w-full" />}>
                    <World3D model={model} dims={dims} match={null} minimal onEngine={onEngine} onFail={() => useUi.getState().setView3d(false)} />
                  </Suspense>
                </div>
              ) : (
                <>
                <div className="bg-world absolute inset-0">
                  <motion.div className="absolute inset-0" style={{ opacity: stage.opacity, rotateY: stage.rotateY, transformPerspective: 1800 }}>
                    <CabinetWorld
                      model={model} dims={dims} cam={stage.cam} side={stage.side} activeIdx={stage.idx} cabinetS={stage.cabinetS}
                      overlay={overlay} onSize={stage.onSize} onSlot={(id) => ui.inspect(id)} onCabinet={(i) => ui.goCabinet(i)}
                    />
                  </motion.div>
                </div>
                <div className="pointer-events-none absolute left-4 top-3 z-10 flex items-center gap-2">
                  <div className="pointer-events-auto flex gap-1">
                    {model.cabinets.map((c) => (
                      <button
                        key={c.info.name} onClick={() => stage.goto(c.index)}
                        className={cn("flex items-center gap-1.5 rounded-chip border px-2 py-1 font-mono text-[11px] backdrop-blur transition-colors", c.index === stage.idx ? "border-brand/60 bg-brand/15 text-text" : "border-border bg-surface/70 text-muted-foreground hover:text-text")}
                      >
                        {touched.has(c.index) && <span className="size-1.5 rounded-full bg-warn" title="changed in this revision" />}
                        {c.info.name}
                      </button>
                    ))}
                  </div>
                </div>
                </>
              )}
              <DiffLegend in3d={use3d} />
            </div>

            <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-surface/60">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                <h2 className="label-caps">What changed, and why</h2>
                <span className="text-[11px] text-muted-foreground tnum">{listed.length}{filter ? ` ${filter}` : ""} · {impact.cabinets_touched.length} cabinet{impact.cabinets_touched.length === 1 ? "" : "s"}</span>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <ChangeList items={listed} model={model} focus={focus} onPick={pick} />
              </ScrollArea>
              <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[12px]">
                <span className="text-muted-foreground">{(impact.new_tqs ?? []).length} new TQ{(impact.new_tqs ?? []).length === 1 ? "" : "s"} raised</span>
                <Link to="/tqs" className="font-medium text-brand underline-offset-2 hover:underline">Open TQ Center</Link>
              </div>
            </aside>
          </div>
        </>
      ) : (
        <Intro busy={flow.busy} onInject={() => void start("gauntlet")} onFile={onFile} />
      )}
    </div>
  );
}

function VerifyChip({ busy, violations, passed, total, shown }: { busy: boolean; violations: number; passed: number; total: number; shown: boolean }) {
  if (!shown && !busy) return null;
  const ok = violations === 0;
  return (
    <motion.span
      key={busy ? "busy" : "done"} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}
      className={cn("flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-[11.5px]", busy ? "border-live/40 text-muted-foreground" : ok ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err")}
      data-testid="reverify-chip"
    >
      {busy ? <RefreshCw className="size-3.5 animate-spin text-live" /> : ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      {busy ? "Re-verifying…" : <>Re-verified · <span className="tnum font-semibold">{violations} violations · {passed}/{total} checks</span></>}
    </motion.span>
  );
}

function DiffLegend({ in3d }: { in3d: boolean }) {
  const items: [string, string][] = in3d
    ? [["bg-live", "Added — fades in"], ["bg-err", "Deleted — dissolves"], ["bg-warn", "Modified — pulses"], ["bg-brand", "Moved — flies"]]
    : [["bg-ok", "Added — drops in"], ["bg-err", "Deleted — fades"], ["bg-warn", "Modified — flips"], ["bg-brand", "Moved — flies"]];
  return (
    <div className="glass absolute bottom-3 left-4 z-10 flex items-center gap-3.5 rounded-card border border-border px-3 py-2 text-[11px] text-muted-foreground">
      {items.map(([c, t]) => (
        <span key={t} className="flex items-center gap-1.5"><span className={cn("size-2.5 rounded-[3px]", c)} />{t}</span>
      ))}
      <span className="text-muted-foreground/80">· everything else stays put{in3d ? " (dimmed while it plays)" : ""}</span>
    </div>
  );
}

const SCENARIO = [
  "Delete 1 tag — its slot is freed",
  "Change 1 standard DO to XYV — CHARM and terminal block swap in place",
  "Add 1 tag on a spare pair of an existing cable — it lands on its own pair",
  "Add 1 new 12-pair cable — the normal engine finds a free block",
  "Add 1 corrupt row (DO with instrument type UZV) — allocated, with a TQ",
  "Add 1 row missing its pair — quarantined, never silently dropped",
];

/** Before any revision exists the page is still full: the plant, the deterministic scenario, and the upload drop zone. */
function Intro({ busy, onInject, onFile }: { busy: boolean; onInject: () => void; onFile: (f: File | undefined) => void }) {
  const [over, setOver] = useState(false);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="grid grid-cols-12 gap-4 p-5">
        <div className="col-span-12"><PlantStrip height={250} /></div>
        <div className="col-span-12 xl:col-span-7">
          <Panel title="The Revision Gauntlet" delay={0.04} aside={<span className="text-[11px] text-muted-foreground">deterministic · same result every time</span>}>
            <ol className="space-y-2">
              {SCENARIO.map((s, i) => (
                <li key={s} className="flex items-start gap-3 text-[12.5px]">
                  <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/15 font-mono text-[10.5px] font-semibold text-brand">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
            <div className="mt-4 flex items-center gap-3">
              <Button className="gap-1.5" onClick={onInject} disabled={busy}><FlaskConical className="size-4" /> Inject Rev B</Button>
              <span className="text-[12px] text-muted-foreground">Expected: 0 violations, the right TQs, and only the minimal moves.</span>
            </div>
          </Panel>
        </div>
        <div className="col-span-12 xl:col-span-5">
          <Panel title="Or bring your own Rev B" delay={0.08}>
            <label
              onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
              onDrop={(e) => (e.preventDefault(), setOver(false), onFile(e.dataTransfer.files[0]))}
              className={cn("flex h-[150px] cursor-pointer flex-col items-center justify-center gap-2 rounded-card border border-dashed text-center transition-colors", over ? "border-live bg-live/5" : "border-border hover:border-brand/60")}
            >
              <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ""))} />
              <ShieldCheck className="size-6 text-brand" />
              <span className="text-[13px] font-medium">Drop the revised IO MDB (.xlsx)</span>
              <span className="max-w-[300px] text-[11.5px] text-muted-foreground">Unchanged signals keep their slot; every move carries a reason; the result is re-verified automatically.</span>
            </label>
          </Panel>
        </div>
      </div>
    </ScrollArea>
  );
}
