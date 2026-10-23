import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject } from "@/api/hooks";
import { Panel } from "@/components/panels";
import { Skeleton } from "@/components/ui/skeleton";
import { isCalm } from "@/motion/shared";
import { useUi } from "@/store/ui";

import { enterCabinet } from "./actions";
import { CabinetWorld } from "./CabinetWorld";
import { cabinetBounds, fit, plantRect } from "./geometry";
import { useCamera } from "./useCamera";

const MAX_VISIBLE = 6;   // long rows (10k ≈ 46 cabinets) page through windows of this many
const ZOOM_MS = 420;
const INSETS = { top: 16, right: 16, bottom: 8, left: 16 };

/**
 * The mini World at Plant level (Mission Control & previews). Click a cabinet: the strip's camera zooms into it, then the
 * Explorer opens with the same Plant → cabinet dive. Long rows page with ‹ ›.
 */
export function PlantStrip({ height = 230, title = "Marshalling room" }: { height?: number; title?: string }) {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const nav = useNavigate();
  const side = useUi((s) => s.side);
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => (a ? worldModel(a, dims) : null), [a, dims]);
  const cam = useCamera();
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const onSize = useCallback((w: number, h: number) => setVp((o) => (o.w === w && o.h === h ? o : { w, h })), []);
  const n = model?.cabinets.length ?? 0;
  const paged = n > MAX_VISIBLE;
  const [from, setFrom] = useState(0);
  const lo = Math.min(from, Math.max(0, n - MAX_VISIBLE));
  const windowCam = useCallback(() => fit(plantRect(n, dims, lo + (Math.min(n, MAX_VISIBLE) - 1) / 2, MAX_VISIBLE), vp.w, vp.h, INSETS), [n, dims, lo, vp.w, vp.h]);
  const placed = useRef<{ lo: number; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!vp.w || !n) return;
    const target = windowCam();
    const pv = placed.current;
    placed.current = { lo, w: vp.w, h: vp.h };
    if (!pv || pv.lo === lo || isCalm()) return cam.set(target); // first fit, resize, Calm
    void cam.tween(cam.get(), target, 420, vp.w, vp.h);          // paging: glide along the row
  }, [vp.w, vp.h, n, lo, windowCam, cam]);

  const cabinetS = vp.w && n ? fit(cabinetBounds(0, dims), vp.w, vp.h, { top: 0, right: 0, bottom: 0, left: 0 }).s * 4 : 1;
  const diving = useRef(false);
  const dive = async (i: number) => {
    if (diving.current) return;
    diving.current = true;
    if (!isCalm() && vp.w) await cam.tween(cam.get(), fit(cabinetBounds(i, dims), vp.w, vp.h, { top: 6, right: 6, bottom: 6, left: 6 }), ZOOM_MS, vp.w, vp.h);
    diving.current = false;
    enterCabinet(nav, i);
  };

  return (
    <Panel
      title={title}
      className="h-full"
      aside={
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {paged ? `${lo + 1}–${Math.min(n, lo + MAX_VISIBLE)} of ${n} cabinets` : `${n} cabinets`} · click one to dive in
          {paged && (
            <>
              <button aria-label="Previous cabinets" disabled={lo <= 0} onClick={() => setFrom(Math.max(0, lo - MAX_VISIBLE))} className="rounded-chip border border-border p-0.5 hover:text-text disabled:opacity-30"><ChevronLeft className="size-3.5" /></button>
              <button aria-label="Next cabinets" disabled={lo + MAX_VISIBLE >= n} onClick={() => setFrom(lo + MAX_VISIBLE)} className="rounded-chip border border-border p-0.5 hover:text-text disabled:opacity-30"><ChevronRight className="size-3.5" /></button>
            </>
          )}
        </span>
      }
    >
      <div style={{ minHeight: `clamp(${height}px, 30vh, ${Math.round(height * 1.5)}px)` }} className="h-full overflow-hidden rounded-chip" data-testid="plant-strip">
        {!model ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <CabinetWorld model={model} dims={dims} cam={cam} side={side} activeIdx={-5} cabinetS={cabinetS} interactive={false} onSize={onSize} onCabinet={(i) => void dive(i)} />
        )}
      </div>
    </Panel>
  );
}
