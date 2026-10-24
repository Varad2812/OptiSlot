import type { Layout } from "./layout";

/**
 * Upload Dive choreography (§10.7 motion 1) as data: camera keyframes + effect curves, all functions of the dive progress
 * p ∈ [0, 1]. The engine plays it on its own clock or freezes it with seek(p) (Playwright frames), and appends the landing
 * pose (L1 of the first cabinet) as the final keyframe. A different dive (the planned "location rain") is another
 * DiveScript passed to playDive — the engine side does not change.
 */
export interface DiveKey {
  /** Progress at which the camera passes this pose. */
  at: number;
  pos: [number, number, number];
  target: [number, number, number];
}

export interface DiveScript {
  /** Seconds at cinematic speed. */
  dur: number;
  /** Camera poses before the landing; the landing pose is added by the engine at p = 1. */
  keys(L: Layout): DiveKey[];
  /** Progress at which the landing begins: the cabinet door opens and the rest of the room fades from here to 1. */
  land: number;
  fov(p: number): number;
  /** Light-trail alpha (junction box → the baseplates that received cables). */
  trail(p: number): number;
  /** Seconds fed to the trail shader (each trail starts at its own delay). */
  clock(p: number): number;
  /** Glow of cabinet c of n (they light up left → right). */
  glow(p: number, c: number, n: number): number;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const smooth = (u: number) => u * u * (3 - 2 * u);

/** The prototype's dive: wide fly-in, the row lights up, sweep left, sweep right, low push-through, land at L1. */
export const DIVE: DiveScript = {
  dur: 7.6,
  land: 0.84,
  keys(L) {
    const sw = Math.max(1, L.room.w / 12.3);
    const [hx, , hz] = L.home.target;
    const c0 = L.cab[0];
    return [
      { at: 0, pos: [hx, 5, 56 * sw], target: [hx, 2, hz * 0.5] },
      { at: 0.25, pos: [hx, 4.5 * Math.sqrt(sw), 19 * sw], target: [hx, 1.8, hz * 0.4] },
      { at: 0.47, pos: [-5.5 * sw, 3, 12.5], target: [-2 * sw, 1.8, 0] },
      { at: 0.68, pos: [5.5 * sw, 3.5, 12.5], target: [2 * sw, 1.8, 0] },
      { at: 0.84, pos: [c0.x * 0.5, 1.6, 9.5], target: [c0.x * 0.5, 1.7, 0] }, // low push-through
    ];
  },
  fov: (p) => 80 - 40 * smooth(span(p, 0, 0.36)),
  trail: (p) => smooth(span(p, 0.02, 0.12)) * (1 - smooth(span(p, 0.84, 0.98))),
  clock: (p) => p * DIVE.dur,
  glow(p, c, n) {
    const t = p * DIVE.dur, t0 = 1.2 + (2.4 * c) / Math.max(1, n);
    return smooth(span(t, t0, t0 + 0.4)) * (1 - smooth(span(p, 0.8, 0.97)));
  },
};
