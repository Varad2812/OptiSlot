import { motion, useTransform, type MotionValue } from "framer-motion";
import { memo } from "react";

import type { Dims, WorldModel } from "@/api/derive";
import type { AllocationResult } from "@/api/hooks";
import type { RevisionImpact } from "@/api/sandbox";
import { IO_COLOURS, ioKey, type IoKey } from "@/lib/io";
import { easeOut, phase } from "@/motion/shared";

import { sideOf, SLOT_H, SLOT_W, slotXY } from "./geometry";

// Rev B diff motion (CLAUDE.md §10.4.5). Everything here is a pure function of one progress value `p`, so Playwright can freeze
// it at 0/50/100 %. Unchanged slots are never touched — only the changed ones get an element. The base World already shows Rev B;
// each changed slot is covered with its Rev A look until its own animation window, then animates into the Rev B look.

export type DiffKind = "added" | "deleted" | "modified" | "moved";

export interface Loc {
  cab: number;
  local: number;
  bp: number;
  ch: number;
  id: string;
}

export interface DiffItem {
  key: string;
  kind: DiffKind;
  tag: string;
  reason: string;
  from: Loc | null;
  to: Loc | null;
  oldKey: IoKey;
  newKey: IoKey;
  oldWired: boolean;   // the slot looked like a hatched wired spare before (only meaningful for added/moved targets)
  win: [number, number]; // this item's animation window inside the sequence
}

export const KIND_TONE: Record<DiffKind, "ok" | "err" | "warn" | "brand"> = { added: "ok", deleted: "err", modified: "warn", moved: "brand" };
const STROKE = { ok: "stroke-ok", err: "stroke-err", warn: "stroke-warn", brand: "stroke-brand" } as const; // literal class names so Tailwind keeps them
const WINDOW: Record<DiffKind, [number, number]> = { deleted: [0.08, 0.4], modified: [0.3, 0.6], added: [0.45, 0.75], moved: [0.55, 0.95] };

/** Turn the revision impact into drawable items. `revA` (if known) supplies the old look of each slot. */
export function buildDiff(impact: RevisionImpact, model: WorldModel, revA?: AllocationResult | null): DiffItem[] {
  const a = revA ? new Map(revA.slots.map((s) => [s.id, s])) : null;
  const loc = (id: string | null | undefined): Loc | null => {
    const s = id ? model.bySlotId.get(id) : undefined;
    const cab = s ? model.cabIndexByName.get(s.cabinet) : undefined;
    return s && cab != null ? { cab, local: s.cioc_local, bp: s.bp, ch: s.ch, id: s.id } : null;
  };
  const out: DiffItem[] = [];
  (["deleted", "modified", "added", "moved"] as const).forEach((kind) => {
    for (const m of impact[kind]) {
      const from = loc(m.from_slot);
      const to = loc(m.to_slot);
      const newS = m.to_slot ? model.bySlotId.get(m.to_slot) : undefined;
      const oldS = m.from_slot ? a?.get(m.from_slot) : undefined;
      const oldTarget = m.to_slot ? a?.get(m.to_slot) : undefined; // what the destination looked like in Rev A
      const newKey = newS ? ioKey(newS) : "spare";
      out.push({
        key: `${kind}/${m.tag}`, kind, tag: m.tag, reason: m.reason, from, to,
        newKey,
        oldKey: oldS ? ioKey(oldS) : kind === "modified" ? (newKey === "doiso" ? "do" : newKey) : "spare",
        oldWired: oldTarget?.status === "Wired Spare",
        win: WINDOW[kind],
      });
    }
  });
  return out;
}

interface Props {
  items: DiffItem[];
  p: MotionValue<number>;
  cabIdx: number;
  side: "F" | "R";
  dims: Dims;
  calm: boolean;
  focus: string | null;
}

const MAX_ANIMATED = 400; // an uploaded Rev B can change hundreds of slots: beyond this only the markers draw

export const DiffOverlay = memo(function DiffOverlay({ items, p, cabIdx, side, dims, calm, focus }: Props) {
  const visible = (l: Loc | null): l is Loc => !!l && l.cab === cabIdx && sideOf(l.local, dims) === side;
  const shown = items.filter((it) => visible(it.to) || visible(it.from));
  return (
    <g data-testid="diff-overlay">
      {shown.map((it, i) => (
        <DiffMark key={it.key} it={it} p={p} dims={dims} calm={calm || i >= MAX_ANIMATED} vis={{ from: visible(it.from), to: visible(it.to) }} />
      ))}
      {focus && shown.filter((it) => it.key === focus).map((it) => <FocusPulse key={`f${focus}`} loc={(it.to ?? it.from)!} dims={dims} />)}
    </g>
  );
});

function DiffMark({ it, p, dims, calm, vis }: { it: DiffItem; p: MotionValue<number>; dims: Dims; calm: boolean; vis: { from: boolean; to: boolean } }) {
  const [a, b] = it.win;
  const tone = KIND_TONE[it.kind];
  const at = (l: Loc) => slotXY(l.cab, l.local, l.bp, l.ch, dims);
  const ringLoc = it.kind === "deleted" ? it.from : it.to;
  const ring = ringLoc && (it.kind === "deleted" ? vis.from : vis.to) ? at(ringLoc) : null;
  const ringOpacity = useTransform(p, (v) => (calm ? phase(v, 0.2, 1) : phase(v, b - 0.02, b + 0.08)));
  return (
    <g pointerEvents="none">
      {!calm && it.kind === "deleted" && vis.from && it.from && <Deleted it={it} p={p} at={at(it.from)} a={a} b={b} />}
      {!calm && it.kind === "modified" && vis.to && it.to && <Modified it={it} p={p} at={at(it.to)} a={a} b={b} />}
      {!calm && it.kind === "added" && vis.to && it.to && <Added it={it} p={p} at={at(it.to)} a={a} b={b} />}
      {!calm && it.kind === "moved" && <Moved it={it} p={p} vis={vis} dims={dims} a={a} b={b} />}
      {ring && (
        <motion.rect
          x={ring.x - 2.5} y={ring.y - 2.5} width={SLOT_W + 5} height={SLOT_H + 5} rx={5} fill="none" strokeWidth={1.8}
          strokeDasharray={it.kind === "deleted" ? "4 3" : undefined} className={STROKE[tone]} style={{ opacity: ringOpacity }}
          data-diff={it.kind}
        />
      )}
    </g>
  );
}

const fillOf = (k: IoKey, wired = false) => (wired ? `url(#hatch-${k})` : IO_COLOURS[k]);

/** Rev A look of a slot that is a plain spare: the cabinet face with the spare outline. */
function SpareCover({ x, y, opacity }: { x: number; y: number; opacity: MotionValue<number> }) {
  return <motion.rect x={x - 0.5} y={y - 0.5} width={SLOT_W + 1} height={SLOT_H + 1} rx={3} className="fill-surface stroke-[color:var(--spare)]" style={{ opacity }} />;
}

/** deleted = fade + shrink */
function Deleted({ it, p, at, a, b }: { it: DiffItem; p: MotionValue<number>; at: { x: number; y: number }; a: number; b: number }) {
  const t = useTransform(p, (v) => easeOut(phase(v, a, b)));
  const opacity = useTransform(t, (x) => 1 - x);
  const scale = useTransform(t, (x) => 1 - 0.75 * x);
  const colour = it.oldKey === "spare" ? "#8C95A8" : IO_COLOURS[it.oldKey];
  return <motion.rect x={at.x} y={at.y} width={SLOT_W} height={SLOT_H} rx={3} fill={colour} fillOpacity={0.9} style={{ opacity, scale, originX: 0.5, originY: 0.5 }} />;
}

/** modified = flip to the new CHARM colour (scaleX 1→0 in the old colour, then 0→1 in the new one) */
function Modified({ it, p, at, a, b }: { it: DiffItem; p: MotionValue<number>; at: { x: number; y: number }; a: number; b: number }) {
  const t = useTransform(p, (v) => easeOut(phase(v, a, b)));
  const oldX = useTransform(t, (x) => (x >= 0.5 ? 0 : 1 - x * 2));
  const newX = useTransform(t, (x) => (x < 0.5 ? 0 : x * 2 - 1));
  const done = useTransform(p, (v): number => (v >= b ? 0 : 1));
  return (
    <motion.g style={{ opacity: done }}>
      <motion.rect x={at.x} y={at.y} width={SLOT_W} height={SLOT_H} rx={3} fill={fillOf(it.oldKey)} style={{ scaleX: oldX, originX: 0.5, originY: 0.5 }} />
      <motion.rect x={at.x} y={at.y} width={SLOT_W} height={SLOT_H} rx={3} fill={fillOf(it.newKey)} style={{ scaleX: newX, originX: 0.5, originY: 0.5 }} />
    </motion.g>
  );
}

/** added = drops in (cover until its window, then a block that falls and settles) */
function Added({ it, p, at, a, b }: { it: DiffItem; p: MotionValue<number>; at: { x: number; y: number }; a: number; b: number }) {
  const t = useTransform(p, (v) => phase(v, a, b));
  const cover = useTransform(p, (v): number => (v >= b ? 0 : 1));
  const dropY = useTransform(t, (x) => -52 * (1 - settle(x)));
  const dropOpacity = useTransform(t, (x) => (x <= 0 ? 0 : x >= 1 ? 0 : Math.min(1, x * 4)));
  return (
    <>
      <SpareCover x={at.x} y={at.y} opacity={cover} />
      {it.oldWired && <motion.rect x={at.x} y={at.y} width={SLOT_W} height={SLOT_H} rx={3} fill={fillOf(it.newKey, true)} style={{ opacity: cover }} />}
      <motion.rect x={at.x} y={at.y} width={SLOT_W} height={SLOT_H} rx={3} fill={fillOf(it.newKey)} filter="url(#glow)" style={{ y: dropY, opacity: dropOpacity }} />
    </>
  );
}

/** moved = a curved flight from the old slot to the new one */
function Moved({ it, p, vis, dims, a, b }: { it: DiffItem; p: MotionValue<number>; vis: { from: boolean; to: boolean }; dims: Dims; a: number; b: number }) {
  const from = it.from && vis.from ? slotXY(it.from.cab, it.from.local, it.from.bp, it.from.ch, dims) : null;
  const to = it.to && vis.to ? slotXY(it.to.cab, it.to.local, it.to.bp, it.to.ch, dims) : null;
  const t = useTransform(p, (v) => easeOut(phase(v, a, b)));
  const cx = from && to ? (from.x + to.x) / 2 : 0;
  const cy = from && to ? Math.min(from.y, to.y) - 28 - Math.hypot(to.x - from.x, to.y - from.y) * 0.18 : 0;
  const pos = (x: number) => {
    if (!from || !to) return { x: (from ?? to)!.x, y: (from ?? to)!.y };
    const u = 1 - x;
    return { x: u * u * from.x + 2 * u * x * cx + x * x * to.x, y: u * u * from.y + 2 * u * x * cy + x * x * to.y };
  };
  const px = useTransform(t, (x) => pos(x).x);
  const py = useTransform(t, (x) => pos(x).y);
  const chipOpacity = useTransform(p, (v) => (v >= b + 0.05 ? 0 : 1));
  const trail = useTransform(t, (x) => x);
  const trailOpacity = useTransform(p, (v) => (v < a ? 0 : 1 - phase(v, b, b + 0.2)));
  const coverTo = useTransform(p, (v): number => (v >= b ? 0 : 1));
  const colour = IO_COLOURS[it.newKey];
  return (
    <>
      {to && <SpareCover x={to.x} y={to.y} opacity={coverTo} />}
      {from && to && (
        <motion.path
          d={`M ${from.x + SLOT_W / 2} ${from.y + SLOT_H / 2} Q ${cx + SLOT_W / 2} ${cy + SLOT_H / 2} ${to.x + SLOT_W / 2} ${to.y + SLOT_H / 2}`}
          fill="none" className="stroke-brand" strokeWidth={1.4} strokeDasharray="4 4" style={{ pathLength: trail, opacity: trailOpacity }}
        />
      )}
      <motion.rect width={SLOT_W} height={SLOT_H} rx={3} fill={colour} stroke={colour} filter="url(#glow)" style={{ x: px, y: py, opacity: chipOpacity }} />
    </>
  );
}

/** Pulses three times around a slot the engineer picked from the change list. */
function FocusPulse({ loc, dims }: { loc: Loc; dims: Dims }) {
  const q = slotXY(loc.cab, loc.local, loc.bp, loc.ch, dims);
  return (
    <motion.rect
      x={q.x - 5} y={q.y - 5} width={SLOT_W + 10} height={SLOT_H + 10} rx={7} fill="none" className="stroke-live" strokeWidth={2.4} filter="url(#glow)"
      initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 0.15, 1, 0.15, 1, 0.6] }} transition={{ duration: 1.5 }}
    />
  );
}

/** Ease with a small overshoot-and-settle (the block "lands"). */
function settle(t: number) {
  const c = 1.5;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

