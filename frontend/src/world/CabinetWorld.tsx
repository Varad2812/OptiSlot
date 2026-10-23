import { motion, motionValue, useMotionTemplate, useMotionValueEvent, useTransform, type MotionValue } from "framer-motion";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Dims, WorldModel } from "@/api/derive";
import type { Slot } from "@/api/hooks";
import { cn } from "@/lib/utils";

import { cabH, slotXY, SLOT_H, SLOT_W, tierOf, worldBounds } from "./geometry";
import { CabinetDetail, CabinetHeat, CabinetShell, FloorLabel, WorldDefs } from "./parts";
import { SlotTooltip, type TooltipApi } from "./SlotTooltip";
import type { Camera } from "./useCamera";

export type Tier = "plant" | "cabinet" | "detail";

export interface WorldProps {
  model: WorldModel;
  dims: Dims;
  cam: Camera;
  side: "F" | "R";
  activeIdx: number;
  cabinetS: number;          // scale of the "cabinet" fit → semantic zoom thresholds
  match?: ((s: Slot) => boolean) | null;
  selectedId?: string | null;
  reveal?: MotionValue<number>;
  drop?: MotionValue<number>;
  interactive?: boolean;
  className?: string;
  onSize?: (w: number, h: number) => void;
  onSlot?: (id: string) => void;
  onCabinet?: (i: number) => void;
  onCioc?: (i: number, local: number) => void;
  onTier?: (t: Tier) => void;
}

/**
 * The plant in 2.5D SVG (CLAUDE.md §10.3). One camera transform moves everything; level of detail:
 * every cabinet draws a 32-bar heat-map, only the active cabinet ±1 draws its slots, and only the active
 * cabinet at detail zoom draws text. Slot rects are memoised; hover/click use event delegation (data-slot).
 */
export const CabinetWorld = memo(function CabinetWorld(props: WorldProps) {
  const { model, dims, cam, side, activeIdx, cabinetS, match = null, selectedId, reveal, drop, interactive = true, className } = props;
  const ref = useRef<HTMLDivElement>(null);
  const tip = useRef<TooltipApi>(null);
  const [tier, setTier] = useState<Tier>(() => tierOf(cam.s.get(), cabinetS));
  const cb = useRef(props);
  cb.current = props;

  useMotionValueEvent(cam.s, "change", (s) => {
    const t = tierOf(s, cabinetS);
    if (t !== tier) {
      setTier(t);
      cb.current.onTier?.(t);
    }
  });
  useEffect(() => setTier(tierOf(cam.s.get(), cabinetS)), [cabinetS, cam.s]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => cb.current.onSize?.(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    cb.current.onSize?.(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // ───── pan (drag) + zoom (wheel, about the cursor) ─────
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.stop();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const s = cam.s.get();
      const lo = cabinetS * 0.12;
      const hi = cabinetS * 5;
      const ns = Math.min(hi, Math.max(lo, s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))));
      const k = ns / s;
      cam.set({ s: ns, x: px - (px - cam.x.get()) * k, y: py - (py - cam.y.get()) * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [cam, cabinetS, interactive]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.x.get(), cy: cam.y.get(), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && e.buttons & 1) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        cam.stop();
        tip.current?.hide();
      }
      if (d.moved) {
        cam.x.set(d.cx + dx);
        cam.y.set(d.cy + dy);
        return;
      }
    }
    if (!interactive) return;
    const id = (e.target as Element).getAttribute?.("data-slot");
    if (id) tip.current?.show(id, e.clientX, e.clientY);
    else tip.current?.hide();
  };
  const onPointerUp = () => {
    suppressClick.current = !!drag.current?.moved;
    drag.current = null;
  };
  const onClick = (e: React.MouseEvent) => {
    if (suppressClick.current) return void (suppressClick.current = false);
    const el = e.target as Element;
    const slot = el.getAttribute?.("data-slot");
    if (slot && tier !== "plant") return cb.current.onSlot?.(slot);
    const cab = el.closest?.("[data-cab]")?.getAttribute("data-cab");
    if (cab != null && (tier === "plant" || Number(cab) !== activeIdx)) cb.current.onCabinet?.(Number(cab));
  };

  const n = model.cabinets.length;
  const wb = useMemo(() => worldBounds(n, dims), [n, dims]);
  const near = (i: number) => Math.abs(i - activeIdx) <= 1;
  const floorY = useTransform([cam.y, cam.s], ([y, s]: number[]) => y + (cabH(dims) - 8) * s);
  const floorX = useTransform(cam.x, (x) => x * 0.6);
  const floorSize = useTransform(cam.s, (s) => 56 * Math.max(0.35, s));
  const floorBg = useMotionTemplate`${floorX}px 0px`;
  const floorBgSize = useMotionTemplate`${floorSize}px ${floorSize}px`;

  const sel = selectedId ? model.bySlotId.get(selectedId) : undefined;
  const selIdx = sel ? model.cabIndexByName.get(sel.cabinet) : undefined;
  const selXY = sel && selIdx != null && near(selIdx) && sideFor(sel.cioc_local, dims) === side ? slotXY(selIdx, sel.cioc_local, sel.bp, sel.ch, dims) : null;

  return (
    <div
      ref={ref}
      className={cn("relative h-full w-full touch-none select-none overflow-hidden", interactive && "cursor-grab active:cursor-grabbing", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => (tip.current?.hide(), (drag.current = null))}
      onClick={onClick}
      data-testid="world"
      data-tier={tier}
    >
      {/* floor: a perspective grid that pans at 0.6× the cabinets (parallax) */}
      <motion.div className="pointer-events-none absolute -left-1/2 w-[200%]" style={{ top: floorY, height: "140%", perspective: 700 }}>
        <motion.div
          className="h-full w-full origin-top"
          style={{
            rotateX: 64,
            backgroundImage: "linear-gradient(var(--floor) 1px, transparent 1px), linear-gradient(90deg, var(--floor) 1px, transparent 1px)",
            backgroundPosition: floorBg,
            backgroundSize: floorBgSize,
            maskImage: "linear-gradient(to bottom, black 0%, transparent 70%)",
            WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 70%)",
          }}
        />
      </motion.div>

      <motion.div className="absolute left-0 top-0 origin-top-left" style={{ x: cam.x, y: cam.y, scale: cam.s }}>
        <svg
          width={wb.w}
          height={wb.h}
          viewBox={`${wb.x} ${wb.y} ${wb.w} ${wb.h}`}
          style={{ position: "absolute", left: wb.x, top: wb.y, overflow: "visible" }}
        >
          <WorldDefs />
          {model.cabinets.map((v) => (
            <g key={v.info.name}>
              <CabinetShell view={v} dims={dims} side={side} active={v.index === activeIdx && tier !== "plant"} reveal={reveal} n={n} />
              {tier === "plant" && <FloorLabel view={v} dims={dims} />}
              {tier === "plant" || !near(v.index) ? (
                <CabinetHeatFaded view={v} dims={dims} side={side} reveal={reveal} n={n} />
              ) : (
                <CabinetDetail
                  view={v}
                  dims={dims}
                  side={side}
                  showText={tier === "detail" && v.index === activeIdx}
                  match={match}
                  drop={drop}
                  onCioc={interactive && cb.current.onCioc ? (local) => cb.current.onCioc?.(v.index, local) : undefined}
                />
              )}
            </g>
          ))}
          {selXY && (
            <motion.rect
              key={selectedId}
              x={selXY.x - 3}
              y={selXY.y - 3}
              width={SLOT_W + 6}
              height={SLOT_H + 6}
              rx={5}
              fill="none"
              className="stroke-live"
              strokeWidth={2}
              filter="url(#glow)"
              pointerEvents="none"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 0.55, 1] }}
              transition={{ duration: 0.9 }}
            />
          )}
        </svg>
      </motion.div>
      {interactive && <SlotTooltip ref={tip} model={model} />}
    </div>
  );
});

function sideFor(local: number, d: Dims) {
  return local <= d.ciocsPerSide ? "F" : "R";
}

function CabinetHeatFaded({ view, dims, side, reveal, n }: { view: WorldModel["cabinets"][number]; dims: Dims; side: "F" | "R"; reveal?: MotionValue<number>; n: number }) {
  const i = view.index;
  const opacity = useTransform(reveal ?? FULL, (p) => Math.min(1, Math.max(0, (p * (n + 2) - i - 0.6) / 2)));
  return (
    <motion.g style={{ opacity }}>
      <CabinetHeat view={view} dims={dims} side={side} />
    </motion.g>
  );
}

const FULL = motionValue(1);
