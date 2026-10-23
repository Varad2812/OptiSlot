import { animate, useMotionValue, type AnimationPlaybackControls, type MotionValue } from "framer-motion";
import { useMemo, useRef } from "react";

export interface Sequence {
  progress: MotionValue<number>;
  /** Play 0 → 1 over `seconds` (linear; each phase applies its own easing). */
  play: (seconds: number) => Promise<void>;
  /** Freeze at p (Playwright frames, scrubbing). */
  seek: (p: number) => void;
  /** Jump to the end state. */
  skip: () => void;
}

/** A sequence is a single progress value; everything on screen is a pure function of it. */
export function useSequence(initial = 1): Sequence {
  const progress = useMotionValue(initial);
  const ctl = useRef<AnimationPlaybackControls | null>(null);
  return useMemo(() => {
    const stop = () => {
      ctl.current?.stop();
      ctl.current = null;
    };
    return {
      progress,
      play: (seconds) => {
        stop();
        progress.set(0);
        return new Promise<void>((resolve) => {
          ctl.current = animate(progress, 1, { duration: seconds, ease: "linear", onComplete: resolve });
        });
      },
      seek: (p) => {
        stop();
        progress.set(Math.min(1, Math.max(0, p)));
      },
      skip: () => {
        stop();
        progress.set(1);
      },
    };
  }, [progress]);
}
