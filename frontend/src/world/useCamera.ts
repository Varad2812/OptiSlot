import { animate, useMotionValue, type AnimationPlaybackControls, type MotionValue } from "framer-motion";
import { useMemo, useRef } from "react";

import { easeOut, lerp, SPRING } from "@/motion/shared";

import type { Cam } from "./geometry";

export interface Camera {
  x: MotionValue<number>;
  y: MotionValue<number>;
  s: MotionValue<number>;
  get: () => Cam;
  set: (c: Cam) => void;
  stop: () => void;
  springTo: (c: Cam) => void;
  /** Progress-driven move from a to b (the glide / dive). `dip` zooms out mid-way for an arc. */
  at: (a: Cam, b: Cam, p: number, vw: number, vh: number, dip?: number) => void;
  tween: (a: Cam, b: Cam, ms: number, vw: number, vh: number, dip?: number) => Promise<void>;
}

/** Camera = {x, y, scale} motion values; screen = world·s + (x, y). Transform-only, so it runs at 60 fps. */
export function useCamera(): Camera {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const s = useMotionValue(1);
  const running = useRef<AnimationPlaybackControls[]>([]);

  return useMemo(() => {
    const stop = () => {
      running.current.forEach((c) => c.stop());
      running.current = [];
    };
    const get = (): Cam => ({ x: x.get(), y: y.get(), s: s.get() });
    const set = (c: Cam) => {
      x.set(c.x);
      y.set(c.y);
      s.set(c.s);
    };
    const at = (a: Cam, b: Cam, p: number, vw: number, vh: number, dip = 0) => {
      // Interpolate the world point at the viewport centre (not x/y), and the scale geometrically: a natural zoom.
      const e = easeOut(p);
      const ca = { cx: (vw / 2 - a.x) / a.s, cy: (vh / 2 - a.y) / a.s };
      const cb = { cx: (vw / 2 - b.x) / b.s, cy: (vh / 2 - b.y) / b.s };
      const sc = Math.exp(lerp(Math.log(a.s), Math.log(b.s), e)) * (1 - dip * Math.sin(Math.PI * Math.min(1, Math.max(0, p))));
      const cx = lerp(ca.cx, cb.cx, e);
      const cy = lerp(ca.cy, cb.cy, e);
      set({ s: sc, x: vw / 2 - cx * sc, y: vh / 2 - cy * sc });
    };
    return {
      x, y, s, get, set, stop, at,
      springTo: (c: Cam) => {
        stop();
        running.current = [animate(x, c.x, SPRING), animate(y, c.y, SPRING), animate(s, c.s, SPRING)];
      },
      tween: (a, b, ms, vw, vh, dip = 0) => {
        stop();
        const p = { v: 0 };
        return new Promise<void>((resolve) => {
          const ctl = animate(0, 1, {
            duration: ms / 1000,
            ease: "linear",
            onUpdate: (v) => ((p.v = v), at(a, b, v, vw, vh, dip)),
            onComplete: () => resolve(),
          });
          running.current = [ctl];
          ctl.then?.(() => resolve());
        });
      },
    };
  }, [x, y, s]);
}
