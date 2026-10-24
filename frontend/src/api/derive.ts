import type { AllocationResult, CabinetInfo, Project, Slot } from "@/api/hooks";
import { ioKey, type IoKey } from "@/lib/io";

/** Grid dimensions — read from the data (cabinets/CIOCs/baseplates) with the project settings as the default. */
export interface Dims {
  ciocsPerCabinet: number;
  ciocsPerSide: number;
  bps: number;
  channels: number;
}

export function dimsOf(a: AllocationResult | undefined, p?: Project): Dims {
  const st = p?.settings;
  const ciocsPerCabinet = st?.ciocs_per_cabinet ?? Math.max(4, ...(a?.cabinets ?? []).map((c) => c.ciocs.length));
  const bps = st?.baseplates_per_cioc ?? a?.cabinets[0]?.ciocs[0]?.baseplates.length ?? 8;
  const channels = st?.channels_per_baseplate ?? Math.max(12, ...(a?.slots ?? []).slice(0, 2000).map((s) => s.ch));
  return { ciocsPerCabinet, ciocsPerSide: Math.ceil(ciocsPerCabinet / 2), bps, channels };
}

/** A contiguous run of channels on one baseplate that belongs to the same cable. */
export interface Block {
  key: string;
  cable: string;
  ciocLocal: number;
  bp: number;
  chFrom: number;
  chTo: number;
  io: IoKey;
  order: number; // physical order inside its cabinet (drives the Upload Dive drop stagger)
}

export interface BpHeat {
  ciocLocal: number;
  bp: number;
  io: IoKey | null; // dominant IO family of used channels
  fill: number;     // 0..1 used + wired spares
  reserved: string | null;
}

export interface CabinetView {
  info: CabinetInfo;
  index: number;
  slots: Slot[];                         // physical order
  byCioc: Map<number, Slot[]>;           // cioc_local → slots
  blocks: Block[];
  heat: BpHeat[];
  counts: { field: number; wired: number; spare: number; alarm: number };
}

export interface WorldModel {
  cabinets: CabinetView[];
  bySlotId: Map<string, Slot>;
  cabIndexByName: Map<string, number>;
  groups: string[];
}

const cache = new WeakMap<AllocationResult, WorldModel>();

/** Indexes an allocation once per result object (memoised on identity = per run). */
export function worldModel(a: AllocationResult, dims: Dims): WorldModel {
  const hit = cache.get(a);
  if (hit) return hit;
  const bySlotId = new Map<string, Slot>();
  const perCab = new Map<string, Slot[]>();
  const groups = new Set<string>();
  for (const s of a.slots) {
    bySlotId.set(s.id, s);
    let arr = perCab.get(s.cabinet);
    if (!arr) perCab.set(s.cabinet, (arr = []));
    arr.push(s);
    if (s.group && s.group !== "-") groups.add(s.group);
  }
  // The engine returns cabinets in physical order (the export's row order) — keep it.
  const cabinets = a.cabinets.map((info, index) => buildCabinet(info, index, perCab.get(info.name) ?? [], dims));
  const model: WorldModel = {
    cabinets,
    bySlotId,
    cabIndexByName: new Map(cabinets.map((c) => [c.info.name, c.index])),
    groups: [...groups].sort(),
  };
  cache.set(a, model);
  return model;
}

function buildCabinet(info: CabinetInfo, index: number, slots: Slot[], dims: Dims): CabinetView {
  slots.sort((x, y) => x.cioc_local - y.cioc_local || x.bp - y.bp || x.ch - y.ch);
  const byCioc = new Map<number, Slot[]>();
  const counts = { field: 0, wired: 0, spare: 0, alarm: 0 };
  for (const s of slots) {
    let arr = byCioc.get(s.cioc_local);
    if (!arr) byCioc.set(s.cioc_local, (arr = []));
    arr.push(s);
    if (s.status === "Field") counts.field++;
    else if (s.status === "Wired Spare") counts.wired++;
    else if (s.status === "Cabinet Alarm") counts.alarm++;
    else counts.spare++;
  }

  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const s of slots) {
    const cable = s.status === "Spare Slot" || s.cable === "-" ? null : s.cable;
    if (cur && cable && cur.cable === cable && cur.ciocLocal === s.cioc_local && cur.bp === s.bp && cur.chTo === s.ch - 1) {
      cur.chTo = s.ch;
      continue;
    }
    if (cur) blocks.push(cur);
    cur = cable
      ? { key: `${s.cioc_local}/${s.bp}/${s.ch}`, cable, ciocLocal: s.cioc_local, bp: s.bp, chFrom: s.ch, chTo: s.ch, io: ioKey(s), order: 0 }
      : null;
  }
  if (cur) blocks.push(cur);
  blocks.forEach((b, i) => (b.order = i));

  const heat: BpHeat[] = [];
  for (const c of info.ciocs) {
    const cs = byCioc.get(c.local) ?? [];
    for (const bp of c.baseplates) {
      const tally = new Map<IoKey, number>();
      for (const s of cs) {
        if (s.bp !== bp.bp || s.status === "Spare Slot") continue;
        const k = ioKey(s);
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
      let io: IoKey | null = null;
      let best = 0;
      for (const [k, n] of tally) if (n > best) (io = k), (best = n);
      heat.push({ ciocLocal: c.local, bp: bp.bp, io, fill: (bp.used + bp.wired_spares) / dims.channels, reserved: bp.reserved ?? null });
    }
  }
  return { info, index, slots, byCioc, blocks, heat, counts };
}

// ───────────── Flow Rail ─────────────

export type StepState = "done" | "todo" | "warn";
export interface FlowStep {
  key: string;
  label: string;
  path: string;
  state: StepState;
  hint: string;
}

export function flowSteps(p: Project | undefined, a: AllocationResult | undefined): FlowStep[] {
  const verified = !!a && !!a.certificate && a.report.violations === 0;
  const exported = !!a?.activity?.some((e) => e.kind === "export");
  const revised = (p?.revisions?.length ?? 1) > 1;
  return [
    { key: "upload", label: "Upload", path: "/import", state: p?.mdb_file ? "done" : "todo", hint: p?.mdb_file ?? "No MDB yet" },
    { key: "rules", label: "Rules", path: "/rules", state: (p?.ruleset_version ?? 0) >= 1 ? "done" : "todo", hint: `Rule set v${p?.ruleset_version ?? "–"}` },
    { key: "allocate", label: "Allocate", path: "/room", state: a?.run_id ? "done" : "todo", hint: a ? `${a.kpis.allocated}/${a.kpis.signals} signals` : "Not run" },
    {
      key: "verify", label: "Verify", path: "/proof", state: !a ? "todo" : verified ? "done" : "warn",
      hint: a ? `${a.report.violations} violations · ${a.report.checks_passed}/${a.report.checks_total} checks` : "Not run",
    },
    { key: "revise", label: "Revise", path: "/revisions", state: revised ? "done" : "todo", hint: revised ? `Rev ${p?.revision}` : "Rev A only" },
    { key: "export", label: "Export", path: "/export", state: exported ? "done" : "todo", hint: exported ? "Files downloaded" : "Nothing exported yet" },
  ];
}
