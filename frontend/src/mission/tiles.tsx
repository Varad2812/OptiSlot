import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useAllocation } from "@/api/hooks";
import { Bar, Panel } from "@/components/panels";
import { Skeleton } from "@/components/ui/skeleton";
import { openInRoom } from "@/world/actions";

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
    <Panel title="Spares per cabinet" delay={delay} to="/room" aside={a && <span className="text-[11px] text-muted-foreground tnum">{rows.length} cabinets</span>}>
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
                <tr key={c.cabinet} onClick={() => openInRoom(nav, idx.get(c.cabinet) ?? 0)} className="cursor-pointer border-t border-border transition-colors hover:bg-raised/70" title={`${c.controller} — open it in the 3D Room`}>
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
