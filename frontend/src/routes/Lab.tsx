import { motion, useAnimationControls } from "framer-motion";
import { FlipHorizontal2, FlaskConical, Redo2, ShieldAlert, Undo2, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { dimsOf, worldModel, type Dims, type WorldModel } from "@/api/derive";
import { useAllocation, useProject, useRules, type AllocationResult, type Project, type RuleSet } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ImpactStrip } from "@/lab/ImpactStrip";
import { Tools } from "@/lab/Tools";
import { changeCount, useSandbox, type Pending, type Strategy } from "@/lab/useSandbox";
import { blockInfo, blockRect, targetRect, targetsFor, type BlockInfo, type SegRule } from "@/lib/sandbox";
import { cn } from "@/lib/utils";
import { EASE, useCalm } from "@/motion/shared";
import { useUi } from "@/store/ui";
import { CabinetWorld } from "@/world/CabinetWorld";
import { sideOf, type Insets, type Rect } from "@/world/geometry";
import { Ghost, Lift, RefusalFlash, Ring, TargetOverlay, type Hint } from "@/world/LabOverlays";
import { sideLocals } from "@/world/parts";
import { useStage } from "@/world/useStage";

const INSETS: Insets = { top: 52, right: 14, bottom: 40, left: 14 };

export default function Lab() {
  const { data: live } = useAllocation();
  const { data: p } = useProject();
  const { data: rules } = useRules();
  if (!live || !rules) {
    return (
      <div className="grid h-full grid-rows-[48px_88px_1fr] gap-3 p-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return <LabInner live={live} p={p} rules={rules} />;
}

interface Flight {
  block: BlockInfo;
  from: Rect | null;
  to: Rect;
  land: () => void;
}
interface Refusal {
  reason: string;
  rect: Rect | null;
  cabIdx: number;
  key: number;
}

function LabInner({ live, p, rules }: { live: AllocationResult; p: Project | undefined; rules: RuleSet }) {
  const calm = useCalm();
  const dims = useMemo(() => dimsOf(live, p), [live, p]);
  const sb = useSandbox(live, rules);
  const baseModel = useMemo(() => worldModel(sb.baseline, dims), [sb.baseline, dims]);
  const propModel = useMemo(() => worldModel(sb.proposed, dims), [sb.proposed, dims]);
  const n = baseModel.cabinets.length;
  const stage = useStage(n, dims, INSETS);
  const ui = useUi();
  const locals = useMemo(() => sideLocals(stage.side, dims), [stage.side, dims]);

  const seg: SegRule | null = useMemo(() => {
    const r = rules.rules.find((x) => x.type === "segregate" && x.enabled && (x.params?.level ?? "cioc") === "cioc");
    return r ? { id: r.id, label: r.label } : null;
  }, [rules]);

  const alarmRule = rules.rules.find((r) => r.type === "reserve_baseplate")?.id ?? "reserve_baseplate";

  // ───── selection → targets ─────
  const [sel, setSel] = useState<string | null>(null);
  const block = useMemo(() => (sel ? blockInfo(sb.proposed, propModel, dims, sel) : null), [sel, sb.proposed, propModel, dims]);
  useEffect(() => {
    if (sel && !block) setSel(null);
  }, [sel, block]);

  // Deep link from the 3D Room's "Try changes" (§10.8): ?tag= preselects that signal's cable block and shows its cabinet
  // and side; ?slot= / ?cabinet=&cioc= just aim the stage there.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const tag = params.get("tag"), slotId = params.get("slot"), cabinet = params.get("cabinet");
    if (!tag && !slotId && !cabinet) return;
    const key = tag?.replace(/\s+/g, "").toLowerCase();
    const s = key
      ? sb.proposed.slots.find((x) => x.status !== "Spare Slot" && x.tag_key.replace(/\s+/g, "").toLowerCase() === key)
      : slotId ? propModel.bySlotId.get(slotId) : undefined;
    const idx = propModel.cabIndexByName.get(s?.cabinet ?? cabinet ?? "");
    const local = s?.cioc_local ?? Number(params.get("cioc") || 0);
    if (idx != null) useUi.setState({ cabIdx: idx, side: local > dims.ciocsPerSide ? "R" : "F" });
    if (s?.block_id && s.status !== "Cabinet Alarm") setSel(s.block_id);
    for (const k of ["tag", "slot", "cabinet", "cioc", "bp"]) params.delete(k);
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = useMemo(() => (block ? targetsFor(propModel, stage.idx, block, dims, seg) : null), [block, propModel, stage.idx, dims, seg]);

  const [flight, setFlight] = useState<Flight | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const shake = useAnimationControls();
  const hint = useRef<HintApi>(null);
  const flightRef = useRef(flight);
  flightRef.current = flight;

  useEffect(() => {
    if (!refusal) return;
    const t = window.setTimeout(() => setRefusal(null), 9000);
    return () => window.clearTimeout(t);
  }, [refusal]);

  const refuse = useCallback(
    (reason: string, rect: Rect | null, cabIdx: number) => {
      setRefusal({ reason, rect, cabIdx, key: Date.now() });
      if (!calm) void shake.start({ x: [0, -10, 10, -7, 7, -3, 0], transition: { duration: 0.4, ease: "easeOut" } });
    },
    [calm, shake],
  );

  // pick a target: the SERVER decides (the green/red grid is only a hint)
  const pick = useCallback(
    async (local: number, bp: number, ch: number) => {
      if (!block || sb.busy || flightRef.current) return;
      const cab = propModel.cabinets[stage.idx];
      const ci = cab?.info.ciocs.find((c) => c.local === local);
      if (!ci) return;
      hint.current?.show(null);
      const to = targetRect(block, stage.idx, local, bp, ch, dims);
      const { res, land } = await sb.tryMove({ block_id: block.id, target_cioc: ci.name, target_bp: bp, target_ch: ch });
      if (!res.ok) return refuse(res.reason, to, stage.idx);
      setRefusal(null);
      setFlight({ block, from: block.cabIdx === stage.idx && sideOf(block.ciocLocal, dims) === stage.side ? blockRect(block, dims) : null, to, land });
    },
    [block, sb, propModel, stage.idx, dims, refuse],
  );
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const onPick = useCallback((l: number, b: number, c: number) => void pickRef.current(l, b, c), []);

  const landed = useCallback(() => {
    flightRef.current?.land();
    setFlight(null);
    setSel(null);
  }, []);

  // The flight is time-boxed (0.46 s; 0.15 s in Calm) rather than waiting on an animation callback, so a move can never hang.
  useEffect(() => {
    if (!flight) return;
    const t = window.setTimeout(landed, calm ? 200 : 520);
    return () => window.clearTimeout(t);
  }, [flight, calm, landed]);

  const onSlotProposed = useCallback(
    (id: string) => {
      if (flightRef.current) return;
      const s = propModel.bySlotId.get(id);
      if (!s) return;
      setRefusal(null);
      if (s.status === "Cabinet Alarm") {
        const xy = blockRectOfSlot(s, propModel, dims);
        return refuse(`${s.tag} is a cabinet alarm — it stays on the reserved baseplate (rule ${alarmRule})`, xy, propModel.cabIndexByName.get(s.cabinet) ?? 0);
      }
      setSel(s.block_id ?? null);
    },
    [propModel, dims, refuse, alarmRule],
  );
  const onSlotCurrent = useCallback((id: string) => ui.inspect(id), [ui]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sel && !useUi.getState().inspectorSlot) setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  // ───── pending-change handlers ─────
  const setPending = (fn: (p: Pending) => Pending) => sb.change(fn(sb.pending));
  const onStrategy = (s: Strategy) => {
    setSel(null);
    // layout changes wholesale: earlier block moves no longer refer to the same positions
    void sb.change({ ...sb.pending, moves: [], strategy: s === sb.orig ? null : s });
  };
  const onToggle = (id: string, on: boolean) =>
    void setPending((q) => {
      const t = { ...q.toggles };
      const rule = rules.rules.find((r) => r.id === id);
      if (rule && rule.enabled === on) delete t[id];
      else t[id] = on;
      return { ...q, toggles: t };
    });
  const onPct = (rule: RuleSet["rules"][number], pct: number) =>
    void setPending((q) => {
      const prm = { ...q.params };
      if (rule.params?.pct === pct) delete prm[rule.id];
      else prm[rule.id] = { pct };
      return { ...q, params: prm };
    });
  const onReset = (key: "toggles" | "params", id: string) =>
    void setPending((q) => {
      const o = { ...q[key] };
      delete o[id];
      return { ...q, [key]: o };
    });
  const onDropMove = (blockId: string) => void setPending((q) => ({ ...q, moves: q.moves.filter((m) => m.block_id !== blockId) }));

  // ───── overlays ─────
  // a block is only drawn while its cabinet AND its side (front/rear) are in view
  const shown = (b: BlockInfo | null): b is BlockInfo => !!b && b.cabIdx === stage.idx && sideOf(b.ciocLocal, dims) === stage.side;
  const movedIds = useMemo(() => sb.pending.moves.map((m) => m.block_id).filter((x): x is string => !!x), [sb.pending.moves]);
  const proposedOverlay = useMemo(
    () => (
      <>
        {movedIds.map((id) => {
          const b = blockInfo(sb.proposed, propModel, dims, id);
          return shown(b) && id !== sel ? <Ring key={`m${id}`} rect={blockRect(b, dims)} tone="brand" /> : null;
        })}
        {shown(block) && !flight && <Lift rect={blockRect(block, dims)} />}
        {block && rows && !flight && (
          <TargetOverlay rows={rows} block={block} cabIdx={stage.idx} locals={locals} dims={dims} calm={calm} onPick={onPick} onHint={(h) => hint.current?.show(h)} />
        )}
        {refusal?.rect && refusal.cabIdx === stage.idx && <RefusalFlash key={refusal.key} rect={refusal.rect} />}
        {flight && <Ghost block={flight.block} from={flight.from} to={flight.to} calm={calm} />}
      </>
    ),
    [movedIds, sb.proposed, propModel, dims, stage.idx, stage.side, sel, block, rows, flight, locals, calm, onPick, refusal, landed],
  );
  const currentOverlay = useMemo(
    () => (
      <>
        {movedIds.map((id) => {
          const b = blockInfo(sb.baseline, baseModel, dims, id);
          return shown(b) ? <Ring key={`o${id}`} rect={blockRect(b, dims)} tone="muted" dashed /> : null;
        })}
        {block && !movedIds.includes(block.id) && (() => {
          const b = blockInfo(sb.baseline, baseModel, dims, block.id);
          return shown(b) ? <Ring rect={blockRect(b, dims)} tone="muted" dashed /> : null;
        })()}
      </>
    ),
    [movedIds, sb.baseline, baseModel, dims, stage.idx, stage.side, block],
  );

  const changes = changeCount(sb.pending);
  const view = propModel.cabinets[stage.idx];

  return (
    <div className="flex h-full flex-col" data-testid="lab">
      {/* Sandbox banner + controls */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-warn/30 bg-warn/10 px-4">
        <div className="flex items-center gap-2 text-warn">
          <FlaskConical className="size-4" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">Sandbox</span>
        </div>
        <span className="text-[12.5px] text-text/85" data-testid="sandbox-status">
          {changes === 0 ? "Previews only — nothing is committed until you press Commit." : `${changes} pending change${changes > 1 ? "s" : ""} — not committed.`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => void sb.undo()} disabled={sb.busy || !sb.canUndo} data-testid="undo">
            <Undo2 className="size-3.5" /> Undo
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => void sb.redo()} disabled={sb.busy || !sb.canRedo} data-testid="redo">
            <Redo2 className="size-3.5" /> Redo
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => (setSel(null), void sb.discard())} disabled={sb.busy || !sb.dirty} data-testid="discard">
            Discard
          </Button>
          <Button size="sm" className="h-8 text-[12px]" onClick={() => void sb.commit()} disabled={sb.busy || !sb.dirty || sb.impact.violations > 0} data-testid="commit">
            Commit{changes ? ` (${changes})` : ""}
          </Button>
        </div>
      </div>

      <ImpactStrip base={sb.baseline} impact={sb.impact} />

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <CabinetBar model={propModel} idx={stage.idx} side={stage.side} dims={dims} onGo={stage.goto} onFlip={() => ui.setSide(ui.side === "F" ? "R" : "F")} />
          <div className="flex min-h-0 flex-1 gap-px bg-border">
            <Pane label="Current" sub={`Rev ${live.revision} · committed`}>
              <StageWorld
                stage={stage} model={baseModel} dims={dims} overlay={currentOverlay} onSlot={onSlotCurrent} reportSize
              />
            </Pane>
            <Pane label="Proposed" sub={changes ? `${changes} change${changes > 1 ? "s" : ""}` : "same as current"} accent shakeCtl={shake} data-testid="proposed-pane">
              <StageWorld stage={stage} model={propModel} dims={dims} overlay={proposedOverlay} onSlot={onSlotProposed} />
              {block && !flight && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}
                  className="glass absolute left-3 top-11 z-10 flex items-center gap-2.5 whitespace-nowrap rounded-card border border-live/50 px-3 py-1.5 text-[12px] glow-live" data-testid="selection"
                >
                  <span className="font-mono">{block.cable}</span>
                  <span className="text-muted-foreground">{block.size} pair{block.size > 1 ? "s" : ""}{block.fams.size ? ` · family ${[...block.fams].join("/")}` : ""}</span>
                  <button className="text-muted-foreground underline-offset-2 hover:text-text hover:underline" onClick={() => ui.inspect(block.slots[0].id)}>Inspect</button>
                  <button aria-label="Put down" onClick={() => setSel(null)} className="rounded-[4px] p-0.5 text-muted-foreground hover:bg-raised hover:text-text"><X className="size-3.5" /></button>
                </motion.div>
              )}
              {!block && !refusal && (
                <div className="pointer-events-none absolute right-3 top-3 z-10 max-w-[250px] rounded-chip border border-border bg-surface/80 px-3 py-1.5 text-[11.5px] leading-snug text-muted-foreground backdrop-blur">
                  Click a cable to pick it up — green targets accept it, red ones say why not.
                </div>
              )}
              {refusal && (
                <motion.div
                  key={refusal.key} role="alert" data-testid="move-refusal"
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}
                  className="absolute inset-x-4 bottom-3 z-20 flex items-start gap-2.5 rounded-card border border-err/60 bg-surface/95 px-3.5 py-2.5 text-[12.5px] shadow-lg backdrop-blur"
                >
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-err" />
                  <div className="min-w-0 flex-1"><span className="font-semibold text-err">Refused · </span>{refusal.reason}</div>
                  <button aria-label="Dismiss" onClick={() => setRefusal(null)} className="rounded-[4px] p-0.5 text-muted-foreground hover:bg-raised hover:text-text"><X className="size-3.5" /></button>
                </motion.div>
              )}
            </Pane>
          </div>
          <HintTip ref={hint} />
          {view && <span className="sr-only" data-testid="lab-cabinet">{view.info.name}</span>}
        </div>

        <aside className="w-[300px] shrink-0 border-l border-border bg-surface/60">
          <Tools rules={rules} pending={sb.pending} orig={sb.orig} busy={sb.busy} onStrategy={onStrategy} onToggle={onToggle} onPct={onPct} onDropMove={onDropMove} onReset={onReset} />
        </aside>
      </div>
    </div>
  );
}

function blockRectOfSlot(s: { cioc_local: number; bp: number; ch: number; cabinet: string }, model: WorldModel, dims: Dims): Rect | null {
  const i = model.cabIndexByName.get(s.cabinet);
  if (i == null) return null;
  return targetRect({ span: 0, size: 1 } as BlockInfo, i, s.cioc_local, s.bp, s.ch, dims);
}

// ───────────── panes ─────────────

function Pane({ label, sub, accent, shakeCtl, children, ...rest }: { label: string; sub: string; accent?: boolean; shakeCtl?: ReturnType<typeof useAnimationControls>; children: React.ReactNode; "data-testid"?: string }) {
  return (
    <motion.div animate={shakeCtl} className="bg-world relative min-w-0 flex-1 overflow-hidden" {...rest}>
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
        <span className={cn("rounded-chip px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]", accent ? "bg-brand/20 text-brand" : "bg-raised text-muted-foreground")}>{label}</span>
        <span className="text-[11px] text-muted-foreground">{sub}</span>
      </div>
      {children}
    </motion.div>
  );
}

function StageWorld({ stage, model, dims, overlay, onSlot, reportSize }: {
  stage: ReturnType<typeof useStage>; model: WorldModel; dims: Dims; overlay: React.ReactNode; onSlot: (id: string) => void; reportSize?: boolean;
}) {
  const ui = useUi();
  return (
    <motion.div className="absolute inset-0" style={{ opacity: stage.opacity, rotateY: stage.rotateY, transformPerspective: 1800 }}>
      <CabinetWorld
        model={model} dims={dims} cam={stage.cam} side={stage.side} activeIdx={stage.idx} cabinetS={stage.cabinetS}
        overlay={overlay} onSize={reportSize ? stage.onSize : undefined} onSlot={onSlot}
        onCabinet={(i) => ui.goCabinet(i)}
      />
    </motion.div>
  );
}

function CabinetBar({ model, idx, side, dims, onGo, onFlip }: { model: WorldModel; idx: number; side: "F" | "R"; dims: Dims; onGo: (i: number) => void; onFlip: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface/50 px-4">
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist">
        {model.cabinets.map((c) => (
          <button
            key={c.info.name} role="tab" aria-selected={c.index === idx} onClick={() => onGo(c.index)}
            className={cn("shrink-0 rounded-chip border px-2 py-1 font-mono text-[11px] transition-colors", c.index === idx ? "border-brand/60 bg-brand/15 text-text" : "border-border text-muted-foreground hover:text-text")}
          >
            {c.info.name}
          </button>
        ))}
      </div>
      <span className="hidden shrink-0 text-[11px] text-muted-foreground tnum min-[1680px]:inline">
        {dims.ciocsPerCabinet} CIOC × {dims.bps} BP × {dims.channels} ch · ← → cabinets · F flip
      </span>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[11.5px]" onClick={onFlip}>
        <FlipHorizontal2 className="size-3.5" /> {side === "F" ? "Front" : "Rear"}
      </Button>
    </div>
  );
}

// ───────────── hover reason (imperative, so hovering never re-renders the Worlds) ─────────────

interface HintApi {
  show: (h: Hint | null) => void;
}
const HintTip = forwardRef<HintApi>(function HintTip(_, ref) {
  const [h, setH] = useState<Hint | null>(null);
  useImperativeHandle(ref, () => ({ show: setH }), []);
  if (!h) return null;
  return (
    <div
      className={cn("pointer-events-none fixed z-50 max-w-[320px] rounded-chip border px-2.5 py-1.5 text-[11.5px] leading-snug shadow-lg backdrop-blur", h.ok ? "border-ok/50 bg-surface/95 text-ok" : "border-err/50 bg-surface/95 text-text")}
      style={{ left: h.x + 14, top: h.y + 16 }}
      data-testid="target-hint"
    >
      {h.ok ? h.text : <><span className="font-semibold text-err">Not here · </span>{h.text}</>}
    </div>
  );
});
