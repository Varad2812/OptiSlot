import type { Dims } from "@/api/derive";

// World units (1 unit ≈ 1 px at camera scale 1). Every count comes from Dims — no 4/8/12 literals.
export const SLOT_W = 34;
export const SLOT_H = 22;
export const SLOT_PITCH = 36;
export const ROW_PITCH = 28;
export const BP_LABEL = 64;
export const GUTTER = 104;     // cable labels to the right of each baseplate row
export const CIOC_HEAD = 42;
export const CIOC_GAP = 26;
export const PAD_X = 20;
export const NAMEPLATE = 66;
export const PLINTH = 30;
export const DEPTH_X = 56;     // 2.5D: the side face recedes up and to the right
export const DEPTH_Y = -32;
export const AISLE = 170;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function ciocW(d: Dims) {
  return BP_LABEL + d.channels * SLOT_PITCH - (SLOT_PITCH - SLOT_W) + GUTTER;
}
export function ciocH(d: Dims) {
  return CIOC_HEAD + d.bps * ROW_PITCH;
}
export function cabW(d: Dims) {
  return ciocW(d) + PAD_X * 2;
}
export function cabH(d: Dims) {
  return NAMEPLATE + d.ciocsPerSide * ciocH(d) + (d.ciocsPerSide - 1) * CIOC_GAP + PLINTH;
}
export function pitch(d: Dims) {
  return cabW(d) + DEPTH_X + AISLE;
}

export function cabinetRect(i: number, d: Dims): Rect {
  return { x: i * pitch(d), y: 0, w: cabW(d), h: cabH(d) };
}

/** The cabinet including its receding side/top faces. */
export function cabinetBounds(i: number, d: Dims): Rect {
  const r = cabinetRect(i, d);
  return { x: r.x, y: r.y + DEPTH_Y, w: r.w + DEPTH_X, h: r.h - DEPTH_Y };
}

/** Row position of a CIOC on its side: front shows locals 1..k, rear shows k+1..2k. */
export function ciocRow(ciocLocal: number, d: Dims) {
  return (ciocLocal - 1) % d.ciocsPerSide;
}
export function sideOf(ciocLocal: number, d: Dims): "F" | "R" {
  return ciocLocal <= d.ciocsPerSide ? "F" : "R";
}

export function ciocRect(i: number, ciocLocal: number, d: Dims): Rect {
  const c = cabinetRect(i, d);
  const row = ciocRow(ciocLocal, d);
  return { x: c.x + PAD_X, y: c.y + NAMEPLATE + row * (ciocH(d) + CIOC_GAP), w: ciocW(d), h: ciocH(d) };
}

export function bpRect(i: number, ciocLocal: number, bp: number, d: Dims): Rect {
  const c = ciocRect(i, ciocLocal, d);
  return { x: c.x, y: c.y + CIOC_HEAD + (bp - 1) * ROW_PITCH, w: c.w, h: SLOT_H };
}

export function slotXY(i: number, ciocLocal: number, bp: number, ch: number, d: Dims) {
  const b = bpRect(i, ciocLocal, bp, d);
  return { x: b.x + BP_LABEL + (ch - 1) * SLOT_PITCH, y: b.y };
}

export function worldBounds(n: number, d: Dims): Rect {
  return { x: -AISLE, y: DEPTH_Y - 80, w: Math.max(1, n) * pitch(d) + AISLE, h: cabH(d) - DEPTH_Y + 200 };
}

// ───────────── camera fitting ─────────────

export interface Cam {
  x: number;
  y: number;
  s: number;
}
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function fit(r: Rect, vw: number, vh: number, ins: Insets, maxS = 6): Cam {
  const aw = Math.max(50, vw - ins.left - ins.right);
  const ah = Math.max(50, vh - ins.top - ins.bottom);
  const s = Math.min(aw / r.w, ah / r.h, maxS);
  return { s, x: ins.left + (aw - r.w * s) / 2 - r.x * s, y: ins.top + (ah - r.h * s) / 2 - r.y * s };
}

/** Plant view = every cabinet in the row. */
export function plantRect(n: number, d: Dims): Rect {
  const last = cabinetBounds(Math.max(0, n - 1), d);
  const first = cabinetBounds(0, d);
  return { x: first.x - 60, y: first.y - 40, w: last.x + last.w - first.x + 120, h: first.h + 170 };
}

/** The Cabinet level's thresholds, relative to the cabinet fit (scale-independent of the viewport). */
export function tierOf(s: number, cabinetS: number): "plant" | "cabinet" | "detail" {
  if (s < cabinetS * 0.85) return "plant";
  if (s < cabinetS * 1.5) return "cabinet";
  return "detail";
}
