import { motion } from "framer-motion";
import { FlaskConical } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject, useRules } from "@/api/hooks";
import { useRevisionImpact } from "@/api/sandbox";
import { Bar, Panel } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IO_COLOURS, IO_LABELS, IO_ORDER, ioKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { useSequence } from "@/motion/sequence";
import { EASE, useCalm } from "@/motion/shared";
import { StabilityGauge, toneOf } from "@/revisions/parts";
import { useUi } from "@/store/ui";
import { enterCabinet } from "@/world/actions";
import type { DiffKind } from "@/world/DiffOverlay";

const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div className="space-y-2">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
);

// Tall tiles scroll inside themselves (a 10k project has ~46 cabinets); `data-stop` keeps a click on the content from also opening the tile's link.
const SCROLL = "max-h-[262px] overflow-y-auto";

// ───────────── spares per cabinet ─────────────

/** The PS asks for this explicitly: free slots, wired spares, spare slots and empty baseplates — per cabinet. Row → that cabinet in the Explorer. */
export function SparesTile({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const nav = useNavigate();
  const rows = a?.kpis.spares_per_cabinet ?? [];
  const idx = useMemo(() => new Map((a?.cabinets ?? []).map((c, i) => [c.name, i])), [a]);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((x, r) => x + f(r), 0);
  return (
    <Panel title="Spares per cabinet" delay={delay} to="/explorer" aside={a && <span className="text-[11px] text-muted-foreground tnum">{rows.length} cabinets</span>}>
      {!a ? <Loading /> : (
        <div className={SCROLL} data-stop>
          <table className="w-full text-[12px] tnum">
            <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="pb-1.5 font-medium">Cabinet</th>
                <th className="text-right font-medium">Used</th>
                <th className="text-right font-medium">Wired</th>
                <th className="text-right font-medium">Spare</th>
                <th className="text-right font-medium" title="Baseplates with no signal on them">Empty BP</th>
                <th className="text-right font-medium" title="Baseplates reserved at the end of the cabinet for future growth">Future BP</th>
                <th className="w-[132px] pl-4 font-medium">Fill</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.cabinet} onClick={() => enterCabinet(nav, idx.get(c.cabinet) ?? 0)} className="cursor-pointer border-t border-border transition-colors hover:bg-raised/70" title={`${c.controller} — open in the Cabinet Explorer`}>
                  <td className="py-1.5 font-mono text-[11.5px]">{c.cabinet}</td>
                  <td className="text-right">{c.used}</td>
                  <td className="text-right">{c.wired_spares}</td>
                  <td className="text-right">{c.spare_slots}</td>
                  <td className="text-right">{c.empty_baseplates}</td>
                  <td className="text-right">{c.future_baseplates}</td>
                  <td className="pl-4"><Bar pct={c.fill_pct} /></td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="py-1.5 text-muted-foreground">All cabinets</td>
                  <td className="text-right">{sum((r) => r.used)}</td>
                  <td className="text-right">{sum((r) => r.wired_spares)}</td>
                  <td className="text-right">{sum((r) => r.spare_slots)}</td>
                  <td className="text-right">{sum((r) => r.empty_baseplates)}</td>
                  <td className="text-right">{sum((r) => r.future_baseplates)}</td>
                  <td className="pl-4 text-[11px] text-muted-foreground">{a.kpis.fill_pct.toFixed(1)}% overall</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Panel>
  );
}

// ───────────── spare compliance: controller × IO type ─────────────

/** Rows = controller, columns = IO type. Each cell: wired spares as a % of the field count, with the rule's target drawn as a line. */
export function ComplianceTile({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const { data: rs } = useRules();
  const calm = useCalm();
  const target = Number(rs?.rules.find((r) => r.type === "wired_spare_pct" && r.enabled)?.params?.pct ?? 10);
  const cells = a?.kpis.spare_compliance ?? [];
  const controllers = [...new Set(cells.map((c) => c.controller))];
  const ios = [...new Set(cells.map((c) => c.io_type))].sort();
  const at = new Map(cells.map((c) => [`${c.controller}|${c.io_type}`, c]));
  const scale = Math.max(2 * target, ...cells.map((c) => c.pct * 1.15)); // one shared scale, so the target line sits at the same x in every cell
  const short = cells.filter((c) => !c.ok).length;
  return (
    <Panel
      title="Wired spares vs target" delay={delay} to="/rules"
      aside={a && <span className={cn("rounded-chip px-1.5 py-0.5 text-[11px] font-semibold", short ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok")}>{short ? `${short} short` : "all met"}</span>}
    >
      {!a ? <Loading /> : (
        <div className={SCROLL} data-stop>
          <div className="grid items-end gap-x-3 gap-y-3 text-[12px]" style={{ gridTemplateColumns: `minmax(96px,1.1fr) repeat(${ios.length}, minmax(0,1fr))` }}>
            <span />
            {ios.map((io) => (
              <span key={io} className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className="size-2 rounded-full" style={{ background: IO_COLOURS[ioKey({ status: "Field", io_type: io })] }} />{io}
              </span>
            ))}
            {controllers.map((ctrl, ri) => (
              <div key={ctrl} className="contents">
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={ctrl}>{ctrl}</span>
                {ios.map((io, ci) => {
                  const c = at.get(`${ctrl}|${io}`);
                  if (!c || !c.field) return <span key={io} className="text-[11px] text-muted-foreground/60">—</span>;
                  return (
                    <div key={io} title={`${ctrl} · ${io}: ${c.wired} wired of ${c.field} field = ${c.pct.toFixed(1)}% (target ${target}% → at least ${c.target})`}>
                      <div className="relative h-1.5 rounded-full bg-raised">
                        <motion.div
                          className={cn("h-full rounded-full", c.ok ? "bg-ok" : "bg-warn")}
                          initial={{ width: 0 }} animate={{ width: `${Math.min(100, (100 * c.pct) / scale)}%` }}
                          transition={{ duration: calm ? 0.15 : 0.6, delay: calm ? 0 : 0.2 + (ri * ios.length + ci) * 0.03, ease: EASE }}
                        />
                        <span className="absolute -top-[3px] h-3 w-px bg-text/70" style={{ left: `${(100 * target) / scale}%` }} />
                      </div>
                      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground tnum"><span>{c.wired}/{c.target}</span><span>{c.pct.toFixed(0)}%</span></div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-3.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-block h-3 w-px bg-text/70" /> {target}% target line · wired spares ≥ ⌈{target}% × field signals⌉ per controller and IO type
          </div>
        </div>
      )}
    </Panel>
  );
}

// ───────────── CIOC fill heat-map ─────────────

/** Cabinet × CIOC, each CIOC drawn as its baseplates: colour = dominant IO family, intensity = fill. Cell → that CIOC in the Explorer. */
export function FillHeatTile({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const nav = useNavigate();
  const calm = useCalm();
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => (a ? worldModel(a, dims) : null), [a, dims]);
  return (
    <Panel
      title="CIOC fill heat-map" delay={delay} to="/explorer"
      aside={<span className="hidden items-center gap-2 text-[10.5px] text-muted-foreground 2xl:flex">{IO_ORDER.map((k) => <span key={k} className="flex items-center gap-1"><span className="size-2 rounded-[2px]" style={{ background: IO_COLOURS[k] }} />{IO_LABELS[k]}</span>)}</span>}
    >
      {!model ? <Loading /> : (
        <div className={SCROLL} data-stop>
          <div className="grid items-center gap-x-2.5 gap-y-2" style={{ gridTemplateColumns: `132px repeat(${dims.ciocsPerCabinet}, minmax(0,1fr))` }}>
            <span />
            {Array.from({ length: dims.ciocsPerCabinet }, (_, i) => (
              <span key={i} className="text-[11px] font-medium text-muted-foreground">CIOC {i + 1} <span className="font-normal opacity-70">· {i < dims.ciocsPerSide ? "front" : "rear"}</span></span>
            ))}
            {model.cabinets.map((v) => (
              <div key={v.info.name} className="contents">
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={`${v.info.name} · ${v.info.controller}`}>{v.info.name}</span>
                {v.info.ciocs.map((c) => {
                  const pct = c.capacity ? (100 * (c.used + c.wired_spares)) / c.capacity : 0;
                  const bps = v.heat.filter((h) => h.ciocLocal === c.local);
                  return (
                    <button
                      key={c.local} data-testid="heat-cell"
                      onClick={() => enterCabinet(nav, v.index, { side: c.side as "F" | "R", level: "detail", focusCioc: c.local })}
                      title={`${c.name} — ${c.used} used + ${c.wired_spares} wired spare of ${c.capacity} (${pct.toFixed(1)}%). Open in the Explorer.`}
                      className="rounded-chip border border-transparent p-1 text-left transition-colors hover:border-brand/50 hover:bg-raised/70 focus-visible:border-brand/60 focus-visible:outline-none"
                    >
                      <div className="flex gap-[3px]">
                        {bps.map((h, i) => (
                          <motion.span
                            key={h.bp}
                            initial={calm ? false : { opacity: 0, scaleY: 0.3 }} animate={{ opacity: 1, scaleY: 1 }}
                            transition={{ duration: 0.3, delay: calm ? 0 : 0.15 + (v.index * 4 + c.local) * 0.02 + i * 0.012, ease: EASE }}
                            className={cn("h-5 flex-1 origin-bottom rounded-[3px]", h.fill === 0 && "border", h.fill === 0 && h.reserved ? "border-dashed border-muted-foreground/60" : h.fill === 0 && "border-[color:var(--spare)]")}
                            // intensity rides on the colour's alpha, not the element's opacity, so the entrance animation can own opacity
                            style={h.fill > 0 && h.io ? { background: `color-mix(in srgb, ${IO_COLOURS[h.io]} ${Math.round(28 + 72 * Math.min(1, h.fill))}%, transparent)` } : undefined}
                          />
                        ))}
                      </div>
                      <div className="mt-1 text-[10.5px] text-muted-foreground tnum"><span className="text-text">{pct.toFixed(0)}%</span> · {bps.filter((h) => h.fill > 0).length}/{bps.length} BP</div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] text-muted-foreground">Each bar is a baseplate · faint = lightly filled · dashed = reserved, outline = empty.</p>
        </div>
      )}
    </Panel>
  );
}

// ───────────── revision stability ─────────────

const KIND_GLYPH: Record<DiffKind, string> = { added: "+", deleted: "−", modified: "~", moved: "↷" };
const KINDS: DiffKind[] = ["added", "deleted", "modified", "moved"];

/** The gauge sweeps on arrival. Before any revision exists it shows the baseline and the way to measure one — never an invented number. */
export function StabilityTile({ delay }: { delay?: number }) {
  const { data: a } = useAllocation();
  const { data: impact } = useRevisionImpact();
  const nav = useNavigate();
  const calm = useCalm();
  const seq = useSequence(0);
  const live = !!a && a.kpis.stability_pct != null && !!impact;
  useEffect(() => {
    if (live) void seq.play(calm ? 0.3 : 1.4);
  }, [live, seq, calm]);
  const inject = () => {
    useUi.getState().requestInject();
    nav("/revisions");
  };
  return (
    <Panel title="Revision stability" delay={delay} to="/revisions" aside={live && impact && <span className="font-mono text-[11px] text-muted-foreground">Rev {impact.from_rev} → {impact.to_rev}</span>}>
      {!a ? <Loading /> : (
        <StabilityGauge
          value={live ? impact!.stability_pct : null} p={seq.progress} unchanged={impact?.unchanged_in_place ?? 0} previous={impact?.previous_live ?? 0}
          empty={<>Rev {a.revision} is the baseline. All <span className="tnum text-text">{a.kpis.signals}</span> live signals are pinned and stay in their slots when Rev B arrives.</>}
        >
          {live && impact ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <span key={k} className={cn("flex items-center gap-1 rounded-chip px-1.5 py-0.5 text-[11px]", toneOf(k).chip)}>
                  <span className="font-mono font-semibold">{KIND_GLYPH[k]}</span><span className="tnum font-semibold">{impact[k].length}</span><span className="opacity-80">{k}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-2.5"><Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11.5px]" data-stop onClick={inject}><FlaskConical className="size-3.5" /> Inject Rev B</Button></div>
          )}
        </StabilityGauge>
      )}
    </Panel>
  );
}
