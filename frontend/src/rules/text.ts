import type { Params, RuleTypeInfo } from "./api";

const WORD: Record<string, string> = { io: "IO", cioc: "CIOC", bp: "BP", id: "ID" };
export const humanise = (s: string) =>
  s.split("_").map((w, i) => WORD[w] ?? (w.length === 1 ? w.toUpperCase() : i === 0 ? w.replace(/^./, (c) => c.toUpperCase()) : w)).join(" ");
export const labelOf = (name: string) => LABELS[name] ?? humanise(name);

/** How a built-in rule's parameter is edited. Only plain numbers and flags are edited inline; tables stay in the rule set. */
export interface ParamMeta {
  name: string;
  label: string;
  unit: string;
  editor: "number" | "bool" | "text" | "readonly";
  min?: number;
  max?: number;
  step?: number;
  display: string;
}

const UNITS: Record<string, string> = { pct: "%", extra_pct: "%", whole_baseplate_min_pairs: "pairs", max: "signals", extra_count: "spares", cioc: "no.", baseplate: "no." };
const LABELS: Record<string, string> = { pct: "Target", whole_baseplate_min_pairs: "Whole baseplate from", max: "At most", extra_pct: "Extra", extra_count: "Extra count", cioc: "CIOC", baseplate: "Baseplate" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function summariseValue(v: unknown): string {
  if (Array.isArray(v)) return v.length <= 4 && v.every((x) => typeof x !== "object") ? v.join(", ") : `${v.length} entries`;
  if (isObj(v)) return `${Object.keys(v).length} entries`;
  return String(v);
}

export function paramMetas(params: Params): ParamMeta[] {
  return Object.entries(params).map(([name, v]) => {
    const unit = UNITS[name] ?? "";
    const label = labelOf(name);
    const display = summariseValue(v);
    if (typeof v === "number") {
      const pct = unit === "%";
      return { name, label, unit, editor: "number", min: 0, max: pct ? 100 : undefined, step: pct || Number.isInteger(v) ? 1 : 0.5, display };
    }
    if (typeof v === "boolean") return { name, label, unit, editor: "bool", display };
    return { name, label, unit, editor: "readonly", display };
  });
}

// ───── filters & sentences ─────────────────────────────────────────────────────────────────────────────────────────────

export type Filter = Record<string, unknown>;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
const quoteIfSpaced = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

/** A filter in words: `tag 320-FT* and io_type DOR or DIR, except instrument_type XYV`. */
export function filterText(f: unknown): string {
  if (!isObj(f)) return "all signals";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (k === "not" || k === "any") continue;
    const vals = list(v).map(quoteIfSpaced);
    if (vals.length) parts.push(`${k} ${vals.join(" or ")}`);
  }
  let s = parts.join(" and ");
  if (Array.isArray(f.any) && f.any.length) s += `${s ? " and " : ""}(${f.any.map((x) => filterText(x)).join(" or ")})`;
  if (isObj(f.not) && Object.keys(f.not).length) s += `${s ? ", " : ""}except ${filterText(f.not)}`;
  return s || "all signals";
}

const cabText = (v: unknown) => {
  const c = list(v);
  return c.length ? c.join(", ") : "…";
};
const plural = (n: unknown, one: string) => `${n ?? "…"} ${one}${Number(n) === 1 ? "" : "s"}`;

/** Live plain-English reading of a custom rule while it is built. Mirrors the backend's own wording. */
export function sentence(type: string, p: Params, info?: RuleTypeInfo): string {
  const scope = p.scope === "cioc" ? "CIOC" : String(p.scope ?? "…");
  switch (type) {
    case "max_per_scope":
      return `At most ${plural(p.max, "signal")} matching [${filterText(p.filter)}] in any one ${scope}.`;
    case "scope_relation": {
      const rel = p.relation === "same" ? "must share the same" : "must never share a";
      const per = p.group_by ? `, separately for each ${p.group_by}` : "";
      return `Signals matching [${filterText(p.filter_a)}] and signals matching [${filterText(p.filter_b)}] ${rel} ${scope}${per}.`;
    }
    case "forbid_mix":
      return `${cabText(p.io_type_a)} and ${cabText(p.io_type_b)} signals never meet on one ${scope}.`;
    case "zone_cabinets":
      return `Signals matching [${filterText(p.filter)}] may only sit in cabinet ${cabText(p.cabinets)}.`;
    case "extra_spares": {
      const bits = [Number(p.extra_pct) > 0 ? `${p.extra_pct}%` : "", Number(p.extra_count) > 0 ? `${p.extra_count}` : ""].filter(Boolean);
      return `Keep ${bits.length ? bits.join(" + ") : "…"} extra wired spares for ${p.io_type || "…"} per controller, on top of the global percentage.`;
    }
    default:
      return info?.description ?? humanise(type);
  }
}

/** Is a custom rule's parameter set complete enough to preview? */
export function missingParams(info: RuleTypeInfo, p: Params): string[] {
  const out: string[] = [];
  for (const s of info.params ?? []) {
    if (!s.required) continue;
    const v = p[s.name];
    const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) out.push(s.name);
  }
  if (info.type === "extra_spares" && !(Number(p.extra_pct) > 0 || Number(p.extra_count) > 0)) out.push("extra_pct");
  return out;
}

/** Parse "1, 4, P30-DCM-*" → numbers stay numbers, the rest are name globs (zone_cabinets). */
export const parseCabinets = (t: string): (number | string)[] =>
  t.split(/[,\s]+/).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));

export const fmtTs = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(+d) ? ts : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
