import { motion } from "framer-motion";

import type { Dims } from "@/api/derive";
import { IO_COLOURS } from "@/lib/io";
import { rowRect, targetRect, type BlockInfo, type RowTargets } from "@/lib/sandbox";
import { EASE } from "@/motion/shared";

import type { Rect } from "./geometry";

// SVG overlays for the Try-out Lab, drawn in world coordinates through <CabinetWorld overlay>.

export interface Hint {
  x: number;
  y: number;
  text: string;
  ok: boolean;
}

interface TargetProps {
  rows: Map<string, RowTargets>;
  block: BlockInfo;
  cabIdx: number;
  locals: number[];
  dims: Dims;
  calm: boolean;
  onPick: (local: number, bp: number, ch: number) => void;
  onHint: (h: Hint | null) => void;
}

/** Valid targets breathe green; rows that cannot take the block are dimmed red and say why on hover (CLAUDE.md §10.4.6). */
export function TargetOverlay({ rows, block, cabIdx, locals, dims, calm, onPick, onHint }: TargetProps) {
  const green: JSX.Element[] = [];
  const red: JSX.Element[] = [];
  const covered = new Set<string>();
  for (const local of locals) {
    for (let bp = 1; bp <= dims.bps; bp++) {
      const row = rows.get(`${local}/${bp}`);
      if (!row) continue;
      for (const c of row.starts) {
        const r = targetRect(block, cabIdx, local, bp, c, dims);
        for (let k = 0; k < Math.max(1, block.span); k++) covered.add(`${local}/${bp + k}`);
        const text = block.span ? `Drop here · BP ${bp}–${bp + block.span - 1}` : `Drop here · BP ${bp} · ch ${c}${block.size > 1 ? `–${c + block.size - 1}` : ""}`;
        green.push(
          <rect
            key={`g${local}/${bp}/${c}`} data-target="ok" x={r.x - 2} y={r.y - 2} width={r.w + 4} height={r.h + 4} rx={4}
            className={`fill-ok/25 stroke-ok cursor-pointer ${calm ? "" : "breathe"}`} strokeWidth={1.6} style={calm ? { opacity: 0.7 } : undefined}
            onClick={() => onPick(local, bp, c)}
            onPointerMove={(e) => onHint({ x: e.clientX, y: e.clientY, text, ok: true })}
            onPointerLeave={() => onHint(null)}
          />,
        );
      }
    }
  }
  for (const local of locals) {
    for (let bp = 1; bp <= dims.bps; bp++) {
      const row = rows.get(`${local}/${bp}`);
      if (!row || row.starts.length || covered.has(`${local}/${bp}`)) continue;
      const r = rowRect(cabIdx, local, bp, dims);
      red.push(
        <rect
          key={`r${local}/${bp}`} data-target="bad" x={r.x - 2} y={r.y - 2} width={r.w + 4} height={r.h + 4} rx={4}
          className="fill-err/15 stroke-err cursor-not-allowed" strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.55}
          onClick={() => onPick(local, bp, 1)}
          onPointerMove={(e) => onHint({ x: e.clientX, y: e.clientY, text: row.reason, ok: false })}
          onPointerLeave={() => onHint(null)}
        />,
      );
    }
  }
  return (
    <g data-testid="targets">
      {red}
      {green}
    </g>
  );
}

/** The picked-up block: lifts (scale 1.06) with a live-cyan glow. */
export function Lift({ rect }: { rect: Rect }) {
  return (
    <motion.rect
      x={rect.x - 3} y={rect.y - 3} width={rect.w + 6} height={rect.h + 6} rx={5} fill="none" className="stroke-live" strokeWidth={2}
      filter="url(#glow)" pointerEvents="none" style={{ originX: 0.5, originY: 0.5 }}
      initial={{ scale: 1, opacity: 0 }} animate={{ scale: 1.06, opacity: 1 }} transition={{ duration: 0.22, ease: EASE }}
    />
  );
}

/** A quiet marker around a block: where it was (dashed) or where it landed (solid). */
export function Ring({ rect, dashed, tone }: { rect: Rect; dashed?: boolean; tone: "brand" | "muted" }) {
  return (
    <rect
      x={rect.x - 3} y={rect.y - 3} width={rect.w + 6} height={rect.h + 6} rx={5} fill="none" pointerEvents="none"
      className={tone === "brand" ? "stroke-brand" : "stroke-muted-foreground"} strokeWidth={1.6} strokeDasharray={dashed ? "5 4" : undefined} strokeOpacity={0.9}
    />
  );
}

/** The ghost flies from the block's slot to the chosen target along an arc, then lands (spring settle). */
export function Ghost({ block, from, to, calm }: { block: BlockInfo; from: Rect | null; to: Rect; calm: boolean }) {
  const colour = IO_COLOURS[block.io];
  const start = from ?? to;
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const arc = Math.min(90, 24 + Math.hypot(dx, dy) * 0.12);
  return (
    <motion.rect
      x={start.x} y={start.y} width={to.w} height={to.h} rx={4} fill={colour} fillOpacity={0.88} stroke={colour} strokeWidth={1.4}
      filter="url(#glow)" pointerEvents="none" style={{ originX: 0.5, originY: 0.5 }}
      initial={{ x: 0, y: 0, scale: from ? 1.06 : 1.3, opacity: from ? 1 : 0 }}
      animate={calm ? { x: dx, y: dy, scale: 1, opacity: 1 } : { x: dx, y: [0, -arc, dy], scale: [1.06, 1.1, 1], opacity: 1 }}
      transition={calm ? { duration: 0.15 } : { duration: 0.46, ease: EASE, times: [0, 0.45, 1] }}
    />
  );
}

/** Refused: the target flashes red three times. */
export function RefusalFlash({ rect }: { rect: Rect }) {
  return (
    <motion.rect
      x={rect.x - 3} y={rect.y - 3} width={rect.w + 6} height={rect.h + 6} rx={5} className="fill-err/30 stroke-err" strokeWidth={2} pointerEvents="none"
      initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 0, 1, 0, 1, 0] }} transition={{ duration: 0.9 }}
    />
  );
}
