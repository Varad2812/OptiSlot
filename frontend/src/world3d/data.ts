import type { Dims, WorldModel } from "@/api/derive";
import type { CiocInfo, Slot } from "@/api/hooks";
import { IO_ORDER, ioKey, type IoKey } from "@/lib/io";

import { idxOf, makeLayout, type Layout } from "./layout";

/** CHARM kinds: index into KIND_KEYS; NONE = no CIOC there (hidden), SPARE = a Spare Slot (dark). */
export const KIND_KEYS: IoKey[] = IO_ORDER; // ai, ao, di, do, doiso, alarm
export const NONE = -2;
export const SPARE = -1;

export const ST_NONE = 0;
export const ST_FIELD = 1;
export const ST_WIRED = 2;
export const ST_SPARE = 3;
export const ST_ALARM = 4;

export interface CableRun {
  cable: string;
  chFrom: number; // 1-based
  chTo: number;
  io: IoKey;
}

export interface CabinetData {
  name: string;
  controller: string;
  systemCabinet: string;
  /** Indexed by k = cioc_local - 1; null when that CIOC is not instantiated. */
  ciocs: (CiocInfo | null)[];
  /** Cable runs per (k, b): runs[k][b]. */
  runs: CableRun[][][];
}

/** Everything the engine needs, flattened to typed arrays indexed by idxOf(c,k,b,m). Built once per allocation. */
export interface World3DData {
  dims: Dims;
  layout: Layout;
  kind: Int8Array;
  status: Uint8Array;
  slots: (Slot | null)[];
  index: Map<string, number>;
  cabinets: CabinetData[];
  /** Baseplates that received cables, in allocation order (the Upload Dive trails stream to these). */
  trailTargets: { c: number; k: number; b: number; io: IoKey }[];
}

const cache = new WeakMap<WorldModel, World3DData>();

export function world3dData(model: WorldModel, dims: Dims): World3DData {
  const hit = cache.get(model);
  if (hit && hit.dims === dims) return hit;
  const L = makeLayout(model.cabinets.length, dims);
  const kind = new Int8Array(L.N).fill(NONE);
  const status = new Uint8Array(L.N);
  const slots: (Slot | null)[] = new Array(L.N).fill(null);
  const index = new Map<string, number>();
  const trailTargets: World3DData["trailTargets"] = [];
  const cabinets: CabinetData[] = model.cabinets.map((cv, c) => {
    const ciocs: (CiocInfo | null)[] = Array.from({ length: L.K }, () => null);
    for (const ci of cv.info.ciocs) if (ci.local >= 1 && ci.local <= L.K) ciocs[ci.local - 1] = ci;
    for (const s of cv.slots) {
      const k = s.cioc_local - 1, b = s.bp - 1, m = s.ch - 1;
      if (k < 0 || k >= L.K || b < 0 || b >= L.B || m < 0 || m >= L.M) continue; // outside the settings grid: the 2D view still shows it
      const i = idxOf(L, c, k, b, m);
      slots[i] = s;
      index.set(s.id, i);
      const key = ioKey(s);
      kind[i] = key === "spare" ? SPARE : KIND_KEYS.indexOf(key);
      status[i] = s.status === "Field" ? ST_FIELD : s.status === "Wired Spare" ? ST_WIRED : s.status === "Cabinet Alarm" ? ST_ALARM : ST_SPARE;
    }
    // An instantiated CIOC with missing rows still shows its empty slots as spares.
    for (let k = 0; k < L.K; k++) {
      if (!ciocs[k]) continue;
      for (let j = idxOf(L, c, k, 0, 0), e = j + L.B * L.M; j < e; j++) if (kind[j] === NONE) (kind[j] = SPARE), (status[j] = ST_SPARE);
    }
    const runs: CableRun[][][] = Array.from({ length: L.K }, () => Array.from({ length: L.B }, () => []));
    const seen = new Set<string>();
    for (const bl of cv.blocks) {
      const k = bl.ciocLocal - 1, b = bl.bp - 1;
      if (k < 0 || k >= L.K || b < 0 || b >= L.B) continue;
      const prev = runs[k][b].at(-1);
      // One label per cable on a baseplate, even when a Spare Slot pair splits its block.
      if (prev && prev.cable === bl.cable) prev.chTo = bl.chTo;
      else runs[k][b].push({ cable: bl.cable, chFrom: bl.chFrom, chTo: bl.chTo, io: bl.io });
      const key = `${k}/${b}`;
      if (!seen.has(key)) seen.add(key), trailTargets.push({ c, k, b, io: bl.io });
    }
    return { name: cv.info.name, controller: cv.info.controller, systemCabinet: cv.info.system_cabinet, ciocs, runs };
  });
  const data: World3DData = { dims, layout: L, kind, status, slots, index, cabinets, trailTargets };
  cache.set(model, data);
  return data;
}
