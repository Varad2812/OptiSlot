import { motion, useTransform, type MotionValue } from "framer-motion";
import { X } from "lucide-react";

import { phase } from "@/motion/shared";
import { CountUp } from "@/shell/CountUp";
import type { RevDiff3D } from "@/world3d/engine";

/** Rev diff count-up over the 3D Room (§10.7 motion 5): stability % and the four kinds, following the diff's progress p. */
export function RevDiffHud({ p, from, to, stability, diff, reversed, onClose }: {
  p: MotionValue<number>; from: string; to: string; stability: number; diff: RevDiff3D; reversed?: boolean; onClose: () => void;
}) {
  const follow = useTransform(p, (v) => phase(v, 0.05, 0.85));
  const rows: [string, number, string][] = [
    ["Added", diff.added.length, "bg-live"],
    ["Removed", diff.removed.length, "bg-err"],
    ["Changed", diff.changed.length, "bg-warn"],
    ["Moved", diff.moved.length, "bg-brand"],
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.3 }}
      className="glass pointer-events-auto absolute bottom-24 left-1/2 z-20 flex -translate-x-1/2 items-center gap-5 rounded-card border border-border px-5 py-3 inner-hi"
      data-testid="revdiff-hud"
    >
      <div>
        <div className="label-caps">Rev {from} → Rev {to}{reversed ? " · played back" : ""}</div>
        <div className="mt-0.5 text-[28px] font-semibold leading-8 text-brand">
          <CountUp value={stability} decimals={1} suffix="%" follow={follow} />
        </div>
        <div className="text-[11px] text-muted-foreground">stable — same slot, same hardware</div>
      </div>
      <div className="h-12 w-px bg-border" />
      <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-[12px]">
        {rows.map(([label, n, dot], i) => (
          <Tick key={label} p={p} at={0.12 + i * 0.16} label={label} n={n} dot={dot} />
        ))}
      </div>
      <button onClick={onClose} className="self-start rounded-chip p-1 text-muted-foreground hover:bg-raised hover:text-text" aria-label="Hide">
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

function Tick({ p, at, label, n, dot }: { p: MotionValue<number>; at: number; label: string; n: number; dot: string }) {
  const follow = useTransform(p, (v) => phase(v, at, at + 0.2));
  return (
    <div className="flex items-center gap-2">
      <span className={`size-2 rounded-[2px] ${dot}`} />
      <span className="w-[62px] text-muted-foreground">{label}</span>
      <CountUp value={n} follow={follow} className="font-semibold" />
    </div>
  );
}
