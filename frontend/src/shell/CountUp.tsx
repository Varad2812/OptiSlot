import { animate, motion, useMotionValue, useTransform, type MotionValue } from "framer-motion";
import { useEffect } from "react";

import { scoreProgress, useCalm } from "@/motion/shared";

interface Props {
  value: number;
  decimals?: number;
  suffix?: string;
  /** Follow the shared Scoreboard progress (the Upload Dive rolls counters up to the real value). */
  follow?: MotionValue<number>;
  className?: string;
}

/** A number that ticks to its new value (tabular-nums, no React re-render per frame). */
export function CountUp({ value, decimals = 0, suffix = "", follow = scoreProgress, className }: Props) {
  const calm = useCalm();
  const mv = useMotionValue(value);
  useEffect(() => {
    const c = animate(mv, value, { duration: calm ? 0.15 : 0.6, ease: [0.22, 1, 0.36, 1] });
    return c.stop;
  }, [value, calm, mv]);
  const text = useTransform([mv, follow], ([v, p]: number[]) => `${(v * p).toFixed(decimals)}${suffix}`);
  return <motion.span className={className ? `tnum ${className}` : "tnum"}>{text}</motion.span>;
}
