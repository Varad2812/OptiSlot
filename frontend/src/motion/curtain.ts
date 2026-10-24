import { create } from "zustand";

/**
 * Import → Allocate → 3D Room hand-off (§10.4.1 / §10.8): the preview grid zooms in and tilts into a floor ("zoom"),
 * the screen holds that dark floor while the route changes and the 3D chunk loads ("hold"), and lifts only once the
 * Upload Dive's first frame is on screen ("lift") — so there is never a flash or a blank frame between the two.
 */
export type CurtainPhase = "zoom" | "hold" | "lift";
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Curtain {
  phase: CurtainPhase | null;
  rect: Rect | null;
  /** The grid's own background colour (light or dark theme) — the zoom starts from it. */
  from: string;
  holdAt: number;
  /** What the hold is waiting for, said plainly (it only shows when the wait is noticeable). */
  label: string;
  start: (rect: Rect, from: string, label?: string) => void;
  hold: () => void;
  lift: () => void;
  clear: () => void;
}

const MIN_HOLD_MS = 280; // the page transition under the curtain (fade + slide) is done by then
const SAFETY_MS = 6000;  // no dive frame (2D fallback, an error) → lift anyway
let safety = 0;
let liftT = 0;

export const useCurtain = create<Curtain>((set, get) => ({
  phase: null,
  rect: null,
  from: "#10141C",
  holdAt: 0,
  label: "",
  start: (rect, from, label = "") => {
    window.clearTimeout(safety);
    window.clearTimeout(liftT);
    set({ phase: "zoom", rect, from, holdAt: 0, label });
    safety = window.setTimeout(() => get().lift(), SAFETY_MS * 2);
  },
  hold: () => {
    if (!get().phase) return;
    window.clearTimeout(safety);
    set({ phase: "hold", holdAt: performance.now(), label: "Opening the marshalling room" });
    safety = window.setTimeout(() => get().lift(), SAFETY_MS);
  },
  lift: () => {
    const { phase, holdAt } = get();
    if (phase !== "hold" && phase !== "zoom") return;
    window.clearTimeout(safety);
    const wait = Math.max(0, MIN_HOLD_MS - (performance.now() - holdAt));
    window.clearTimeout(liftT);
    liftT = window.setTimeout(() => get().phase && set({ phase: "lift" }), phase === "hold" ? wait : 0);
  },
  clear: () => set({ phase: null, rect: null }),
}));

export const ZOOM_MS = 720;
export const ZOOM_CALM_MS = 180;
