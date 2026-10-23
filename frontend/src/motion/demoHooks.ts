/**
 * `?demo=1` test hooks (CLAUDE.md §10.6): Playwright triggers and freezes the motion sequences at exact progress points.
 *   window.__optislot.ready                      → true once the Explorer World has data, fonts and a viewport
 *   window.__optislot.dive.play() / seek(p) / skip()
 *   window.__optislot.glide.play(to) / seek(from, to, p)
 *   window.__optislot.revb.inject() / seek(p) / reset()   (Revision Center: run the gauntlet silently, then scrub the diff)
 *   window.__optislot.verify.seek(p) / play() / state()    (Proof Center: freeze the verify scan; state = idle|uploading|scanning|flying|done)
 *   window.__optislot.world3d.ready() / goTo(level, addr) / playDive() / skipDive() / flyToSlot(id) / stats()   (3D Room)
 *   window.__optislot.fps.measure(ms)            → { avg, p95, worst, frames }
 */
type Api = Record<string, unknown>;

interface DemoHooks {
  ready: boolean;
  dive?: Api;
  glide?: Api;
  revb?: Api;
  verify?: Api;
  world3d?: Api;
  fps: { measure: (ms: number) => Promise<{ avg: number; p95: number; worst: number; frames: number }> };
}

declare global {
  interface Window {
    __optislot?: DemoHooks;
  }
}

export const demoMode = (() => {
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
})();

export function installDemoHooks() {
  if (!demoMode) return;
  window.__optislot = {
    ready: false,
    fps: {
      measure: (ms) =>
        new Promise((resolve) => {
          const deltas: number[] = [];
          let last = performance.now();
          const end = last + ms;
          const tick = (t: number) => {
            deltas.push(t - last);
            last = t;
            if (t < end) requestAnimationFrame(tick);
            else {
              const sorted = [...deltas].sort((a, b) => a - b);
              const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
              resolve({
                avg: Math.round(1000 / mean),
                p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
                worst: Math.round(sorted[sorted.length - 1] ?? 0),
                frames: deltas.length,
              });
            }
          };
          requestAnimationFrame(tick);
        }),
    },
  };
}

/** Register a sequence API; returns the unregister function. No-op outside demo mode. */
export function registerDemo(name: "dive" | "glide" | "revb" | "verify" | "world3d", api: Api) {
  const h = window.__optislot;
  if (!h) return () => {};
  h[name] = api;
  return () => {
    if (h[name] === api) delete h[name];
  };
}

export function setDemoReady(v: boolean) {
  if (window.__optislot) window.__optislot.ready = v;
}
