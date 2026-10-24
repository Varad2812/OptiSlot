import { FlaskConical, MousePointerClick, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject, useProjectId, type Slot } from "@/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChangesStrip, ImpactBar } from "@/workbench/ChangesStrip";
import { loadCols, saveCols } from "@/workbench/columns";
import { DetailCard } from "@/workbench/Detail";
import { FilterBar } from "@/workbench/FilterBar";
import { FixPanel } from "@/workbench/Fixes";
import { MovePicker, targetFromSlot, type Target } from "@/workbench/MovePicker";
import { SignalTable } from "@/workbench/SignalTable";
import {
  findSignal, NO_SIGNAL_FILTERS, overlaySignal, PAGE, sameSignal, tagKey, usePlacementState, useSignal, useSignals,
  type SignalFilters, type SortKey,
} from "@/workbench/api";

/**
 * Signal Workbench (CLAUDE.md §10.5.3 / §10.8): every signal in a dense table on the left; the selected signal's detail,
 * its plain-English reason and the Move-to picker on the right. All numbers and verdicts come from the API
 * (docs/api_workbench.md) — the engine re-runs with the move pinned and the independent verifier decides.
 */
export default function Workbench() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  if (!a) {
    return (
      <div className="grid h-full grid-cols-[1fr_460px] gap-3 p-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return <WorkbenchInner a={a} p={p} />;
}

type Alloc = NonNullable<ReturnType<typeof useAllocation>["data"]>;

function WorkbenchInner({ a, p }: { a: Alloc; p: ReturnType<typeof useProject>["data"] }) {
  const pid = useProjectId();
  const [params, setParams] = useSearchParams();
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => worldModel(a, dims), [a, dims]);

  // ?cabinet= / ?slot= (Try changes from a 3D cabinet / CIOC / empty slot): start with that cabinet's signals and a picker aimed at it
  const initial = useMemo(() => {
    const slot = params.get("slot");
    const s = slot ? model.bySlotId.get(slot) : undefined;
    const cab = s?.cabinet ?? params.get("cabinet") ?? "";
    const hint: Partial<Target> | null = s ? targetFromSlot(s) : cab ? { cabinet: cab, cioc: Number(params.get("cioc")) || undefined, bp: Number(params.get("bp")) || undefined } : null;
    return { cab: a.cabinets.some((c) => c.name === cab) ? cab : "", hint };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [filters, setFilters] = useState<SignalFilters>({ ...NO_SIGNAL_FILTERS, cabinet: params.get("tag") ? "" : initial.cab });
  const [hint, setHint] = useState<Partial<Target> | null>(initial.hint);
  const [colIds, setColIds] = useState<string[]>(loadCols);
  const [sel, setSel] = useState<{ tag: string; row: number } | null>(null);
  const [reveal, setReveal] = useState(0);

  const list = useSignals(filters);
  const state = usePlacementState();
  // the sandbox's working slots, by MDB row (GET /signals describes the committed allocation)
  const nowByRow = useMemo(() => {
    const m = new Map<number, Slot>();
    for (const s of state.data?.changes?.slots_now ?? []) if (s.source_row != null && (s.status === "Field" || s.status === "Cabinet Alarm")) m.set(s.source_row, s); // wired spares reuse their cable's row
    return m.size ? m : null;
  }, [state.data?.changes?.slots_now]);
  const movesByTag = useMemo(() => new Map((state.data?.changes?.moves ?? []).map((m) => [tagKey(m.tag), m])), [state.data?.changes?.moves]);
  const rows = useMemo(() => (nowByRow ? list.rows.map((r) => (r ? overlaySignal(r, nowByRow, movesByTag) : r)) : list.rows), [list.rows, nowByRow, movesByTag]);
  const listed = useMemo(() => (sel ? rows.find((r) => !!r && sameSignal(r, sel)) ?? null : null), [rows, sel]);
  const detail = useSignal(sel, listed);
  const sig = useMemo(() => (detail.data ? overlaySignal(detail.data, nowByRow, movesByTag) : listed), [detail.data, listed, nowByRow, movesByTag]);

  // --- selection ⇄ URL --------------------------------------------------------------------------------------------------
  const choose = useCallback(
    (r: { tag: string; row: number }, opts: { scroll?: boolean } = {}) => {
      setSel({ tag: r.tag, row: r.row });
      setParams({ tag: r.tag, row: String(r.row) }, { replace: true });
      if (opts.scroll) setReveal((n) => n + 1);
    },
    [setParams],
  );
  // a hint from the 3D room (?slot= / ?cabinet=) aims the picker for the first signal chosen, then steps aside
  const hintUsed = useRef(false);
  const pickRow = useCallback(
    (r: { tag: string; row: number }) => {
      if (hintUsed.current) setHint(null);
      hintUsed.current = true;
      choose(r);
    },
    [choose],
  );

  // ?tag= preselects (and scrolls to) the signal; a tag outside the first pages narrows the list to it
  const resolved = useRef("");
  const paramTag = params.get("tag");
  const paramRow = Number(params.get("row")) || 0;
  useEffect(() => {
    if (!paramTag) return;
    const want = `${tagKey(paramTag)}|${paramRow}`;
    if (resolved.current === want || (sel && tagKey(sel.tag) === tagKey(paramTag) && (!paramRow || sel.row === paramRow))) return;
    resolved.current = want;
    let live = true;
    (async () => {
      try {
        const r = paramRow ? { tag: paramTag, row: paramRow } : await findSignal(pid, paramTag);
        if (!live) return;
        if (!r) {
          toast.message("Signal not found", { description: `“${paramTag}” is not in this project's MDB.` });
          return;
        }
        setSel({ tag: r.tag, row: r.row });
        setReveal((n) => n + 1);
      } catch {
        if (live) toast.message("Could not look that signal up", { description: "The signals API did not answer." });
      }
    })();
    return () => {
      live = false;
    };
  }, [paramTag, paramRow, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // the preselected row is beyond what has paged in → narrow the list to it so it is reachable
  const narrowed = useRef(false);
  useEffect(() => {
    if (!sel || narrowed.current || list.isLoading || list.isFetching) return;
    if (list.total <= PAGE || list.loaded.some((r) => sameSignal(r, sel))) return;
    narrowed.current = true;
    setFilters((f) => ({ ...f, q: sel.tag.replace(/\s+/g, " ") }));
  }, [sel, list.loaded, list.total, list.isLoading, list.isFetching]);

  // a signal that stops existing (data patch renamed it, Rev change) is dropped instead of showing a dead card
  useEffect(() => {
    if (sel && detail.isError && !listed) {
      toast.message("That signal is gone", { description: "It no longer exists in the active revision." });
      setSel(null);
    }
  }, [detail.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state.data?.stale) toast.message("Sandbox was discarded", { description: "The committed allocation changed underneath it (rules, revision or data)." });
  }, [state.data?.stale]);

  // --- filters ----------------------------------------------------------------------------------------------------------
  const patchFilters = useCallback((patch: Partial<SignalFilters>) => setFilters((f) => ({ ...f, ...patch })), []);
  const active = !!(filters.q || filters.io.length || filters.status.length || filters.cabinet || filters.cable || filters.tq);
  const clear = useCallback(() => setFilters((f) => ({ ...NO_SIGNAL_FILTERS, sort: f.sort, order: f.order })), []);
  const sort = useCallback((k: SortKey) => setFilters((f) => (f.sort === k ? { ...f, order: f.order === "asc" ? "desc" : "asc" } : { ...f, sort: k, order: "asc" })), []);
  const setCols = useCallback((ids: string[]) => (setColIds(ids), saveCols(ids)), []);

  const overlay = useMemo(() => {
    const now = state.data?.changes?.slots_now;
    return now?.length ? new Map<string, Slot>(now.map((s) => [s.id, s])) : null;
  }, [state.data?.changes?.slots_now]);

  const pickTag = useCallback(
    async (tag: string) => {
      const inList = list.loaded.find((r) => tagKey(r.tag) === tagKey(tag));
      if (inList) return pickRow(inList);
      try {
        const r = await findSignal(pid, tag);
        if (r) {
          setHint(null);
          choose(r, { scroll: true });
        }
      } catch {
        toast.message("Could not look that signal up");
      }
    },
    [list.loaded, pid, pickRow, choose],
  );

  const err = list.isError ? (list.error?.message ?? "The signals API did not answer.") : null;
  const nMoves = state.data?.changes?.moves?.length ?? 0;
  const by = list.counts?.by_state ?? {};

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench">
      <div className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-surface/50 pl-5 pr-4">
        <h1 className="text-[14px] font-semibold">Signal Workbench</h1>
        <ImpactBar a={a} state={state.data} />
        <span className="ml-auto flex items-center gap-1.5 rounded-chip border border-warn/50 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn" data-testid="sandbox-banner" title="Every placement is explainable. Moves are drafts until you Commit.">
          <FlaskConical className="size-3.5" /> Sandbox{nMoves > 0 ? ` · ${nMoves} draft` : " · drafts only"}
        </span>
      </div>
      <ChangesStrip state={state.data} unavailable={state.isError} onPickTag={(t) => void pickTag(t)} />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_460px]">
        <div className="flex min-h-0 min-w-0 flex-col border-r border-border">
          <FilterBar
            f={filters} onChange={patchFilters} onClear={clear} counts={list.counts} cabinets={a.cabinets.map((c) => c.name)} tqs={a.tqs}
            colIds={colIds} onCols={setCols} active={active} fetching={list.isFetching}
          />
          <SignalTable
            rows={rows} loading={list.isLoading} error={err} onNeed={list.need} onRetry={list.refetch} onClear={active ? clear : null} filters={filters} onSort={sort}
            colIds={colIds} selected={sel} onSelect={pickRow} revealNonce={reveal}
          />
        </div>

        <aside className="min-h-0 overflow-y-auto bg-surface/30 p-4" data-testid="workbench-side" aria-label="Selected signal">
          {!sel && (
            <Empty
              unplaced={(by.unallocated ?? 0) + (by.quarantined ?? 0)}
              warnings={by.warning ?? 0}
              onFilter={(s) => patchFilters({ status: s })}
            />
          )}
          {sel && !sig && (detail.isLoading ? <SideSkeleton /> : null)}
          {sel && sig && (
            <div className="space-y-4">
              <DetailCard r={sig} stale={detail.isFetching && !detail.isPlaceholderData} />
              {(sig.state === "unallocated" || sig.state === "quarantined") && <FixPanel key={`${sig.row}-${sig.state}`} sig={sig} />}
              {sig.state === "deleted" ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">This tag is DELETED in the MDB, so it has no slot to move.</p>
              ) : sig.state === "quarantined" ? null : (
                <MovePicker
                  key={`${sig.row}-${tagKey(sig.tag)}`} sig={sig} a={a} model={model} overlay={overlay} hint={hint} channels={dims.channels}
                  onPickTag={(t) => void pickTag(t)} onApplied={() => setHint(null)}
                />
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function SideSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function Empty({ unplaced, warnings, onFilter }: { unplaced: number; warnings: number; onFilter: (s: string[]) => void }) {
  return (
    <div className="mx-auto mt-10 max-w-[360px] text-center" data-testid="workbench-empty">
      <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-raised text-brand">
        <MousePointerClick className="size-5" />
      </div>
      <div className="text-[14px] font-semibold">Select a signal</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        Click a row, or use <kbd className="rounded border border-border bg-raised px-1 font-mono text-[11px]">↑</kbd> <kbd className="rounded border border-border bg-raised px-1 font-mono text-[11px]">↓</kbd>. You will see why it sits where it does, and can try moving it —
        the rules and the independent verifier answer before anything changes.
      </p>
      <div className="mt-4 space-y-2 text-left">
        <Shortcut tone="err" n={unplaced} label="not placed — unallocated or quarantined" onClick={() => onFilter(["unallocated", "quarantined"])} />
        <Shortcut tone="warn" n={warnings} label="placed with an open TQ" onClick={() => onFilter(["warning"])} />
      </div>
    </div>
  );
}

function Shortcut({ tone, n, label, onClick }: { tone: "err" | "warn"; n: number; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={n === 0}
      className="flex w-full items-center gap-2.5 rounded-card border border-border px-3 py-2 text-[12.5px] transition-colors hover:border-brand/40 hover:bg-raised/60 disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent"
    >
      <TriangleAlert className={cn("size-4 shrink-0", tone === "err" ? "text-err" : "text-warn")} />
      <span className="tnum w-7 text-right text-[15px] font-semibold">{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </button>
  );
}

