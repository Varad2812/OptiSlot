import type { Dims, WorldModel } from "@/api/derive";
import type { AllocationResult, CabinetInfo, Slot } from "@/api/hooks";
import type { WhatIfResult } from "@/api/sandbox";
import { ioKey, type IoKey } from "@/lib/io";
import { bpRect, ROW_PITCH, SLOT_H, SLOT_PITCH, SLOT_W, slotXY, type Rect } from "@/world/geometry";

// ───────────── proposed allocation = baseline + the what-if's changed slots ─────────────

/**
 * The what-if returns only the slots whose content changed (a slot id is a physical position). Overlay them on the
 * base allocation and re-derive the per-baseplate counts the World draws its capacity bars from.
 */
export function overlayAllocation(base: AllocationResult, wi: WhatIfResult | null): AllocationResult {
  if (!wi) return base;
  const changed = new Map((wi.slots ?? []).map((s) => [s.id, s]));
  const slots = changed.size ? base.slots.map((s) => changed.get(s.id) ?? s) : base.slots;
  return { ...base, slots, cabinets: changed.size ? rederive(base.cabinets, slots) : base.cabinets, kpis: wi.kpis, report: wi.report };
}

function rederive(cabinets: CabinetInfo[], slots: Slot[]): CabinetInfo[] {
  const used = new Map<string, number>();
  const wired = new Map<string, number>();
  const fams = new Map<string, Set<string>>();
  for (const s of slots) {
    const kb = `${s.cabinet}/${s.cioc_local}/${s.bp}`;
    const kc = `${s.cabinet}/${s.cioc_local}`;
    if (s.status === "Field" || s.status === "Cabinet Alarm") used.set(kb, (used.get(kb) ?? 0) + 1);
    else if (s.status === "Wired Spare") wired.set(kb, (wired.get(kb) ?? 0) + 1);
    if (s.status === "Field" && s.family !== "-") (fams.get(kc) ?? fams.set(kc, new Set()).get(kc)!).add(s.family);
  }
  return cabinets.map((c) => ({
    ...c,
    ciocs: c.ciocs.map((ci) => {
      const baseplates = ci.baseplates.map((bp) => ({ ...bp, used: used.get(`${c.name}/${ci.local}/${bp.bp}`) ?? 0, wired_spares: wired.get(`${c.name}/${ci.local}/${bp.bp}`) ?? 0 }));
      const f = fams.get(`${c.name}/${ci.local}`);
      return {
        ...ci,
        baseplates,
        used: baseplates.reduce((n, b) => n + b.used, 0),
        wired_spares: baseplates.reduce((n, b) => n + b.wired_spares, 0),
        family: f?.size === 1 ? ([...f][0] as typeof ci.family) : f ? ci.family : "-",
      };
    }),
  }));
}

// ───────────── cable blocks ─────────────

export interface BlockInfo {
  id: string;
  cable: string;
  size: number;          // pairs = slots the cable occupies (used + wired spare)
  span: number;          // whole baseplates for ≥ one-baseplate cables, else 0
  fams: Set<string>;     // segregation families (A/B) present on the cable
  domain: string;
  cabinet: string;
  cabIdx: number;
  ciocLocal: number;
  bp: number;
  ch: number;
  io: IoKey;
  slots: Slot[];
}

const indexCache = new WeakMap<AllocationResult, Map<string, Slot[]>>();
function blockIndex(a: AllocationResult) {
  let m = indexCache.get(a);
  if (!m) {
    m = new Map();
    for (const s of a.slots) {
      if (!s.block_id) continue;
      const arr = m.get(s.block_id);
      if (arr) arr.push(s);
      else m.set(s.block_id, [s]);
    }
    indexCache.set(a, m);
  }
  return m;
}

export function blockInfo(a: AllocationResult, model: WorldModel, dims: Dims, id: string): BlockInfo | null {
  const slots = blockIndex(a).get(id);
  if (!slots?.length) return null;
  const sorted = [...slots].sort((x, y) => x.bp - y.bp || x.ch - y.ch);
  const first = sorted[0];
  const size = sorted.length;
  const field = sorted.find((s) => s.status === "Field") ?? first;
  return {
    id, cable: first.cable, size, span: size >= dims.channels ? Math.ceil(size / dims.channels) : 0,
    fams: new Set(sorted.map((s) => s.family).filter((f) => f !== "-")),
    domain: first.domain, cabinet: first.cabinet, cabIdx: model.cabIndexByName.get(first.cabinet) ?? 0,
    ciocLocal: first.cioc_local, bp: first.bp, ch: first.ch, io: ioKey(field), slots: sorted,
  };
}

/** World rectangle of a block: one slot-strip for a packed cable, whole baseplate rows for a spanning cable. */
export function blockRect(b: BlockInfo, dims: Dims): Rect {
  const p = slotXY(b.cabIdx, b.ciocLocal, b.bp, b.span ? 1 : b.ch, dims);
  if (b.span) return { x: p.x, y: p.y, w: dims.channels * SLOT_PITCH - (SLOT_PITCH - SLOT_W), h: (b.span - 1) * ROW_PITCH + SLOT_H };
  return { x: p.x, y: p.y, w: (b.size - 1) * SLOT_PITCH + SLOT_W, h: SLOT_H };
}

export function targetRect(b: BlockInfo, cabIdx: number, local: number, bp: number, ch: number, dims: Dims): Rect {
  const p = slotXY(cabIdx, local, bp, b.span ? 1 : ch, dims);
  if (b.span) return { x: p.x, y: p.y, w: dims.channels * SLOT_PITCH - (SLOT_PITCH - SLOT_W), h: (b.span - 1) * ROW_PITCH + SLOT_H };
  return { x: p.x, y: p.y, w: (b.size - 1) * SLOT_PITCH + SLOT_W, h: SLOT_H };
}

// ───────────── target hints (the server stays the authority; these only colour the grid) ─────────────

export interface RowTargets {
  starts: number[];      // valid start channels (1 for spanning cables)
  reason: string;        // why the row has none
}

export interface SegRule {
  id: string;
  label: string;
}

/** For the active cabinet: per `${cioc_local}/${bp}` the valid start channels, or the reason there are none. */
export function targetsFor(model: WorldModel, cabIdx: number, b: BlockInfo, dims: Dims, seg: SegRule | null): Map<string, RowTargets> {
  const out = new Map<string, RowTargets>();
  const cab = model.cabinets[cabIdx];
  if (!cab) return out;
  const sameDomain = cab.info.domain === b.domain;
  const cell = new Map<string, Slot>();
  for (const s of cab.slots) cell.set(`${s.cioc_local}/${s.bp}/${s.ch}`, s);
  const free = (local: number, bp: number, ch: number) => {
    const s = cell.get(`${local}/${bp}/${ch}`);
    return !!s && (s.status === "Spare Slot" || s.block_id === b.id);
  };
  for (const ci of cab.info.ciocs) {
    const others = new Set<string>();
    for (const s of cab.byCioc.get(ci.local) ?? []) if (s.block_id !== b.id && s.family !== "-" && s.status !== "Spare Slot") others.add(s.family);
    if (ci.family !== "-") others.add(ci.family);
    const clash = b.fams.size ? [...others].filter((f) => !b.fams.has(f)) : [];
    for (const bpInfo of ci.baseplates) {
      const key = `${ci.local}/${bpInfo.bp}`;
      const starts: number[] = [];
      let reason = "no free channels here";
      if (!sameDomain) reason = `belongs to controller domain ${b.domain}`;
      else if (clash.length) reason = `${[...b.fams].join("/")}-family cable cannot join a CIOC holding ${clash.join("/")}-family signals${seg ? ` — rule ${seg.id}: ${seg.label}` : ""}`;
      else if (bpInfo.reserved) reason = `baseplate ${bpInfo.bp} is reserved (${bpInfo.reserved.replace("_", " ")})`;
      else if (b.span) {
        const rows = Array.from({ length: b.span }, (_, k) => bpInfo.bp + k);
        const reservedRow = rows.find((x) => ci.baseplates.find((q) => q.bp === x)?.reserved);
        if (rows[rows.length - 1] > dims.bps) reason = `${b.size}-pair cable needs ${b.span} whole baseplates from BP ${bpInfo.bp} — beyond baseplate ${dims.bps}`;
        else if (reservedRow) reason = `baseplate ${reservedRow} in the span is reserved`;
        else if (rows.every((x) => Array.from({ length: dims.channels }, (_, c) => free(ci.local, x, c + 1)).every(Boolean))) starts.push(1);
        else reason = `needs ${b.span} empty baseplate(s) from BP ${bpInfo.bp}`;
      } else {
        for (let c = 1; c + b.size - 1 <= dims.channels; c += b.size) {
          if (Array.from({ length: b.size }, (_, k) => free(ci.local, bpInfo.bp, c + k)).every(Boolean)) starts.push(c);
        }
      }
      // moving onto where it already is is not a move
      const here = b.cabIdx === cabIdx && b.ciocLocal === ci.local && b.bp === bpInfo.bp;
      out.set(key, { starts: here ? starts.filter((c) => c !== (b.span ? 1 : b.ch)) : starts, reason });
    }
  }
  return out;
}

export function rowRect(cabIdx: number, local: number, bp: number, dims: Dims): Rect {
  const r = bpRect(cabIdx, local, bp, dims);
  return { x: r.x + 64, y: r.y, w: dims.channels * SLOT_PITCH - (SLOT_PITCH - SLOT_W), h: SLOT_H };
}

// ───────────── Impact ─────────────

export interface Impact {
  violations: number;
  moves: number;
  ciocs: number;
  cabinets: number;
  fill: number;
  bom: { part: string; delta: number }[];
  bomTotal: number;
}

export function impactOf(base: AllocationResult, prop: AllocationResult): Impact {
  const at = new Map<string, string>();
  for (const s of base.slots) if (s.status === "Field" || s.status === "Cabinet Alarm") at.set(s.tag_key, s.id);
  let moves = 0;
  for (const s of prop.slots) {
    if (s.status !== "Field" && s.status !== "Cabinet Alarm") continue;
    const was = at.get(s.tag_key);
    if (was && was !== s.id) moves++;
  }
  const parts = new Set([...Object.keys(base.kpis.hardware_bom ?? {}), ...Object.keys(prop.kpis.hardware_bom ?? {})]);
  const bom = [...parts]
    .map((part) => ({ part, delta: (prop.kpis.hardware_bom?.[part] ?? 0) - (base.kpis.hardware_bom?.[part] ?? 0) }))
    .filter((x) => x.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    violations: prop.report.violations, moves, ciocs: prop.kpis.ciocs, cabinets: prop.kpis.cabinets, fill: prop.kpis.fill_pct,
    bom, bomTotal: bom.reduce((n, x) => n + x.delta, 0),
  };
}
