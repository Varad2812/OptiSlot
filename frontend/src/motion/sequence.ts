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

/** Sequences playing right now — Esc (useGlobalHotkeys) jumps every one of them to its end state. */
const playing = new Set<() => void>();

/** Skip every running sequence to its end. True when there was something to skip. */
export function skipAllSequences(): boolean {
  if (!playing.size) return false;
  [...playing].forEach((f) => f());
  return true;
}

/** A sequence is a single progress value; everything on screen is a pure function of it. */
export function useSequence(initial = 1): Sequence {
  const progress = useMotionValue(initial);
  const ctl = useRef<AnimationPlaybackControls | null>(null);
  const done = useRef<(() => void) | null>(null);
  return useMemo(() => {
    // whatever awaits play() resumes when the sequence ends or is skipped (a replacing play/seek supersedes it, as before)
    const settle = () => {
      const r = done.current;
      done.current = null;
      playing.delete(skip);
      r?.();
    };
    const stop = () => {
      ctl.current?.stop();
      ctl.current = null;
      done.current = null;
      playing.delete(skip);
    };
    const skip = () => {
      const r = done.current;
      stop();
      progress.set(1);
      r?.();
    };
    return {
      progress,
      play: (seconds) => {
        stop();
        progress.set(0);
        return new Promise<void>((resolve) => {
          done.current = resolve;
          playing.add(skip);
          ctl.current = animate(progress, 1, { duration: seconds, ease: "linear", onComplete: settle });
        });
      },
      seek: (p) => {
        stop();
        progress.set(Math.min(1, Math.max(0, p)));
      },
      skip,
    };
  }, [progress]);
}
