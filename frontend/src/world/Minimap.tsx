import { motion, useTransform } from "framer-motion";
import { memo } from "react";

import type { Dims, WorldModel } from "@/api/derive";
import { IO_COLOURS } from "@/lib/io";
import { cn } from "@/lib/utils";

import { cabinetBounds, plantRect } from "./geometry";
import type { Camera } from "./useCamera";

const W = 220;
const H = 64;

/** All cabinets in a strip + the camera's viewport box. Click a cabinet to glide there. */
export const Minimap = memo(function Minimap({ model, dims, cam, vw, vh, activeIdx, onPick }: {
  model: WorldModel; dims: Dims; cam: Camera; vw: number; vh: number; activeIdx: number; onPick: (i: number) => void;
}) {
  const pr = plantRect(model.cabinets.length, dims);
  const m = Math.min((W - 12) / pr.w, (H - 12) / pr.h);
  const ox = (W - pr.w * m) / 2 - pr.x * m;
  const oy = (H - pr.h * m) / 2 - pr.y * m;
  const left = useTransform([cam.x, cam.s], ([x, s]: number[]) => ox + (-x / s) * m);
  const top = useTransform([cam.y, cam.s], ([y, s]: number[]) => oy + (-y / s) * m);
  const width = useTransform(cam.s, (s) => (vw / s) * m);
  const height = useTransform(cam.s, (s) => (vh / s) * m);
  return (
    <div className="glass relative overflow-hidden rounded-card border border-border" style={{ width: W, height: H }} data-testid="minimap">
      {model.cabinets.map((c) => {
        const b = cabinetBounds(c.index, dims);
        const used = c.counts.field + c.counts.alarm + c.counts.wired;
        const fill = Math.min(1, used / Math.max(1, c.slots.length));
        return (
          <button
            key={c.info.name}
            title={c.info.name}
            onClick={() => onPick(c.index)}
            className={cn("absolute rounded-[2px] border transition-colors", c.index === activeIdx ? "border-brand bg-brand/25" : "border-border bg-raised hover:border-muted-foreground")}
            style={{ left: ox + b.x * m, top: oy + b.y * m, width: Math.max(3, b.w * m), height: b.h * m }}
          >
            <span className="absolute inset-x-[2px] bottom-[2px] rounded-[1px]" style={{ height: `${Math.max(8, fill * 100)}%`, background: IO_COLOURS.ai, opacity: 0.55 }} />
          </button>
        );
      })}
      <motion.div className="pointer-events-none absolute rounded-[3px] border border-live/80 shadow-[0_0_8px_rgb(var(--live)/.5)]" style={{ left, top, width, height }} />
    </div>
  );
});
