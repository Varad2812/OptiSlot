import { motion, motionValue, useTransform, type MotionValue } from "framer-motion";
import { memo } from "react";

import type { Block, CabinetView, Dims } from "@/api/derive";
import type { Slot } from "@/api/hooks";
import { IO_COLOURS, IO_ORDER, ioKey, type IoKey } from "@/lib/io";

import {
  BP_LABEL, bpRect, cabinetRect, CIOC_HEAD, ciocRect, DEPTH_X, DEPTH_Y, NAMEPLATE, PLINTH, SLOT_H, SLOT_PITCH, SLOT_W, slotXY,
} from "./geometry";

/** <defs>: one 45° hatch per IO colour (wired spares) and the soft glow for the active element. */
export function WorldDefs() {
  return (
    <defs>
      {IO_ORDER.map((k) => (
        <pattern key={k} id={`hatch-${k}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill={IO_COLOURS[k]} fillOpacity={0.3} />
          <line x1="0" y1="0" x2="0" y2="5" stroke={IO_COLOURS[k]} strokeWidth="1.6" strokeOpacity={0.9} />
        </pattern>
      ))}
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="rgb(var(--raised))" />
        <stop offset="1" stopColor="rgb(var(--surface))" />
      </linearGradient>
      <radialGradient id="shadow">
        <stop offset="0" stopColor="#000" stopOpacity="0.45" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// ───────────── cabinet body (2.5D) ─────────────

interface ShellProps {
  view: CabinetView;
  dims: Dims;
  side: "F" | "R";
  active: boolean;
  reveal?: MotionValue<number>;
  n: number;
}

/** The 2.5D cabinet: receding top and side faces, front door, nameplate, plinth and floor shadow. */
export const CabinetShell = memo(function CabinetShell({ view, dims, side, active, reveal, n }: ShellProps) {
  const r = cabinetRect(view.index, dims);
  const i = view.index;
  // Cabinets fade up left → right during the Upload Dive (each one gets its own window of the reveal progress).
  const opacity = useTransform(reveal ?? ONE, (p) => clamp01((p * (n + 2) - i) / 2));
  const lift = useTransform(reveal ?? ONE, (p) => (1 - clamp01((p * (n + 2) - i) / 2)) * 24);
  const top = `${r.x},${r.y} ${r.x + DEPTH_X},${r.y + DEPTH_Y} ${r.x + r.w + DEPTH_X},${r.y + DEPTH_Y} ${r.x + r.w},${r.y}`;
  const sideFace = `${r.x + r.w},${r.y} ${r.x + r.w + DEPTH_X},${r.y + DEPTH_Y} ${r.x + r.w + DEPTH_X},${r.y + r.h + DEPTH_Y} ${r.x + r.w},${r.y + r.h}`;
  return (
    <motion.g style={{ opacity, y: lift }} data-cab={i}>
      <ellipse cx={r.x + r.w / 2 + DEPTH_X / 2} cy={r.y + r.h + 6} rx={r.w * 0.62} ry={26} fill="url(#shadow)" />
      <polygon points={top} className="fill-raised stroke-border" strokeWidth={1} />
      <polygon points={sideFace} className="fill-surface stroke-border" strokeWidth={1} />
      <polygon points={sideFace} fill="#000" fillOpacity={0.18} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={6} fill="url(#face)" className={active ? "stroke-brand" : "stroke-border"} strokeWidth={active ? 2 : 1} />
      <rect x={r.x + 1} y={r.y + 1} width={r.w - 2} height={1} fill="#fff" fillOpacity={0.06} />
      {/* nameplate */}
      <rect x={r.x + 14} y={r.y + 14} width={r.w - 28} height={NAMEPLATE - 26} rx={5} className="fill-bg stroke-border" strokeWidth={1} />
      <text x={r.x + 26} y={r.y + 38} className="fill-text font-mono" fontSize={15} fontWeight={500}>
        {view.info.name}
      </text>
      <text x={r.x + r.w - 26} y={r.y + 38} textAnchor="end" className="fill-muted-foreground font-mono" fontSize={12}>
        {side === "F" ? "FRONT" : "REAR"} · {view.info.controller}
      </text>
      {/* plinth */}
      <rect x={r.x + 6} y={r.y + r.h - PLINTH + 8} width={r.w - 12} height={PLINTH - 14} rx={3} className="fill-bg" fillOpacity={0.7} />
      {Array.from({ length: 6 }, (_, k) => (
        <rect key={k} x={r.x + r.w / 2 - 66 + k * 24} y={r.y + r.h - PLINTH + 13} width={14} height={4} rx={2} className="fill-border" />
      ))}
    </motion.g>
  );
});

const ONE = motionValue(1);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Big floor label under each cabinet — readable at Plant zoom. */
export const FloorLabel = memo(function FloorLabel({ view, dims }: { view: CabinetView; dims: Dims }) {
  const r = cabinetRect(view.index, dims);
  const used = view.counts.field + view.counts.alarm + view.counts.wired;
  const fill = (100 * used) / Math.max(1, view.slots.length);
  return (
    <g pointerEvents="none">
      <text x={r.x + r.w / 2} y={r.y + r.h + 58} textAnchor="middle" className="fill-text font-mono" fontSize={30} fontWeight={500}>
        {view.info.name}
      </text>
      <text x={r.x + r.w / 2} y={r.y + r.h + 92} textAnchor="middle" className="fill-muted-foreground tnum" fontSize={22}>
        {view.counts.field} field · {view.counts.wired} wired spare · {fill.toFixed(0)}% full
      </text>
    </g>
  );
});

// ───────────── low detail: one rect per baseplate ─────────────

/** Plant-level heat-map: each baseplate is one bar, coloured by its dominant IO, opacity by fill. */
export const CabinetHeat = memo(function CabinetHeat({ view, dims, side }: { view: CabinetView; dims: Dims; side: "F" | "R" }) {
  const locals = sideLocals(side, dims);
  const width = dims.channels * SLOT_PITCH - (SLOT_PITCH - SLOT_W);
  return (
    <g pointerEvents="none">
      {locals.map((local) => {
        const c = ciocRect(view.index, local, dims);
        return (
          <g key={local}>
            <rect x={c.x} y={c.y} width={c.w} height={CIOC_HEAD - 10} rx={4} className="fill-raised" />
            <rect x={c.x + 10} y={c.y + 12} width={(c.w - 20) * ciocFill(view, local, dims)} height={6} rx={3} className="fill-brand" fillOpacity={0.8} />
          </g>
        );
      })}
      {view.heat
        .filter((h) => locals.includes(h.ciocLocal))
        .map((h) => {
          const b = bpRect(view.index, h.ciocLocal, h.bp, dims);
          const x = b.x + BP_LABEL;
          if (!h.io) {
            return <rect key={`${h.ciocLocal}-${h.bp}`} x={x} y={b.y} width={width} height={SLOT_H} rx={3} fill="none" strokeDasharray="5 4" className="stroke-[color:var(--spare)]" strokeWidth={1.2} />;
          }
          return (
            <g key={`${h.ciocLocal}-${h.bp}`}>
              <rect x={x} y={b.y} width={width} height={SLOT_H} rx={3} fill="none" className="stroke-[color:var(--spare)]" />
              <rect x={x} y={b.y} width={Math.max(8, width * Math.min(1, h.fill))} height={SLOT_H} rx={3} fill={IO_COLOURS[h.io]} fillOpacity={0.85} />
            </g>
          );
        })}
    </g>
  );
});

export function sideLocals(side: "F" | "R", d: Dims) {
  const first = side === "F" ? 1 : d.ciocsPerSide + 1;
  return Array.from({ length: d.ciocsPerSide }, (_, k) => first + k).filter((l) => l <= d.ciocsPerCabinet);
}

function ciocFill(view: CabinetView, local: number, d: Dims) {
  const c = view.info.ciocs.find((x) => x.local === local);
  if (!c) return 0;
  return Math.min(1, (c.used + c.wired_spares) / (c.capacity || d.bps * d.channels));
}

// ───────────── full detail ─────────────

interface SlotProps {
  id: string;
  x: number;
  y: number;
  k: IoKey;
  status: string;
  dim: boolean;
  tag?: string;
  charm?: string;
  tb?: string;
}

/** One CHARM slot. Field = filled IO colour; Wired Spare = 30% + hatch; Spare Slot = outline only. */
export const SlotRect = memo(function SlotRect({ id, x, y, k, status, dim, tag, charm, tb }: SlotProps) {
  const spare = status === "Spare Slot";
  const wired = status === "Wired Spare";
  const filled = !spare && !wired;
  return (
    <g opacity={dim ? 0.14 : 1}>
      <rect
        data-slot={id}
        x={x}
        y={y}
        width={SLOT_W}
        height={SLOT_H}
        rx={3}
        fill={spare ? "transparent" : wired ? `url(#hatch-${k})` : IO_COLOURS[k]}
        fillOpacity={filled ? 0.92 : 1}
        className={spare ? "stroke-[color:var(--spare)] cursor-pointer" : "cursor-pointer"}
        stroke={spare ? undefined : IO_COLOURS[k]}
        strokeOpacity={spare ? 1 : 0.9}
        strokeWidth={spare ? 1 : 0.8}
      />
      {tag && (
        <g pointerEvents="none" className="font-mono">
          <text x={x + SLOT_W / 2} y={y + 7.6} textAnchor="middle" fontSize={4.1} fontWeight={500} className={filled ? "fill-[#0A0D13]" : "fill-text"} {...fitText(tag, SLOT_W - 3, 4.1)}>
            {tag}
          </text>
          {charm && (
            <text x={x + SLOT_W / 2} y={y + 13.6} textAnchor="middle" fontSize={3.3} className={filled ? "fill-[#0A0D13]" : "fill-muted-foreground"} fillOpacity={0.8}>
              {charm}
            </text>
          )}
          {tb && (
            <text x={x + SLOT_W / 2} y={y + 18.8} textAnchor="middle" fontSize={3.1} className={filled ? "fill-[#0A0D13]" : "fill-muted-foreground"} fillOpacity={0.65}>
              {tb}
            </text>
          )}
        </g>
      )}
    </g>
  );
});

/** Squeeze long mono tags into the slot instead of truncating them (every character stays readable). */
function fitText(t: string, max: number, size: number) {
  const natural = t.length * size * 0.6;
  return natural > max ? { textLength: max, lengthAdjust: "spacingAndGlyphs" as const } : {};
}

interface DetailProps {
  view: CabinetView;
  dims: Dims;
  side: "F" | "R";
  showText: boolean;
  match: ((s: Slot) => boolean) | null;
  drop?: MotionValue<number>;
  onCioc?: (local: number) => void;
}

/** The cabinet elevation: CIOC headers with capacity bars, baseplate rows, cable blocks and every slot. */
export const CabinetDetail = memo(function CabinetDetail({ view, dims, side, showText, match, drop, onCioc }: DetailProps) {
  const locals = sideLocals(side, dims);
  const blocks = view.blocks.filter((b) => locals.includes(b.ciocLocal));
  const nBlocks = Math.max(1, blocks.length);
  return (
    <g>
      {locals.map((local) => (
        <CiocFrame key={local} view={view} dims={dims} local={local} onClick={onCioc} />
      ))}
      {locals.map((local) =>
        (view.byCioc.get(local) ?? []).map((s) =>
          s.status === "Spare Slot" ? <SlotOf key={s.id} s={s} view={view} dims={dims} showText={false} match={match} /> : null,
        ),
      )}
      {blocks.map((b, j) => (
        <BlockGroup key={b.key} b={b} j={j} n={nBlocks} view={view} dims={dims} showText={showText} match={match} drop={drop} />
      ))}
    </g>
  );
});

function SlotOf({ s, view, dims, showText, match }: { s: Slot; view: CabinetView; dims: Dims; showText: boolean; match: ((s: Slot) => boolean) | null }) {
  const p = slotXY(view.index, s.cioc_local, s.bp, s.ch, dims);
  return (
    <SlotRect
      id={s.id}
      x={p.x}
      y={p.y}
      k={ioKey(s)}
      status={s.status}
      dim={!!match && !match(s)}
      tag={showText ? s.tag : undefined}
      charm={showText ? s.charm : undefined}
      tb={showText ? s.tb : undefined}
    />
  );
}

/** A cable block (its slots + outline). During the Upload Dive it drops in, staggered by physical order. */
function BlockGroup({ b, j, n, view, dims, showText, match, drop }: { b: Block; j: number; n: number; view: CabinetView; dims: Dims; showText: boolean; match: ((s: Slot) => boolean) | null; drop?: MotionValue<number> }) {
  const win = 0.45; // each block falls during a window of the drop progress
  const start = (j / n) * (1 - win);
  const local = useTransform(drop ?? ONE, (p) => clamp01((p - start) / win));
  const y = useTransform(local, (t) => (t >= 1 ? 0 : -60 * (1 - settle(t))));
  const opacity = useTransform(local, (t) => Math.min(1, t * 3));
  const slots = (view.byCioc.get(b.ciocLocal) ?? []).filter((s) => s.bp === b.bp && s.ch >= b.chFrom && s.ch <= b.chTo);
  const p0 = slotXY(view.index, b.ciocLocal, b.bp, b.chFrom, dims);
  const w = (b.chTo - b.chFrom) * SLOT_PITCH + SLOT_W;
  return (
    <>
    {/* sockets: the empty slot outlines stay put while the block falls into them */}
    <g pointerEvents="none">
      {slots.map((s) => {
        const q = slotXY(view.index, s.cioc_local, s.bp, s.ch, dims);
        return <rect key={s.id} x={q.x} y={q.y} width={SLOT_W} height={SLOT_H} rx={3} fill="none" className="stroke-[color:var(--spare)]" />;
      })}
    </g>
    <motion.g style={{ y, opacity }}>
      {slots.map((s) => (
        <SlotOf key={s.id} s={s} view={view} dims={dims} showText={showText} match={match} />
      ))}
      <rect x={p0.x - 1.5} y={p0.y - 1.5} width={w + 3} height={SLOT_H + 3} rx={4} fill="none" className="stroke-text" strokeOpacity={0.35} strokeWidth={1} pointerEvents="none" />
    </motion.g>
    </>
  );
}

/** Ease with a small overshoot-and-settle (the block "lands"). */
function settle(t: number) {
  const c = 1.5;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function CiocFrame({ view, dims, local, onClick }: { view: CabinetView; dims: Dims; local: number; onClick?: (local: number) => void }) {
  const info = view.info.ciocs.find((c) => c.local === local);
  const c = ciocRect(view.index, local, dims);
  const fill = ciocFill(view, local, dims);
  const fam = info?.family ?? "-";
  const blocksByBp = new Map<number, Block[]>();
  for (const b of view.blocks) {
    if (b.ciocLocal !== local) continue;
    const arr = blocksByBp.get(b.bp) ?? [];
    arr.push(b);
    blocksByBp.set(b.bp, arr);
  }
  const gutterX = c.x + BP_LABEL + dims.channels * SLOT_PITCH + 4;
  return (
    <g>
      <rect
        x={c.x - 6}
        y={c.y - 6}
        width={c.w + 12}
        height={c.h + 4}
        rx={6}
        className={fam === "-" ? "fill-bg stroke-border" : "fill-bg stroke-brand"}
        fillOpacity={0.55}
        strokeWidth={fam === "-" ? 1 : 2}
        strokeDasharray={fam === "B" ? "7 5" : undefined}
        strokeOpacity={fam === "-" ? 1 : 0.75}
      />
      {/* header: name, family, capacity bar */}
      <g className={onClick ? "cursor-pointer" : undefined} onClick={onClick ? () => onClick(local) : undefined} data-cioc={local}>
        <rect x={c.x} y={c.y} width={c.w} height={CIOC_HEAD - 10} rx={4} className="fill-raised" />
        <text x={c.x + 10} y={c.y + 20} className="fill-text font-mono" fontSize={11.5} fontWeight={500}>
          {info?.name ?? `CIOC ${local}`}
        </text>
        {fam !== "-" && (
          <text x={c.x + 132} y={c.y + 20} className="fill-brand" fontSize={10} fontWeight={600}>
            FAMILY {fam}
          </text>
        )}
        <rect x={c.x + c.w - 170} y={c.y + 12} width={110} height={7} rx={3.5} className="fill-bg" />
        <rect x={c.x + c.w - 170} y={c.y + 12} width={Math.max(3, 110 * fill)} height={7} rx={3.5} className="fill-brand" />
        <text x={c.x + c.w - 10} y={c.y + 20} textAnchor="end" className="fill-muted-foreground tnum" fontSize={10}>
          {(info?.used ?? 0) + (info?.wired_spares ?? 0)}/{info?.capacity ?? dims.bps * dims.channels}
        </text>
      </g>
      {(info?.baseplates ?? []).map((bp) => {
        const r = bpRect(view.index, local, bp.bp, dims);
        const bl = blocksByBp.get(bp.bp) ?? [];
        const label = bl.length ? `${bl[0].cable}${bl.length > 1 ? ` +${bl.length - 1}` : ""}` : bp.reserved === "future" ? "future spare" : bp.reserved === "cabinet_alarm" ? "cabinet alarms" : "";
        return (
          <g key={bp.bp} pointerEvents="none">
            <text x={r.x + 2} y={r.y + 14.5} className="fill-muted-foreground font-mono" fontSize={9.5}>
              {bp.name}
            </text>
            {bp.reserved && (
              <rect x={r.x + BP_LABEL - 3} y={r.y - 3} width={dims.channels * SLOT_PITCH + 2} height={SLOT_H + 6} rx={4} fill="none" strokeDasharray="4 3" className={bp.reserved === "cabinet_alarm" ? "stroke-io-alarm" : "stroke-muted-foreground"} strokeOpacity={0.7} />
            )}
            {label && (
              <text x={gutterX} y={r.y + 14.5} className={bl.length ? "fill-text font-mono" : "fill-muted-foreground"} fontSize={9} fillOpacity={bl.length ? 0.8 : 0.6}>
                {label.length > 17 ? `${label.slice(0, 16)}…` : label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
