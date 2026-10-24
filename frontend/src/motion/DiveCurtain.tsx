import { AnimatePresence, motion } from "framer-motion";

import { EASE, useCalm } from "./shared";
import { useCurtain, ZOOM_CALM_MS, ZOOM_MS } from "./curtain";

const ROOM_BG = "#0A0D13"; // the 3D Room's clear colour: the curtain ends exactly where the dive's first frame starts

/**
 * The Import → Room curtain (see curtain.ts). Zoom: the preview grid's rectangle grows to the full window while its cell
 * lines tilt back into a receding floor and the colour sinks to the room's. Hold: that floor, still. Lift: a fade over the
 * Upload Dive, which has already started underneath.
 */
export function DiveCurtain() {
  const { phase, rect, from, label, clear } = useCurtain();
  const calm = useCalm();
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  const r = rect ?? { x: 0, y: 0, w: vw, h: vh };
  const dur = (calm ? ZOOM_CALM_MS : ZOOM_MS) / 1000;
  return (
    <AnimatePresence onExitComplete={clear}>
      {phase && phase !== "lift" && (
        <motion.div
          key="curtain"
          className="pointer-events-auto fixed z-[80] overflow-hidden"
          style={{ perspective: 900 }}
          initial={calm ? { left: 0, top: 0, width: vw, height: vh, opacity: 0, backgroundColor: ROOM_BG, borderRadius: 0 } : { left: r.x, top: r.y, width: r.w, height: r.h, opacity: 1, backgroundColor: from, borderRadius: 10 }}
          animate={{ left: 0, top: 0, width: vw, height: vh, opacity: 1, backgroundColor: ROOM_BG, borderRadius: 0 }}
          exit={{ opacity: 0, transition: { duration: calm ? 0.2 : 0.45, ease: "easeOut" } }}
          transition={{ duration: dur, ease: EASE }}
          data-testid="dive-curtain"
          data-phase={phase}
        >
          {/* the violet glow of the room (as in bg-world), rising as the grid sinks */}
          <motion.div
            className="absolute inset-0"
            style={{ background: "radial-gradient(1200px 600px at 70% -10%, #1B1640 0%, transparent 60%)" }}
            initial={{ opacity: calm ? 1 : 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: dur, ease: EASE }}
          />
          {!calm && (
            <motion.div
              className="absolute left-[-50%] right-[-50%] top-[38%] h-[140%] origin-top"
              style={{
                backgroundImage:
                  "linear-gradient(to right, rgba(124,92,255,.32) 1px, transparent 1px), linear-gradient(to bottom, rgba(124,92,255,.32) 1px, transparent 1px)",
                maskImage: "linear-gradient(to bottom, transparent, black 18%, black 55%, transparent)",
                WebkitMaskImage: "linear-gradient(to bottom, transparent, black 18%, black 55%, transparent)",
              }}
              initial={{ rotateX: 0, y: "-38%", scale: 1, backgroundSize: "120px 24px", opacity: 0.9 }}
              animate={{ rotateX: 66, y: "0%", scale: 1.6, backgroundSize: "64px 64px", opacity: 0.55 }}
              transition={{ duration: dur * 1.1, ease: EASE }}
            />
          )}
          <motion.div
            key={label}
            className="absolute inset-x-0 bottom-[22%] text-center text-[12px] uppercase tracking-[0.18em] text-[#8C95A8]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: phase === "hold" ? 0.6 : dur + 0.2 }} // only once the wait is noticeable
          >
            {label}
            <span className="ml-1 inline-block w-4 animate-pulse text-left">…</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
