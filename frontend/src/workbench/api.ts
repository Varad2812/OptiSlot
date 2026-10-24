import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { getJson, postJson } from "@/api/client";
import { useAllocation, useProjectId, type AllocationResult, type S, type Slot } from "@/api/hooks";
import { IO_COLOURS, ioKey } from "@/lib/io";

// Signal Workbench API (docs/api_workbench.md) — types come from the generated schema.
export type SignalRow = S["SignalRow"];
export type SignalList = S["SignalList"];
export type SignalFix = S["SignalFix"];
export type PlacementCheck = S["PlacementCheck"];
export type PlacementApplyResult = S["PlacementApplyResult"];
export type PlacementState = S["PlacementState"];
export type PlacementChangeSet = S["PlacementChangeSet"];
export type PlacementTarget = S["PlacementTarget"];
export type PlacementAlternative = S["PlacementAlternative"];
export type PlacementCommitResult = S["PlacementCommitResult"];
export type SignalPatchResult = S["SignalPatchResult"];
export type SignalState = SignalRow["state"];
export type Kpis = S["Kpis"];

export const STATES: SignalState[] = ["allocated", "warning", "unallocated", "quarantined", "deleted"];

/** Server-side sort keys of GET /signals. */
export type SortKey = "row" | "tag" | "io_type" | "cable" | "state" | "cabinet" | "cioc" | "slot";

export interface SignalFilters {
  q: string;
  io: string[];
  status: string[];
  cabinet: string;
  cable: string;
  tq: string;
  sort: SortKey;
  order: "asc" | "desc";
}

export const NO_SIGNAL_FILTERS: SignalFilters = { q: "", io: [], status: [], cabinet: "", cable: "", tq: "", sort: "row", order: "asc" };

export const PAGE = 300;

/** Tag identity ignoring whitespace and case (the MDB spells tags with padding). */
export const tagKey = (t: string) => t.replace(/\s+/g, "").toLowerCase();
export const sameSignal = (a: { tag: string; row: number } | null, b: { tag: string; row: number } | null) => !!a && !!b && a.row === b.row && tagKey(a.tag) === tagKey(b.tag);

function query(f: SignalFilters, offset: number, limit: number) {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.io.length) p.set("io_type", f.io.join(","));
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.cabinet) p.set("cabinet", f.cabinet);
  if (f.cable.trim()) p.set("cable", f.cable.trim());
  if (f.tq) p.set("tq", f.tq);
  p.set("sort", f.sort);
  p.set("order", f.order);
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  return p.toString();
}

/** Offline: a reduced signal list rebuilt from the allocation fixture (Field + Cabinet Alarm slots only), filtered client-side. */
function fromAllocation(a: AllocationResult, f: SignalFilters, offset: number, limit: number): SignalList {
  const q = f.q.trim().toLowerCase();
  const all: SignalRow[] = a.slots
    .filter((s) => s.status === "Field" || s.status === "Cabinet Alarm")
    .map((s) => ({
      tag: s.tag, tag_key: s.tag_key, row: s.source_row ?? 0, state: (s.tq_ids?.length ? "warning" : "allocated") as SignalState, tag_status: s.status,
      io_type: s.io_type, io_type_raw: s.io_type, instrument_type: s.instrument_type, cable: s.cable, pair: s.pair, cable_size: s.cable_size,
      family: s.family, group: s.group, is_flag: null, reason: (s.why ?? []).map((w) => w.text).join(" "), rule_ids: [], tq_ids: s.tq_ids ?? [], fixes: [],
      location: { cabinet: s.cabinet, cabinet_seq: s.cabinet_seq, controller: s.controller, cioc: s.cioc, cioc_seq: s.cioc_seq, cioc_local: s.cioc_local, side: s.side, baseplate: s.baseplate, bp: s.bp, ch: s.ch, charm_no: s.charm_no, slot_id: s.id },
      hardware: { charm: s.charm, charm_desc: s.charm_desc, tb: s.tb, tb_desc: s.tb_desc, tb1: s.tb1, tb2: s.tb2, tb3: s.tb3 },
      block_id: s.block_id, can_move: false, quarantine_reason: null, source: {}, normalised: {},
    }));
  const hit = all.filter((r) => {
    if (q && !`${r.tag} ${r.cable} ${r.instrument_type} ${r.location?.cabinet}`.toLowerCase().includes(q)) return false;
    if (f.io.length && !f.io.includes(r.io_type)) return false;
    if (f.cabinet && r.location?.cabinet !== f.cabinet) return false;
    if (f.cable && !r.cable.toLowerCase().includes(f.cable.toLowerCase())) return false;
    if (f.tq && !(r.tq_ids ?? []).includes(f.tq)) return false;
    if (f.status.length && !f.status.includes(r.state) && !f.status.includes(r.tag_status)) return false;
    return true;
  });
  const by_state: Record<string, number> = {}, by_io_type: Record<string, number> = {}, by_cabinet: Record<string, number> = {};
  for (const r of hit) {
    by_state[r.state] = (by_state[r.state] ?? 0) + 1;
    by_io_type[r.io_type] = (by_io_type[r.io_type] ?? 0) + 1;
    const c = r.location?.cabinet ?? "-";
    by_cabinet[c] = (by_cabinet[c] ?? 0) + 1;
  }
  return {
    project_id: "offline", revision: a.revision, run_id: a.run_id, limit, offset,
    counts: { total: all.length, matching: hit.length, by_state, by_io_type, by_cabinet }, rows: hit.slice(offset, offset + limit),
  };
}

/** Every signal, paged by 300 (each row carries the raw MDB row, so one page is ~1 MB): more load as the table scrolls. */
export function useSignals(f: SignalFilters) {
  const pid = useProjectId();
  const { data: a } = useAllocation();
  const q = useInfiniteQuery({
    queryKey: ["signals", pid, f],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getJson<SignalList>(`/projects/${pid}/signals?${query(f, pageParam, PAGE)}`, a ? () => fromAllocation(a, f, pageParam, PAGE) : undefined),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return last.rows.length > 0 && loaded < last.counts.matching ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pages = q.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  return { ...q, rows, counts: pages[0]?.counts ?? null, runId: pages[0]?.run_id };
}

/** One signal, fresh (the table row may be a page behind after a move). */
export function useSignal(sel: { tag: string; row: number } | null, placeholder?: SignalRow | null) {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["signal", pid, sel?.tag, sel?.row],
    enabled: !!sel,
    queryFn: () => getJson<SignalRow>(`/projects/${pid}/signals/${encodeURIComponent(sel!.tag)}?row=${sel!.row}`),
    placeholderData: placeholder ?? undefined,
    retry: false,
  });
}

/** Resolve `?tag=` (any spelling) to the exact MDB row. */
export async function findSignal(pid: string, tag: string): Promise<SignalRow | null> {
  const list = await getJson<SignalList>(`/projects/${pid}/signals?q=${encodeURIComponent(tag.trim())}&limit=25`);
  const want = tagKey(tag);
  return list.rows.find((r) => tagKey(r.tag) === want) ?? list.rows[0] ?? null;
}

// --- sandbox ---------------------------------------------------------------------------------------------------------

export function usePlacementState() {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["placement", pid],
    queryFn: () => getJson<PlacementState>(`/projects/${pid}/placement`),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export interface CheckArgs {
  tag: string;
  row: number;
  target: PlacementTarget;
}

/** POST /placement/check for a complete target. A refusal is a normal 200 result, never an error. */
export function usePlacementCheck(args: CheckArgs | null) {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["wb-check", pid, args?.tag, args?.row, args?.target.cabinet, args?.target.cioc, args?.target.bp, args?.target.ch, args?.target.slot_id],
    enabled: !!args,
    staleTime: 0,
    gcTime: 15_000,
    retry: false,
    queryFn: () => postJson<PlacementCheck>(`/projects/${pid}/placement/check`, { tag: args!.tag, row: args!.row, target: args!.target, alternatives: 5 }),
  });
}

/** Drop everything a sandbox / committed change can invalidate. `committed` also refreshes the allocation + scoreboard. */
function useRefresh() {
  const qc = useQueryClient();
  const pid = useProjectId();
  return (state?: PlacementState, committed = false) => {
    if (state) {
      qc.setQueryData(["placement", pid], state);
      if (state.changes) qc.setQueryData(["placement-changes", pid], state.changes);
    }
    void qc.invalidateQueries({ queryKey: ["signals", pid] });
    void qc.invalidateQueries({ queryKey: ["signal", pid] });
    void qc.invalidateQueries({ queryKey: ["wb-check", pid] });
    if (!state) void qc.invalidateQueries({ queryKey: ["placement", pid] });
    void qc.invalidateQueries({ queryKey: ["placement-changes", pid] });
    if (committed) void qc.invalidateQueries();
  };
}

export interface ApplyArgs extends CheckArgs {
  swap?: boolean;
  reason?: string;
}

export function useApplyMove() {
  const pid = useProjectId();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: ApplyArgs) =>
      postJson<PlacementApplyResult>(`/projects/${pid}/placement/apply`, { tag: v.tag, row: v.row, target: v.target, swap: !!v.swap, reason: v.reason ?? "", alternatives: 0 }),
    onSuccess: (res) => {
      refresh(res.state);
      if (res.state.stale) toast.message("Sandbox was reset — the committed allocation changed underneath it");
    },
    // a refused apply is carried in the result (applied:false); only a transport failure lands here
    onError: (e) => toast.error("Could not reach the sandbox", { description: (e as Error).message }),
  });
}

function useStackOp(op: "undo" | "redo" | "reset") {
  const pid = useProjectId();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => postJson<PlacementState>(`/projects/${pid}/placement/${op}`),
    onSuccess: (s) => refresh(s),
    onError: (e) => toast.message(`Nothing to ${op}`, { description: (e as Error).message }),
  });
}
export const useUndoMove = () => useStackOp("undo");
export const useRedoMove = () => useStackOp("redo");
export const useResetSandbox = () => useStackOp("reset");

export function useCommitMoves() {
  const pid = useProjectId();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { reason: string; who: string }) => postJson<PlacementCommitResult>(`/projects/${pid}/placement/commit`, v),
    onSuccess: () => refresh(undefined, true),
  });
}

export interface PatchArgs {
  tag: string;
  row: number;
  fields: Record<string, string>;
  preview: boolean;
  reason?: string;
}

export function usePatchSignal() {
  const pid = useProjectId();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: PatchArgs) =>
      postJson<SignalPatchResult>(`/projects/${pid}/signals/${encodeURIComponent(v.tag)}/patch`, { fields: v.fields, row: v.row, preview: v.preview, reason: v.reason ?? "", who: "engineer" }),
    onSuccess: (res, v) => {
      if (!v.preview && res.stored) refresh(undefined, true);
    },
  });
}

// --- small shared helpers ----------------------------------------------------------------------------------------------

/** "P30-DCM-32001-04/015/5/1" → "015/5/1" */
export const shortSlot = (id?: string | null) => (id ? id.split("/").slice(1).join("/") : "—");
export const cabShort = (c?: string | null) => (c ? c.replace(/^.*-DCM-/, "DCM-") : "—");

/** The IO colour of a signal — the same family the cabinet, charts and legend use (§10.1). */
export function ioColourOf(r: SignalRow): string {
  const hw = r.hardware;
  return IO_COLOURS[ioKey({ status: r.tag_status === "Cabinet Alarm" ? "Cabinet Alarm" : "Field", io_type: r.io_type, charm_desc: hw?.charm_desc, tb_desc: hw?.tb_desc })];
}

/**
 * GET /signals describes the committed allocation; the sandbox lives beside it. Overlay the working state (the slots the
 * sandbox changed) so the table, the detail card and the picker agree with what /placement/check evaluates.
 */
export function overlaySignal(r: SignalRow, now: Map<number, Slot> | null, moves: Map<string, PlacementChangeSet["moves"] extends (infer M)[] | undefined ? M : never> | null): SignalRow {
  const s = now?.get(r.row);
  if (!s || !r.location || s.id === r.location.slot_id) return r;
  const mv = moves?.get(tagKey(r.tag));
  return {
    ...r,
    location: {
      cabinet: s.cabinet, cabinet_seq: s.cabinet_seq, controller: s.controller, cioc: s.cioc, cioc_seq: s.cioc_seq, cioc_local: s.cioc_local, side: s.side,
      baseplate: s.baseplate, bp: s.bp, ch: s.ch, charm_no: s.charm_no, slot_id: s.id,
    },
    hardware: { charm: s.charm, charm_desc: s.charm_desc, tb: s.tb, tb_desc: s.tb_desc, tb1: s.tb1, tb2: s.tb2, tb3: s.tb3 },
    reason: `Sandbox draft: moved from ${shortSlot(r.location.slot_id)} to ${shortSlot(s.id)}${mv?.reason ? ` — ${mv.reason}` : ""}. ${r.reason}`,
  };
}
