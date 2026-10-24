import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, RotateCw, SearchX, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { sameSignal, type SignalFilters, type SignalRow, type SortKey } from "./api";
import { COLUMNS, type Col } from "./columns";

const ROW_H = 32;

interface Props {
  rows: SignalRow[];
  total: number;                  // matching rows on the server (rows.length is what has been paged in so far)
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  fetchingMore: boolean;
  onMore: () => void;
  onRetry: () => void;
  onClear: (() => void) | null;   // set when filters are active
  filters: SignalFilters;
  onSort: (k: SortKey) => void;
  colIds: string[];
  selected: { tag: string; row: number } | null;
  onSelect: (r: SignalRow) => void;
  /** Bumped to scroll the selected row into view (preselect from the URL). */
  revealNonce: number;
}

export function SignalTable({ rows, total, loading, error, hasMore, fetchingMore, onMore, onRetry, onClear, filters, onSort, colIds, selected, onSelect, revealNonce }: Props) {
  const cols = useMemo(() => COLUMNS.filter((c) => colIds.includes(c.id)), [colIds]);
  const width = useMemo(() => cols.reduce((n, c) => n + c.width, 0) + 24, [cols]);
  const grid = useMemo(() => cols.map((c) => `${c.width}px`).join(" "), [cols]);
  const scroller = useRef<HTMLDivElement>(null);
  const selIdx = useMemo(() => (selected ? rows.findIndex((r) => sameSignal(r, selected)) : -1), [rows, selected]);

  const count = rows.length + (hasMore ? 1 : 0);
  const virt = useVirtualizer({ count, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 14 });
  const items = virt.getVirtualItems();

  // page in the next 300 when the viewport gets near the end of what has loaded
  const last = items.length ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (hasMore && !fetchingMore && last >= rows.length - 40) onMore();
  }, [hasMore, fetchingMore, last, rows.length, onMore]);

  // ↑/↓ select; the table keeps the selection in view (ignored while typing or in a menu)
  const selRef = useRef({ rows, selIdx, onSelect });
  selRef.current = { rows, selIdx, onSelect };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.closest("[role=menu],[role=listbox],[role=dialog],[cmdk-root]"))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { rows: rs, selIdx: i, onSelect: pick } = selRef.current;
      if (!rs.length) return;
      e.preventDefault();
      const next = Math.min(rs.length - 1, Math.max(0, (i < 0 ? (e.key === "ArrowDown" ? -1 : rs.length) : i) + (e.key === "ArrowDown" ? 1 : -1)));
      pick(rs[next]);
      virt.scrollToIndex(next, { align: "auto" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [virt]);

  // preselect from ?tag= → scroll to it once the row is in the list
  const revealed = useRef(0);
  useEffect(() => {
    if (revealNonce === revealed.current || selIdx < 0) return;
    revealed.current = revealNonce;
    virt.scrollToIndex(selIdx, { align: "center" });
  }, [revealNonce, selIdx, virt]);

  const empty = !loading && !error && rows.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="signal-table">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="absolute inset-0 overflow-auto" role="grid" aria-rowcount={total} aria-label="Signals" tabIndex={0}>
          <div style={{ width, minWidth: "100%" }}>
            <div className="sticky top-0 z-20 grid h-8 items-center border-b border-border bg-surface text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground" style={{ gridTemplateColumns: grid }} role="row">
              {cols.map((c, i) => (
                <HeaderCell key={c.id} c={c} i={i} filters={filters} onSort={onSort} />
              ))}
            </div>
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {items.map((it) => {
                const r = rows[it.index];
                const top = { transform: `translateY(${it.start}px)`, height: ROW_H };
                if (!r) {
                  return (
                    <div key="more" className="absolute left-0 top-0 flex items-center gap-2 px-3 text-[12px] text-muted-foreground" style={{ ...top, width: "100%" }}>
                      <RotateCw className="size-3.5 animate-spin" /> Loading more signals…
                    </div>
                  );
                }
                const on = sameSignal(r, selected);
                return (
                  <div
                    key={`${r.row}-${r.tag_key}`}
                    role="row"
                    aria-selected={on}
                    onClick={() => onSelect(r)}
                    className={cn(
                      "group absolute left-0 top-0 grid cursor-pointer items-center border-b border-border/50 text-[12px] transition-colors",
                      on ? "bg-brand/15" : "hover:bg-raised/70",
                    )}
                    style={{ ...top, width: "100%", gridTemplateColumns: grid }}
                    data-testid="signal-row"
                    data-tag={r.tag}
                  >
                    {cols.map((c, i) => (
                      <Cell key={c.id} c={c} r={r} first={i === 0} on={on} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {loading && rows.length === 0 && (
          <div className="absolute inset-x-0 top-8 space-y-px p-0">
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-none opacity-70" />
            ))}
          </div>
        )}
        {error && (
          <Notice icon={<TriangleAlert className="size-5 text-warn" />} title="Could not load the signals" body={error}>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={onRetry}>
              <RotateCw className="size-3.5" /> Retry
            </Button>
          </Notice>
        )}
        {empty && (
          <Notice icon={<SearchX className="size-5 text-muted-foreground" />} title="No signal matches" body="Nothing in this project fits the current filters.">
            {onClear && (
              <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={onClear}>
                Clear filters
              </Button>
            )}
          </Notice>
        )}
      </div>
    </div>
  );
}

function HeaderCell({ c, i, filters, onSort }: { c: Col; i: number; filters: SignalFilters; onSort: (k: SortKey) => void }) {
  const active = c.sort && filters.sort === c.sort;
  const Icon = !c.sort ? null : !active ? ArrowUpDown : filters.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <div role="columnheader" aria-sort={active ? (filters.order === "asc" ? "ascending" : "descending") : undefined} className={cn("min-w-0 truncate px-2", i === 0 && "sticky left-0 z-10 bg-surface pl-3 shadow-[1px_0_0_rgb(var(--border))]")}>
      {c.sort ? (
        <button onClick={() => onSort(c.sort!)} className={cn("flex max-w-full items-center gap-1 uppercase tracking-[0.06em] hover:text-text", active && "text-text")}>
          <span className="truncate">{c.label}</span>
          {Icon && <Icon className={cn("size-3 shrink-0", !active && "opacity-40")} />}
        </button>
      ) : (
        c.label
      )}
    </div>
  );
}

function Cell({ c, r, first, on }: { c: Col; r: SignalRow; first: boolean; on: boolean }) {
  const text = c.text(r);
  return (
    <div
      role="gridcell"
      title={c.render ? undefined : text}
      className={cn(
        "min-w-0 truncate px-2",
        c.mono && "font-mono text-[11.5px]",
        c.id === "reason" && "text-muted-foreground",
        c.id === "tag" && "font-medium",
        first && "sticky left-0 z-10 pl-3 shadow-[1px_0_0_rgb(var(--border))]",
        first && (on ? "bg-[color-mix(in_srgb,rgb(var(--brand))_15%,rgb(var(--surface)))]" : "bg-surface group-hover:bg-raised"),
        r.state === "deleted" && c.id !== "state" && "opacity-50",
      )}
    >
      {c.render ? c.render(r) : text}
    </div>
  );
}

function Notice({ icon, title, body, children }: { icon: React.ReactNode; title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 top-24 mx-auto w-[340px] rounded-card border border-dashed border-border bg-surface/90 px-5 py-5 text-center">
      <div className="mx-auto mb-2 grid size-9 place-items-center rounded-full bg-raised">{icon}</div>
      <div className="text-[13px] font-medium">{title}</div>
      <p className="mb-3 mt-1 text-[12px] leading-relaxed text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}

export function ColumnPicker({ colIds, onCols }: { colIds: string[]; onCols: (ids: string[]) => void }) {
  const toggle = (id: string, on: boolean) => onCols(COLUMNS.filter((c) => (c.id === id ? on : colIds.includes(c.id))).map((c) => c.id));
  const base = COLUMNS.filter((c) => c.on);
  const extra = COLUMNS.filter((c) => !c.on);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" data-testid="column-picker">
          <Columns3 className="size-3.5" /> Columns <span className="tnum text-muted-foreground">{colIds.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[420px] w-56 overflow-y-auto">
        <DropdownMenuLabel className="label-caps">Table</DropdownMenuLabel>
        {base.map((c) => (
          <DropdownMenuCheckboxItem key={c.id} checked={colIds.includes(c.id)} disabled={c.id === "tag"} onSelect={(e) => e.preventDefault()} onCheckedChange={(v) => toggle(c.id, !!v)} className="text-[12px]">
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="label-caps">Detail fields</DropdownMenuLabel>
        {extra.map((c) => (
          <DropdownMenuCheckboxItem key={c.id} checked={colIds.includes(c.id)} onSelect={(e) => e.preventDefault()} onCheckedChange={(v) => toggle(c.id, !!v)} className="text-[12px]">
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
