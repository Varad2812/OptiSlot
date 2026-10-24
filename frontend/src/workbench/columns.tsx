import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { cabShort, ioColourOf, type SignalRow, type SignalState, type SortKey } from "./api";

export interface Col {
  id: string;
  label: string;
  width: number;
  sort?: SortKey;
  mono?: boolean;
  /** Plain text (also the cell tooltip and the column-picker sample). */
  text: (r: SignalRow) => string;
  render?: (r: SignalRow) => ReactNode;
  on: boolean;
}

const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export const STATE_STYLE: Record<SignalState, string> = {
  allocated: "border-ok/40 bg-ok/10 text-ok",
  warning: "border-warn/40 bg-warn/10 text-warn",
  unallocated: "border-err/45 bg-err/10 text-err",
  quarantined: "border-dashed border-err/55 bg-err/5 text-err",
  deleted: "border-border bg-raised text-muted-foreground line-through",
};

export function StateChip({ state, className }: { state: SignalState; className?: string }) {
  return <span className={cn("inline-flex h-[18px] items-center rounded-full border px-2 text-[10.5px] font-medium leading-none", STATE_STYLE[state], className)}>{state}</span>;
}

export function IoChip({ r }: { r: SignalRow }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px]">
      <span className="size-2 shrink-0 rounded-[3px]" style={{ background: r.io_type === "-" ? "#2A3242" : ioColourOf(r) }} />
      {dash(r.io_type)}
    </span>
  );
}

const cablePair = (r: SignalRow) => (r.cable && r.cable !== "-" ? `${r.cable}${r.pair != null ? ` · p${r.pair}` : ""}` : "—");

/** Every field the Workbench can show; `on` = the default set (the reference layout). Order = table order. */
export const COLUMNS: Col[] = [
  { id: "tag", label: "Tag", width: 210, sort: "tag", mono: true, on: true, text: (r) => r.tag },
  { id: "io", label: "IO", width: 62, sort: "io_type", on: true, text: (r) => dash(r.io_type), render: (r) => <IoChip r={r} /> },
  { id: "cable", label: "Cable / Pair", width: 150, sort: "cable", mono: true, on: true, text: cablePair },
  { id: "cabinet", label: "Cabinet", width: 124, sort: "cabinet", mono: true, on: true, text: (r) => cabShort(r.location?.cabinet) },
  { id: "cioc", label: "CIOC", width: 66, sort: "cioc", mono: true, on: true, text: (r) => (r.location ? String(r.location.cioc_seq).padStart(3, "0") : "—") },
  { id: "bp", label: "Baseplate", width: 124, sort: "slot", mono: true, on: true, text: (r) => (r.location ? `${r.location.baseplate} · ${r.location.ch}` : "—") },
  { id: "charm", label: "CHARM", width: 86, mono: true, on: true, text: (r) => dash(r.hardware?.charm) },
  { id: "hw", label: "Hardware", width: 224, on: true, text: (r) => (r.hardware ? `${r.hardware.charm_desc} · ${r.hardware.tb}` : "—") },
  { id: "state", label: "Status", width: 100, sort: "state", on: true, text: (r) => r.state, render: (r) => <StateChip state={r.state} /> },
  { id: "reason", label: "Reason", width: 520, on: true, text: (r) => (r.state === "quarantined" && r.quarantine_reason ? `Quarantined — ${r.quarantine_reason}` : r.reason) },
  // --- the full detail fields (column picker) ---
  { id: "row", label: "MDB row", width: 74, sort: "row", mono: true, on: false, text: (r) => String(r.row) },
  { id: "tag_status", label: "Tag status", width: 106, on: false, text: (r) => dash(r.tag_status) },
  { id: "io_raw", label: "IO (raw)", width: 74, mono: true, on: false, text: (r) => dash(r.io_type_raw) },
  { id: "instrument", label: "Instrument", width: 96, mono: true, on: false, text: (r) => dash(r.instrument_type) },
  { id: "size", label: "Cable size", width: 86, mono: true, on: false, text: (r) => dash(r.cable_size) },
  { id: "family", label: "Family", width: 66, mono: true, on: false, text: (r) => dash(r.family) },
  { id: "group", label: "IO group", width: 100, mono: true, on: false, text: (r) => dash(r.group) },
  { id: "controller", label: "Controller", width: 124, mono: true, on: false, text: (r) => dash(r.location?.controller) },
  { id: "cioc_name", label: "CIOC name", width: 142, mono: true, on: false, text: (r) => dash(r.location?.cioc) },
  { id: "side", label: "Side", width: 54, mono: true, on: false, text: (r) => dash(r.location?.side) },
  { id: "ch", label: "Ch", width: 46, mono: true, on: false, text: (r) => dash(r.location?.ch) },
  { id: "charm_no", label: "CHARM no.", width: 86, mono: true, on: false, text: (r) => dash(r.location?.charm_no) },
  { id: "tb", label: "TB", width: 82, mono: true, on: false, text: (r) => dash(r.hardware?.tb) },
  { id: "tb_terms", label: "TB terminals", width: 100, mono: true, on: false, text: (r) => (r.hardware ? [r.hardware.tb1, r.hardware.tb2, r.hardware.tb3].filter((t) => t && t !== "-").join(" / ") || "—" : "—") },
  { id: "slot", label: "Slot id", width: 210, mono: true, on: false, text: (r) => dash(r.location?.slot_id) },
  { id: "tqs", label: "TQs", width: 120, mono: true, on: false, text: (r) => ((r.tq_ids ?? []).join(", ") || "—") },
  { id: "rules", label: "Rules", width: 180, mono: true, on: false, text: (r) => ((r.rule_ids ?? []).join(", ") || "—") },
  { id: "block", label: "Cable block", width: 120, mono: true, on: false, text: (r) => dash(r.block_id) },
];

const KEY = "optislot-wb-cols";

export function loadCols(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : null;
    if (ids?.length) return COLUMNS.filter((c) => ids.includes(c.id) || c.id === "tag").map((c) => c.id);
  } catch {
    /* storage can be blocked; the defaults apply */
  }
  return COLUMNS.filter((c) => c.on).map((c) => c.id);
}

export function saveCols(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* the choice still applies for this session */
  }
}
