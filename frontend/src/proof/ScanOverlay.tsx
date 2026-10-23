import { motion, useTransform, type MotionValue } from "framer-motion";
import { memo } from "react";

import type { Dims } from "@/api/derive";
import { phase } from "@/motion/shared";
import { cabinetRect, sideOf, SLOT_H, SLOT_W, slotXY } from "@/world/geometry";

import { BEAM, type Fail } from "./scan";

const MAX_PULSES = 200;
const smooth = (t: number) => t * t * (3 - 2 * t); // a scan sweeps at a steady pace; ease-out would park the beam at the far edge by 50 %

interface Props {
  p: MotionValue<number>;
  cabIdx: number;
  side: "F" | "R";
  dims: Dims;
  calm: boolean;
  fails: Fail[];
  pulseKey: number;
  model: { cabIndexByName: Map<string, number> };
}

/**
 * World-space overlay for the Proof Center: the cyan scan beam sweeping across the visible cabinet (a pure function of the
 * sequence progress), and the red markers on every failing slot of this cabinet and side. The markers pulse three times when
 * `pulseKey` changes, then stay on as a steady ring.
 */
export const ScanOverlay = memo(function ScanOverlay({ p, cabIdx, side, dims, calm, fails, pulseKey, model }: Props) {
  const r = cabinetRect(cabIdx, dims);
  const x = useTransform(p, (v) => r.x - 24 + (r.w + 48) * smooth(phase(v, BEAM[0], BEAM[1])));
  const opacity = useTransform(p, (v) => Math.min(phase(v, BEAM[0], BEAM[0] + 0.03), 1 - phase(v, BEAM[1] - 0.03, BEAM[1])));
  const here = fails.filter((f) => {
    const s = f.slot;
    return s && model.cabIndexByName.get(s.cabinet) === cabIdx && sideOf(s.cioc_local, dims) === side;
  }).slice(0, MAX_PULSES);
  return (
    <g pointerEvents="none" data-testid="scan-overlay">
      <defs>
        <linearGradient id="scan-trail" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgb(var(--live))" stopOpacity="0" />
          <stop offset="1" stopColor="rgb(var(--live))" stopOpacity="0.34" />
        </linearGradient>
      </defs>
      {!calm && (
        <motion.g style={{ x, opacity }} data-testid="scan-beam">
          <rect x={-150} y={r.y - 18} width={150} height={r.h + 36} fill="url(#scan-trail)" />
          <rect x={-1.5} y={r.y - 18} width={3} height={r.h + 36} className="fill-live" filter="url(#glow)" />
        </motion.g>
      )}
      {here.map((f) => {
        const s = f.slot!;
        const q = slotXY(cabIdx, s.cioc_local, s.bp, s.ch, dims);
        return (
          <motion.rect
            key={`${f.key}/${pulseKey}`}
            x={q.x - 4} y={q.y - 4} width={SLOT_W + 8} height={SLOT_H + 8} rx={6}
            className="fill-err/25 stroke-err" strokeWidth={2.4} filter="url(#glow)" data-testid="fail-marker"
            initial={{ opacity: 0 }}
            animate={calm ? { opacity: 1 } : { opacity: pulseKey ? [0, 1, 0.15, 1, 0.15, 1, 0.85] : 1 }}
            transition={{ duration: pulseKey && !calm ? 1.5 : 0.2 }}
          />
        );
      })}
    </g>
  );
});
