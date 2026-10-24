import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { TQ } from "@/api/hooks";
import { cn } from "@/lib/utils";

import { STATES, type SignalFilters, type SignalList } from "./api";
import { ColumnPicker } from "./SignalTable";
import { STATE_STYLE } from "./columns";

type Counts = SignalList["counts"];

const field = "h-8 rounded-md border border-input bg-transparent px-2.5 text-[12px] text-text outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring";

interface Props {
  f: SignalFilters;
  onChange: (p: Partial<SignalFilters>) => void;
  onClear: () => void;
  counts: Counts | null;
  cabinets: string[];
  tqs: TQ[];
  colIds: string[];
  onCols: (ids: string[]) => void;
  active: boolean;
  fetching: boolean;
}

/** Text · IO type · status · cabinet · cable · TQ, with live counts. Text inputs wait 250 ms before they hit the API. */
export function FilterBar({ f, onChange, onClear, counts, cabinets, tqs, colIds, onCols, active, fetching }: Props) {
  const [q, setQ] = useState(f.q);
  const [cable, setCable] = useState(f.cable);
  useEffect(() => setQ(f.q), [f.q]);
  useEffect(() => setCable(f.cable), [f.cable]);
  useEffect(() => {
    if (q === f.q) return;
    const t = window.setTimeout(() => onChange({ q }), 250);
    return () => window.clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (cable === f.cable) return;
    const t = window.setTimeout(() => onChange({ cable }), 250);
    return () => window.clearTimeout(t);
  }, [cable]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: "io" | "status", v: string) => onChange({ [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] });
  const ioTypes = Object.keys(counts?.by_io_type ?? {}).filter((k) => k && k !== "-").sort();
  const linked = tqs.filter((t) => (t.rows?.length ?? 0) + (t.tags?.length ?? 0) > 0);

  return (
    <div className="space-y-2 border-b border-border bg-surface/40 px-3 py-2.5" data-testid="filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tag, cable, instrument, slot…" className={cn(field, "w-[200px] pl-8")} aria-label="Search signals" data-testid="wb-search" />
        </label>
        <input value={cable} onChange={(e) => setCable(e.target.value)} placeholder="Cable" className={cn(field, "w-[96px] font-mono")} aria-label="Cable" />
        <select value={f.cabinet} onChange={(e) => onChange({ cabinet: e.target.value })} className={cn(field, "w-[150px] bg-surface")} aria-label="Cabinet">
          <option value="">All cabinets</option>
          {cabinets.map((c) => (
            <option key={c} value={c}>
              {c}
              {counts?.by_cabinet[c] != null ? ` (${counts.by_cabinet[c]})` : ""}
            </option>
          ))}
        </select>
        <select value={f.tq} onChange={(e) => onChange({ tq: e.target.value })} className={cn(field, "w-[120px] bg-surface")} aria-label="TQ">
          <option value="">Any TQ</option>
          {linked.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} · {t.status}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <span className={cn("tnum font-mono text-[11.5px] text-muted-foreground transition-opacity", fetching && "opacity-50")} data-testid="wb-count">
            {counts ? (
              <>
                <b className="text-text">{counts.matching.toLocaleString()}</b> of {counts.total.toLocaleString()} signals
              </>
            ) : (
              "…"
            )}
          </span>
          {active && (
            <button onClick={onClear} className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-raised hover:text-text">
              <X className="size-3.5" /> Clear
            </button>
          )}
          <ColumnPicker colIds={colIds} onCols={onCols} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {ioTypes.map((t) => (
          <Chip key={t} on={f.io.includes(t)} onClick={() => toggle("io", t)} count={counts?.by_io_type[t]} mono>
            {t}
          </Chip>
        ))}
        {ioTypes.length > 0 && <span className="mx-1 h-4 w-px bg-border" />}
        {STATES.map((s) => (
          <Chip key={s} on={f.status.includes(s)} onClick={() => toggle("status", s)} count={counts?.by_state[s] ?? 0} tone={STATE_STYLE[s]} dim={!(counts?.by_state[s])}>
            {s}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({ on, onClick, count, children, mono, tone, dim }: { on: boolean; onClick: () => void; count?: number; children: React.ReactNode; mono?: boolean; tone?: string; dim?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors",
        mono && "font-mono",
        on ? (tone ?? "border-brand/60 bg-brand/15 text-text") : "border-border text-muted-foreground hover:border-brand/40 hover:text-text",
        on && "ring-1 ring-current/30",
        dim && !on && "opacity-50",
      )}
    >
      {children}
      {count != null && <span className="tnum text-[10.5px] opacity-70">{count}</span>}
    </button>
  );
}
