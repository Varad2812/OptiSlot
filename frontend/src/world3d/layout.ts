import type { Dims } from "@/api/derive";

// World units = metres-ish, ported from legacy3d/3d_prototype.html. Every count comes from Dims and the cabinet
// count — the prototype's C/K/B/M constants and CX positions are derived here, never hard-coded.
const CAB_PITCH = 4.6;     // prototype CX = [-4.6, 0, 4.6]
const ROW_PITCH = 6.2;     // rows face the same way; the gap is the rear-access aisle
const ROW_MAX = 8;
const COL_W = 1.44;        // one CIOC column (prototype ixOf = ±0.72 for two columns)
const CAB_H = 3.3;
const CAB_D = 1.8;
const BP_PACKED = 0.34;    // prototype bpY: 1.6 + (b - 3.5) * (0.34 + 0.3 * s)
const BP_SPREAD = 0.3;
const CH_PITCH = 0.098;

export interface Layout {
  n: number;
  /** CIOCs per cabinet, per side, baseplates per CIOC, channels per baseplate. */
  K: number;
  perSide: number;
  B: number;
  M: number;
  N: number;
  W: number;
  H: number;
  D: number;
  cab: { x: number; z: number; row: number }[];
  rows: number;
  /** Room: floor/grid/wall sizes, junction box, fog, camera home pose. */
  room: { cx: number; cz: number; w: number; d: number; wallZ: number; floor: number; grid: number; fog: number; scale: number };
  jb: [number, number, number];
  home: { pos: [number, number, number]; target: [number, number, number] };
  charm: { w: number; h: number; d: number; pitch: number };
  bpW: number;
}

export function makeLayout(n: number, d: Dims): Layout {
  const K = d.ciocsPerCabinet;
  const perSide = Math.max(1, d.ciocsPerSide);
  const B = Math.max(1, d.bps);
  const M = Math.max(1, d.channels);
  const W = Math.max(3.1, perSide * COL_W + 0.22);
  const pitchX = Math.max(CAB_PITCH, W + 1.5);
  const perRow = Math.min(Math.max(1, n), ROW_MAX);
  const rows = Math.max(1, Math.ceil(n / perRow));
  const cab = Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, n - row * perRow);
    const col = i - row * perRow;
    return { x: (col - (inRow - 1) / 2) * pitchX, z: -row * ROW_PITCH, row };
  });
  const w = (perRow - 1) * pitchX + W;
  const depth = (rows - 1) * ROW_PITCH + CAB_D;
  const cz = -((rows - 1) * ROW_PITCH) / 2;
  const wallZ = -(rows - 1) * ROW_PITCH - 7.2;
  // Scale relative to the prototype's 3-cabinet row, so its camera poses and fog read the same at n = 3.
  const scale = Math.max(1, w / 12.3, (depth * 1.6) / 12.3);
  const floor = Math.max(90, (w + depth) * 3);
  const pitchCh = Math.min(CH_PITCH, 1.18 / M);
  return {
    n, K, perSide, B, M, N: n * K * B * M, W, H: CAB_H, D: CAB_D, cab, rows,
    room: { cx: 0, cz, w, d: depth, wallZ, floor, grid: Math.ceil(Math.max(60, (w + depth) * 2)), fog: 0.014 / scale, scale },
    jb: [0, 5.2, wallZ + 0.3],
    // the prototype's (0, 7.5, 23) pose, pulled in a little: the World sits in a panel, not a full window
    home: { pos: [0, 1.4 + 5.2 * scale, cz + 19.5 * scale], target: [0, 1.4, cz] },
    charm: { w: pitchCh * 0.84, h: 0.15, d: 0.2, pitch: pitchCh },
    bpW: Math.max(1.2, M * pitchCh + 0.024),
  };
}

/** Flat instance index — the prototype's idx(c,k,b,m) with 0-based k (cioc_local - 1), b (bp - 1), m (ch - 1). */
export const idxOf = (L: Layout, c: number, k: number, b: number, m: number) => ((c * L.K + k) * L.B + b) * L.M + m;
export function decode(L: Layout, i: number) {
  const m = i % L.M;
  const b = Math.floor(i / L.M) % L.B;
  const k = Math.floor(i / (L.M * L.B)) % L.K;
  const c = Math.floor(i / (L.M * L.B * L.K));
  return { c, k, b, m };
}

/** CIOC local index k (0-based) → side: front shows 0..perSide-1, rear the rest. */
export const isRear = (L: Layout, k: number) => k >= L.perSide;
/** x offset of a CIOC column inside its cabinet (prototype ixOf). Rear columns mirror so CIOC 3 sits behind CIOC 1. */
export function ixOf(L: Layout, k: number) {
  const col = k % L.perSide;
  return (col - (L.perSide - 1) / 2) * COL_W;
}
/** z offset of a CIOC (prototype zOf: front +0.38, rear −0.38). */
export const zOf = (L: Layout, k: number) => (isRear(L, k) ? -0.38 : 0.38);

/** Baseplate pitch for spread factor s (0 packed … 1 exploded). Packed pitch shrinks for tall CIOCs so they still fit. */
const bpPitch = (L: Layout, s: number) => Math.min(BP_PACKED, 2.8 / L.B) + BP_SPREAD * s;
/** Centre height of a CIOC stack; lifted when exploded so the bottom baseplate never sinks through the floor. */
export function stackY(L: Layout, s: number) {
  const half = ((L.B - 1) / 2) * bpPitch(L, s);
  return Math.max(1.6, half + 0.25);
}
/** Baseplate b (0-based) centre height at spread s — the prototype's bpY generalised. Baseplate 1 is at the top. */
export function bpY(L: Layout, s: number, b: number) {
  return stackY(L, s) + ((L.B - 1) / 2 - b) * bpPitch(L, s);
}
/** CIOC frame height for spread s (prototype: (B·(0.34+0.3s)+0.3) scaled against 3.1). */
export const frameH = (L: Layout, s: number) => L.B * bpPitch(L, s) + 0.3;
/** CHARM m (0-based) x offset on its baseplate. */
export const chX = (L: Layout, m: number) => (m - (L.M - 1) / 2) * L.charm.pitch;
