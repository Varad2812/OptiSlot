import { useVirtualizer } from "@tanstack/react-virtual";
import { Boxes, Search } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { dimsOf } from "@/api/derive";
import { useAllocation, useProject, useRows, type GridRow, type Slot } from "@/api/hooks";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ALLOCATE_LANDING_ROUTE, flyToSlot } from "@/world/actions";

const ROW_H = 26;
const HEAD_H = 26;
const GROUP_H = 24;
const ACT_W = 34; // leading frozen action column: "Show in 3D"
const FROZEN = ["Sr. No.", "Revision No", "Tag Name"]; // the template's freeze pane is D2

// Column groups start at these headers (the template's layout); any unknown header joins the group before it.
const GROUPS: [string, string][] = [
  ["Sr. No.", "Signal"], ["Location", "Signal spec"], ["System Cabinet", "Address"], ["CHARM Type", "CHARM"], ["M_FTA", "Marshalling"],
  ["IRC / AUX Cabinet", "IRC & relay"], ["Field Cable No", "Field cable"], ["Elec Cable No", "Electrical cable"], ["Tag Status", "Status & revision"],
];
const GROUP_TONE = ["text-brand", "text-io-ai", "text-live", "text-io-do", "text-io-ao", "text-io-alarm", "text-ok", "text-io-di", "text-muted-foreground"];

const WIDTHS: Record<string, number> = {
  "Sr. No.": 54, "Revision No": 64, "Tag Name": 176, "Service Description": 220, "Charm Description": 220, "CHARM TB Description": 200, "Remarks": 200,
  "System Cabinet": 140, "Controller": 120, "Electronic/ Marshalling Cabinet": 160, "CIOC/CSLS Name": 150, "Equipment Name": 150, "Cabinet Name for Visualization": 190,
  "Field Cable No": 130, "Elec Cable No": 130, "DSTName": 150, "Old Tag": 150, "Tag Status": 100, "Signal Type": 110,
};
const widthOf = (h: string) => WIDTHS[h] ?? Math.max(64, Math.min(150, h.replace(/\s+/g, " ").length * 7 + 28));
const clean = (h: string) => h.replace(/\s+/g, " ").trim();

function changeTone(r: GridRow): { stripe: string; tint: string } | null {
  const c = (r["Change Type"] ?? "-").toLowerCase();
  if (!c || c === "-") return null;
  if (c.startsWith("new") || c.startsWith("add")) return { stripe: "bg-ok", tint: "bg-ok/[0.08]" };
  if (c.startsWith("del")) return { stripe: "bg-err", tint: "bg-err/[0.08]" };
  if (c.startsWith("mov")) return { stripe: "bg-live", tint: "bg-live/[0.08]" };
  return { stripe: "bg-warn", tint: "bg-warn/[0.08]" };
}

const STATUS_TONE: Record<string, string> = { "Field": "text-text", "Wired Spare": "text-ok", "Cabinet Alarm": "text-io-alarm", "Spare Slot": "text-muted-foreground/60" };

/** Slot id of a grid row, from its address columns — the same id the World and Inspector use. */
function slotId(r: GridRow) {
  const cioc = r["CIOC/CSLS Name"] ?? "";
  const bp = (r["Baseplate"] ?? "").split("-").pop();
  return `${r["Electronic/ Marshalling Cabinet"]}/${cioc.slice(-3)}/${bp}/${r["Channel_No"]}`;
}

/** Allocation Grid (§10.5.9) — the 76-column IO Assignment, exactly as exported. */
export default function Grid() {
  const { data: rows } = useRows();
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [hideSpare, setHideSpare] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const dq = useDeferredValue(q);
  const scroller = useRef<HTMLDivElement>(null);

  const cols = useMemo(() => (rows?.[0] ? Object.keys(rows[0]) : []), [rows]);
  const layout = useMemo(() => {
    const frozen = FROZEN.filter((c) => cols.includes(c));
    const order = [...frozen, ...cols.filter((c) => !frozen.includes(c))];
    const left: Record<string, number> = {};
    let x = ACT_W;
    for (const c of frozen) (left[c] = x, (x += widthOf(c)));
    // group spans over the *ordered* columns (frozen ones come from the first group anyway)
    const starts = new Map(GROUPS.map(([h, g], i) => [h, { g, i }]));
    const spans: { name: string; tone: string; w: number }[] = [];
    let cur = GROUPS[0][1], curTone = GROUP_TONE[0];
    for (const c of cols) {
      const hit = starts.get(c);
      if (hit && hit.g !== cur) (cur = hit.g, (curTone = GROUP_TONE[hit.i]));
      const w = widthOf(c);
      if (spans.length && spans[spans.length - 1].name === cur) spans[spans.length - 1].w += w;
      else spans.push({ name: cur, tone: curTone, w });
    }
    return { order, left, frozenW: x, total: ACT_W + order.reduce((s, c) => s + widthOf(c), 0), spans };
  }, [cols]);

  const index = useMemo(() => (rows ?? []).map((r) => Object.values(r).join("\u0001").toLowerCase()), [rows]);
  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = dq.trim().toLowerCase();
    const out: GridRow[] = [];
    rows.forEach((r, i) => {
      if (hideSpare && r["Tag Status"] === "Spare Slot") return;
      if (changedOnly && !changeTone(r)) return;
      if (needle && !index[i].includes(needle)) return;
      out.push(r);
    });
    return out;
  }, [rows, index, dq, hideSpare, changedOnly]);

  const slotsById = useMemo(() => new Map<string, Slot>((a?.slots ?? []).map((s) => [s.id, s])), [a]);
  const v = useVirtualizer({ count: filtered.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 14 });
  const changed = useMemo(() => (rows ?? []).filter((r) => changeTone(r)).length, [rows]);

  function open(r: GridRow) {
    const s = slotsById.get(slotId(r));
    if (!s || !a) return;
    flyToSlot(a, s, dimsOf(a, p).ciocsPerSide);
    nav(ALLOCATE_LANDING_ROUTE);
  }

  return (
    <div className="flex h-full flex-col p-6" data-testid="grid-page">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-page">Allocation Grid</h1>
          <p className="mt-1 text-muted-foreground">The {cols.length || 76}-column IO Assignment, exactly as exported. Click a row to fly to its slot.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter any column…" className="h-8 w-64 pl-8 text-[12.5px] md:text-[12.5px]" data-testid="grid-filter" />
          </div>
          <Toggle on={hideSpare} onClick={() => setHideSpare(!hideSpare)}>Hide spare slots</Toggle>
          <Toggle on={changedOnly} onClick={() => setChangedOnly(!changedOnly)} disabled={!changed}>Changed only{changed ? ` · ${changed}` : ""}</Toggle>
          <span className="rounded-chip border border-border bg-raised px-2 py-1 text-[11.5px] text-muted-foreground tnum" data-testid="grid-count">{filtered.length} / {rows?.length ?? 0} rows</span>
        </div>
      </header>

      {!rows ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : (
        <div className="card-surface relative min-h-0 flex-1 overflow-hidden">
          <div ref={scroller} className="absolute inset-0 overflow-auto font-mono text-[11.5px]" data-testid="grid-scroller">
            <div style={{ width: layout.total, minWidth: "100%" }}>
              {/* header: group band + column names, sticky; the first three columns are frozen like the template's D2 */}
              <div className="sticky top-0 z-30 bg-raised">
                <div className="flex border-b border-border" style={{ height: GROUP_H }}>
                  {/* the frozen block keeps its band while the rest scrolls underneath */}
                  <div className="sticky left-0 z-20 shrink-0 border-r border-border bg-raised" style={{ width: layout.frozenW, marginRight: -layout.frozenW }}>
                    <span className="block truncate px-2 py-1 font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em] text-brand">Signal · frozen</span>
                  </div>
                  {layout.spans.map((s) => (
                    <div key={s.name} className={cn("shrink-0 truncate border-r border-border px-2 py-1 font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em]", s.tone)} style={{ width: s.w }}>{s.name}</div>
                  ))}
                </div>
                <div className="flex border-b border-border" style={{ height: HEAD_H }}>
                  <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-raised" style={{ width: ACT_W }} aria-hidden />
                  {layout.order.map((c) => (
                    <div
                      key={c}
                      title={clean(c)}
                      className={cn("shrink-0 truncate border-r border-border px-2 py-1 font-sans text-[11px] font-medium text-muted-foreground", c in layout.left && "sticky z-10 bg-raised")}
                      style={{ width: widthOf(c), left: layout.left[c] }}
                    >
                      {clean(c)}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ height: v.getTotalSize(), position: "relative" }}>
                {v.getVirtualItems().map((vi) => {
                  const r = filtered[vi.index];
                  const tone = changeTone(r);
                  const spare = r["Tag Status"] === "Spare Slot";
                  return (
                    <div
                      key={vi.index}
                      role="row"
                      onClick={() => open(r)}
                      className={cn("group/row absolute left-0 flex cursor-pointer border-b border-border/60 hover:bg-brand/10", tone?.tint, spare && "opacity-60")}
                      style={{ top: 0, height: ROW_H, transform: `translateY(${vi.start}px)`, width: "100%" }}
                    >
                      <div className="sticky left-0 z-10 shrink-0 bg-surface" style={{ width: ACT_W }}>
                        <button
                          type="button"
                          title="Show in 3D"
                          aria-label={`Show ${r["Tag Name"]} in 3D`}
                          onClick={(e) => (e.stopPropagation(), open(r))}
                          className="grid h-full w-full place-items-center text-muted-foreground hover:text-brand"
                        >
                          <Boxes className="size-3.5" />
                        </button>
                      </div>
                      {layout.order.map((c) => {
                        const val = r[c] ?? "";
                        return (
                          <div
                            key={c}
                            className={cn(
                              "shrink-0 truncate border-r border-border/40 px-2 leading-[25px]",
                              c in layout.left && "sticky z-10 bg-surface group-hover/row:bg-[color-mix(in_srgb,rgb(var(--brand))_10%,rgb(var(--surface)))]",
                              c === "Tag Name" && "font-medium",
                              c === "Tag Status" && STATUS_TONE[val],
                              val === "-" && "text-muted-foreground/50",
                            )}
                            style={{ width: widthOf(c), left: layout.left[c] }}
                            title={val}
                          >
                            {c === "Sr. No." && tone && <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.stripe)} />}
                            {val}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              {!filtered.length && (
                <div className="flex items-center gap-2 p-6 font-sans text-muted-foreground"><Boxes className="size-4" />No rows match “{q}”.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn("rounded-chip border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40", on ? "border-brand/60 bg-brand/15 text-text" : "border-border bg-raised text-muted-foreground hover:text-text")}
    >
      {children}
    </button>
  );
}
