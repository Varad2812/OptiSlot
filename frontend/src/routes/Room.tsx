import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronRight, FlaskConical, GitCompareArrows, PanelRightClose, PanelRightOpen, Wrench } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { dimsOf, worldModel, type WorldModel } from "@/api/derive";
import { useAllocation, useProject, useProjectId, type AllocationResult, type Project } from "@/api/hooks";
import { usePlacementChanges, useRevisionImpact, type PlacementChangeSet, type PlacementMove, type RevisionImpact } from "@/api/sandbox";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IO_COLOURS, ioKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { markPlayed, moveKey, subscribe, takePending, unseenMoves, type MotionEvent } from "@/motion/bus";
import { useCurtain } from "@/motion/curtain";
import { demoMode, registerDemo } from "@/motion/demoHooks";
import { useSequence } from "@/motion/sequence";
import { EASE, isCalm } from "@/motion/shared";
import { diff3d, diffSize } from "@/revisions/diff3d";
import { RevDiffHud } from "@/revisions/RevDiffHud";
import { useUi } from "@/store/ui";
import { matcher } from "@/world/filters";
import type { RevDiff3D, World3DEngine } from "@/world3d/engine";
import { hasWebGL } from "@/world3d/support";
import type { Overlay3D } from "@/world3d/World3D";

import { ExplorerInner } from "./Explorer";

const World3D = lazy(() => import("@/world3d/World3D"));

type Mode = "before" | "now";

/**
 * 3D Marshalling Room (CLAUDE.md §10.8): the landing page after Import → Allocate → Dive. Full-bleed World3D with the HUD,
 * the [Before | Now] toggle over the Workbench sandbox and the Changes list beside it. No WebGL / too slow → the 2D World.
 */
export default function Room() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const view3d = useUi((s) => s.view3d) && hasWebGL();
  useEffect(() => {
    if (!view3d) useCurtain.getState().lift(); // the 2D World runs its own dive: nothing to wait for
  }, [view3d]);
  if (!a) {
    return (
      <div className="grid h-full grid-cols-[1fr_300px] gap-3 p-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return view3d ? <Room3D a={a} p={p} /> : <ExplorerInner a={a} p={p} />;
}

function Room3D({ a, p }: { a: AllocationResult; p: Project | undefined }) {
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => worldModel(a, dims), [a, dims]);
  const filters = useUi((s) => s.filters);
  const match = useMemo(() => matcher(filters), [filters]);
  const [qs] = useSearchParams();
  const [mode, setMode] = useState<Mode>(qs.get("mode") === "before" ? "before" : "now"); // "Show in 3D · Before" from the Workbench
  const [panel, setPanel] = useState(true);
  const eng = useRef<World3DEngine | null>(null);
  // the World3D chunk loads lazily: a hand-off that arrives first waits for the engine
  const [engWait] = useState(() => {
    let res!: (e: World3DEngine) => void;
    return { p: new Promise<World3DEngine>((r) => (res = r)), res };
  });
  const onEngine = useCallback((e: World3DEngine | null) => ((eng.current = e), e && engWait.res(e)), [engWait]);
  const engine = useCallback(async () => {
    const e = eng.current ?? (await engWait.p);
    await e.whenReady;
    return e;
  }, [engWait]);
  const pid = useProjectId();
  const qc = useQueryClient();
  const changes = usePlacementChanges();
  // a change set computed against another allocation run is stale until the next poll
  const ch = changes.data && changes.data.base_run_id === a.run_id ? changes.data : null;
  const nMoves = ch?.moves?.length ?? 0;
  const nHw = ch?.hardware?.length ?? 0;

  const overlay = useMemo<Overlay3D | null>(() => {
    if (!ch || (!nMoves && !nHw)) return null;
    const hw = (ch.hardware ?? []).map((h) => h.slot_id);
    const to = ch.to_ids ?? [], from = ch.from_ids ?? [];
    if (mode === "before") return { slots: null, outline: [...new Set([...from, ...hw])], ghosts: [] };
    const toSet = new Set(to);
    return { slots: ch.slots_now ?? [], outline: [...new Set([...to, ...hw])], ghosts: from.filter((id) => !toSet.has(id)) };
  }, [ch, mode, nMoves, nHw]);

  // What the Workbench just did (motion bus): a refused target shakes (only if it is under 30 s old); moves come in
  // through the move log below, live from another window or on arrival.
  const [arrivalEv] = useState(takePending);
  const arrival = useRef(arrivalEv);
  const refuse = useCallback(async (slot: string) => void (await engine()).playRefuse(slot, { follow: true }), [engine]);
  const onBus = useCallback((ev: MotionEvent) => {
    if (ev.kind === "move") void qc.invalidateQueries({ queryKey: ["placement-changes", pid] });
    else if (ev.kind === "refused") void refuse(ev.slot);
  }, [qc, pid, refuse]);
  useEffect(() => subscribe(onBus), [onBus]);
  useEffect(() => {
    const a = arrival.current;
    if (a?.kind === "refused") void refuse(a.slot);
  }, [refuse]);

  // Every move applied in the Workbench is remembered (motion bus) until a Room has played it: they fly in, in the order
  // they were applied, however long ago — batch by batch, the camera following. Moves undone since are not in the change set.
  const playing = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (mode !== "now" || changes.isLoading || (changes.data && !ch)) return;
    const present = new Set((ch?.moves ?? []).map(moveKey));
    const fresh = unseenMoves(present);
    if (!fresh.length) return;
    markPlayed(fresh.map((m) => m.key));
    const batches = new Map<number, typeof fresh>();
    for (const m of fresh) (batches.get(m.batch) ?? batches.set(m.batch, []).get(m.batch)!).push(m);
    for (const group of batches.values())
      playing.current = playing.current.then(async () => {
        try {
          await (await engine()).animateMove(group.map((m) => m.from), group.map((m) => m.to), { follow: true });
        } catch {
          /* a skipped animation never blocks the page */
        }
      });
  }, [ch, changes.isLoading, changes.data, mode, engine]);

  // Rev switch (top bar) while the Room is open: play what changed — unchanged CHARMs dim, new ones fade in cyan, removed
  // ones dissolve red, changed ones pulse amber, moved ones fly; the HUD counts the stability up. B → A plays it in reverse.
  const { data: impact } = useRevisionImpact();
  const lastImpact = useRef<RevisionImpact | null>(null);
  if (impact) lastImpact.current = impact;
  const shown = useRef({ rev: a.revision, model });
  const wantDiff = useRef<{ from: string; to: string; prev: WorldModel } | null>(null);
  const seq = useSequence(1);
  const diffOn = useRef(false);
  const [diff, setDiff] = useState<{ d: RevDiff3D; imp: RevisionImpact; back: boolean } | null>(null);
  const diffRef = useRef<RevDiff3D | null>(null);
  useEffect(() => {
    const was = shown.current;
    if (was.rev !== a.revision) wantDiff.current = { from: was.rev, to: a.revision, prev: was.model };
    shown.current = { rev: a.revision, model };
    const w = wantDiff.current, imp = impact ?? lastImpact.current;
    if (!w || !imp) return;
    const fwd = imp.from_rev === w.from && imp.to_rev === w.to, back = imp.to_rev === w.from && imp.from_rev === w.to;
    if (!fwd && !back) return; // the impact of this switch has not arrived yet
    wantDiff.current = null;
    const d = diff3d(imp, model, w.prev, back);
    if (!diffSize(d)) return;
    diffRef.current = d;
    setDiff({ d, imp, back });
    void (async () => {
      await engine();
      diffOn.current = true;
      await seq.play(isCalm() ? 0.8 : 3.4);
      diffOn.current = false;
    })();
  }, [a.revision, model, impact, engine, seq]);
  // one progress value drives the 3D diff and the HUD count-up
  useEffect(
    () =>
      seq.progress.on("change", (v) => {
        const e = eng.current, d = diffRef.current;
        if (!e || !d || !diffOn.current) return;
        if (e.momentName !== "revdiff") void e.playRevDiff(d, { drive: true, follow: true });
        e.seek(v);
      }),
    [seq],
  );

  const flyTo = (m: PlacementMove) => {
    const id = mode === "now" ? (m.to_slot ?? m.from_slot) : (m.from_slot ?? m.to_slot);
    if (id) void eng.current?.flyToSlot(id);
  };

  // ?demo=1: Playwright refreshes the change set right after it applies a move, and switches Before | Now
  useEffect(() => {
    if (!demoMode) return;
    return registerDemo("room", {
      refresh: () => qc.invalidateQueries({ queryKey: ["placement-changes", pid] }),
      mode: (m: Mode) => setMode(m),
      moves: () => nMoves,
      bus: (ev: MotionEvent) => onBus(ev), // what a Workbench in another window would send
      diffSeek: (p: number) => {
        diffOn.current = true;
        seq.seek(p);
        diffOn.current = p < 1;
      },
      diff: () => (diffRef.current ? diffSize(diffRef.current) : 0),
    });
  }, [qc, pid, nMoves, onBus, seq]);

  const loading = <Skeleton className="h-full w-full" />;
  const hud = (
    <>
      <BeforeNow mode={mode} onMode={setMode} count={nMoves + nHw} />
      <Button variant="outline" size="sm" className="glass h-8 border-border px-2.5 text-[11px] font-semibold uppercase tracking-wider" onClick={() => useUi.getState().setView3d(false)} title="Switch to the 2.5D World">
        2D
      </Button>
    </>
  );
  return (
    <div className="flex h-full min-h-0" data-testid="room">
      <div className="relative min-h-0 min-w-0 flex-1 bg-[#0A0D13]">
        <Suspense fallback={loading}>
          <World3D model={model} dims={dims} match={match} room overlay={overlay} hudRight={hud} onEngine={onEngine} onFail={() => useUi.getState().setView3d(false)} />
        </Suspense>
        <AnimatePresence>
          {diff && (
            <RevDiffHud
              key="revdiff" p={seq.progress} diff={diff.d} stability={diff.imp.stability_pct}
              from={diff.imp.from_rev} to={diff.imp.to_rev} reversed={diff.back} onClose={() => setDiff(null)}
            />
          )}
        </AnimatePresence>
        {!panel && (
          <button
            onClick={() => setPanel(true)}
            className="glass absolute right-0 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-2 rounded-l-card border border-r-0 border-border px-1.5 py-3 text-[11px] text-muted-foreground hover:text-text"
            title="Show changes"
          >
            <PanelRightOpen className="size-4" />
            <span className="[writing-mode:vertical-rl]">Changes · {nMoves + nHw}</span>
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {panel && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 300, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="shrink-0 overflow-hidden border-l border-border bg-surface"
          >
            <ChangesPanel ch={ch} failed={changes.isError} mode={mode} model={model} onFly={flyTo} onClose={() => setPanel(false)} />
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function BeforeNow({ mode, onMode, count }: { mode: Mode; onMode: (m: Mode) => void; count: number }) {
  return (
    <div className="glass flex h-8 items-center rounded-card border border-border p-0.5 text-[12px]" role="group" aria-label="Before or now" data-testid="before-now">
      {(["before", "now"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onMode(m)}
          aria-pressed={mode === m}
          className={cn("flex h-full items-center gap-1.5 rounded-[6px] px-2.5 font-medium capitalize transition-colors", mode === m ? "bg-brand/25 text-text" : "text-muted-foreground hover:text-text")}
        >
          {m}
          {m === "now" && count > 0 && <span className="rounded-full bg-live/20 px-1.5 text-[10px] tnum text-live">{count}</span>}
        </button>
      ))}
    </div>
  );
}

const shortSlot = (id?: string | null) => (id ? id.split("/").slice(1).join("/") : "—");

function ChangesPanel({ ch, failed, mode, model, onFly, onClose }: {
  ch: PlacementChangeSet | null; failed: boolean; mode: Mode; model: WorldModel; onFly: (m: PlacementMove) => void; onClose: () => void;
}) {
  const nav = useNavigate();
  const moves = ch?.moves ?? [];
  const hw = ch?.hardware ?? [];
  const verdict = ch?.verdict_now ?? "PASS";
  return (
    <div className="flex h-full w-[300px] flex-col" data-testid="changes-panel">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="label-caps">Changes</div>
          <div className="mt-0.5 text-[13px] font-semibold">
            Base <ArrowRight className="inline size-3.5 text-muted-foreground" /> {mode === "now" ? "Now" : "Now (showing Before)"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="rounded-full bg-raised px-2 py-0.5 tnum text-muted-foreground">{moves.length} move{moves.length === 1 ? "" : "s"}</span>
            {hw.length > 0 && <span className="rounded-full bg-raised px-2 py-0.5 tnum text-muted-foreground">{hw.length} hardware</span>}
            {ch && (moves.length > 0 || hw.length > 0) && (
              <span className={cn("rounded-full px-2 py-0.5 font-medium tnum", verdict === "PASS" ? "bg-ok/15 text-ok" : "bg-err/15 text-err")}>
                {verdict} · {ch.violations_now} violation{ch.violations_now === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="rounded-chip p-1 text-muted-foreground hover:bg-raised hover:text-text" title="Hide changes">
          <PanelRightClose className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {failed && !ch && <Empty icon={<Wrench className="size-5" />} title="Sandbox not reachable" body="The Workbench drafts could not be loaded — the room shows the committed allocation." />}
        {!failed && ch && !moves.length && !hw.length && (
          <Empty
            icon={<GitCompareArrows className="size-5" />}
            title="No changes yet"
            body="Hover any CHARM and press Try changes. Every move you apply in the Workbench appears here and flies into place — Before shows the committed allocation."
          />
        )}
        {moves.map((m) => {
          const s = model.bySlotId.get(m.from_slot ?? "");
          const colour = s ? IO_COLOURS[ioKey(s)] : IO_COLOURS.spare;
          return (
            <button
              key={moveKey(m)}
              onClick={() => onFly(m)}
              className="group mb-1 w-full rounded-card border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-raised"
              data-testid="change-item"
            >
              <div className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: colour }} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.tag}</span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <div className="mt-0.5 pl-4 font-mono text-[10.5px] text-muted-foreground">
                {m.cable}{m.pair != null ? ` · pair ${m.pair}` : ""}
              </div>
              <div className="mt-1 flex items-center gap-1 pl-4 font-mono text-[10.5px]">
                <span className={cn(mode === "before" ? "text-text" : "text-muted-foreground line-through decoration-muted-foreground/50")}>{shortSlot(m.from_slot)}</span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                <span className={cn(mode === "now" ? "text-live" : "text-muted-foreground")}>{shortSlot(m.to_slot)}</span>
              </div>
              {m.reason && <div className="mt-1 line-clamp-2 pl-4 text-[11px] text-muted-foreground">{m.reason}</div>}
            </button>
          );
        })}
        {hw.map((h) => (
          <div key={`${h.tag}-${h.slot_id}`} className="mb-1 rounded-card px-2.5 py-2">
            <div className="truncate font-mono text-[12px]">{h.tag}</div>
            <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
              {h.charm_before} → <span className="text-live">{h.charm_after}</span> · {h.tb_before} → <span className="text-live">{h.tb_after}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <Button size="sm" className="h-8 w-full gap-1.5 text-[12px]" onClick={() => nav("/lab")}>
          <FlaskConical className="size-3.5" /> Open the Try-out Lab
        </Button>
      </div>
    </div>
  );
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="mx-2 mt-6 rounded-card border border-dashed border-border px-4 py-5 text-center">
      <div className="mx-auto mb-2 grid size-9 place-items-center rounded-full bg-raised text-muted-foreground">{icon}</div>
      <div className="text-[13px] font-medium">{title}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
