import { motionValue } from "framer-motion";

import { useUi } from "@/store/ui";

// CLAUDE.md §10.4 motion vocabulary.
export const EASE = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: "spring", stiffness: 260, damping: 30 } as const;

/** 0..1 multiplier the Scoreboard count-ups follow. The Upload Dive drives it; at rest it is 1 = the real numbers. */
export const scoreProgress = motionValue(1);

/** sessionStorage flag: the Upload Dive autoplays once per session; any deliberate dive (a Mission Control click) counts as seen. */
export const DIVE_KEY = "optislot-dive-seen";

export const isCalm = () => useUi.getState().motion === "calm";
export const useCalm = () => useUi((s) => s.motion === "calm");

/** Page transition (fade + 8px slide, 200 ms). */
export const pageVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

/** cubic-bezier(0.22, 1, 0.36, 1) as a function, for progress-driven sequences. */
export function easeOut(t: number) {
  const c = Math.min(1, Math.max(0, t));
  // Solve the bezier x(u)=t by Newton iterations, then return y(u).
  const x1 = 0.22, y1 = 1, x2 = 0.36, y2 = 1;
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let u = c;
  for (let i = 0; i < 6; i++) {
    const dx = (bx(u + 1e-4) - bx(u - 1e-4)) / 2e-4;
    if (Math.abs(dx) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - (bx(u) - c) / dx));
  }
  return by(u);
}

/** Sub-progress of p inside [a, b], clamped, linear. */
export function phase(p: number, a: number, b: number) {
  return Math.min(1, Math.max(0, (p - a) / (b - a)));
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
