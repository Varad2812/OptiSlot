import { motion, useTransform, type MotionValue } from "framer-motion";
import { ArrowRight } from "lucide-react";

import type { WorldModel } from "@/api/derive";
import { cn } from "@/lib/utils";
import { phase } from "@/motion/shared";
import { CountUp } from "@/shell/CountUp";
import { KIND_TONE, type DiffItem, type DiffKind } from "@/world/DiffOverlay";

const ARC = "M 18 98 A 82 82 0 0 1 182 98";

/** Stability = unchanged-in-place ÷ previous live signals (computed by the server, never hard-coded). It sweeps with the diff. */
export function StabilityGauge({ value, p, unchanged, previous }: { value: number; p: MotionValue<number>; unchanged: number; previous: number }) {
  const sweep = useTransform(p, (v) => (value / 100) * phase(v, 0.05, 0.85));
  const follow = useTransform(p, (v) => phase(v, 0.05, 0.85));
  return (
    <div className="flex items-center gap-4" data-testid="stability-gauge">
      <div className="relative h-[112px] w-[200px] shrink-0">
        <svg viewBox="0 0 200 118" className="absolute inset-0 size-full" aria-hidden>
          <path d={ARC} fill="none" strokeWidth={11} strokeLinecap="round" className="stroke-border" />
          <motion.path d={ARC} fill="none" strokeWidth={11} strokeLinecap="round" className="stroke-brand" style={{ pathLength: sweep }} />
          {[0, 25, 50, 75, 100].map((t) => {
            const a = Math.PI * (1 - t / 100);
            return <line key={t} x1={100 + 70 * Math.cos(a)} y1={98 - 70 * Math.sin(a)} x2={100 + 76 * Math.cos(a)} y2={98 - 76 * Math.sin(a)} className="stroke-muted-foreground" strokeOpacity={0.5} />;
          })}
        </svg>
        <div className="absolute inset-x-0 bottom-1.5 text-center">
          <div className="text-[30px] font-semibold leading-8 text-brand"><CountUp value={value} decimals={1} suffix="%" follow={follow} /></div>
          <div className="label-caps">stability</div>
        </div>
      </div>
      <div className="min-w-0 text-[12px] leading-snug text-muted-foreground">
        <div><span className="tnum text-[15px] font-semibold text-text">{unchanged}</span> of <span className="tnum">{previous}</span></div>
        signals sat still — same slot, same hardware.
      </div>
    </div>
  );
}

const TONE: Record<"ok" | "err" | "warn" | "brand", { text: string; ring: string; chip: string; dot: string }> = {
  ok: { text: "text-ok", ring: "border-ok/60", chip: "bg-ok/15 text-ok", dot: "bg-ok" },
  err: { text: "text-err", ring: "border-err/60", chip: "bg-err/15 text-err", dot: "bg-err" },
  warn: { text: "text-warn", ring: "border-warn/60", chip: "bg-warn/15 text-warn", dot: "bg-warn" },
  brand: { text: "text-brand", ring: "border-brand/60", chip: "bg-brand/15 text-brand", dot: "bg-brand" },
};
export const toneOf = (k: DiffKind) => TONE[KIND_TONE[k]];

const KIND_LABEL: Record<DiffKind, string> = { added: "Added", deleted: "Deleted", modified: "Modified", moved: "Moved" };
const KIND_HINT: Record<DiffKind, string> = { added: "new signals placed", deleted: "slots freed", modified: "hardware swapped in place", moved: "rewired, each with a reason" };

export function KindCard({ kind, count, active, p, onClick }: { kind: DiffKind; count: number; active: boolean; p: MotionValue<number>; onClick: () => void }) {
  const t = toneOf(kind);
  const follow = useTransform(p, (v) => phase(v, 0.1, 0.8));
  return (
    <button
      onClick={onClick} aria-pressed={active} data-testid={`kind-${kind}`}
      className={cn("card-surface px-3.5 py-2.5 text-left transition-[transform,border-color] duration-200 hover:-translate-y-0.5", active && t.ring)}
    >
      <div className="label-caps flex items-center gap-1.5"><span className={cn("size-2 rounded-full", t.dot)} />{KIND_LABEL[kind]}</div>
      <div className={cn("mt-0.5 text-[26px] font-semibold leading-8", count ? t.text : "text-muted-foreground")}>
        <CountUp value={count} follow={follow} />
      </div>
      <div className="truncate text-[11px] text-muted-foreground">{KIND_HINT[kind]}</div>
    </button>
  );
}

const slotLabel = (id: string | null | undefined, model: WorldModel) => {
  const s = id ? model.bySlotId.get(id) : undefined;
  return s ? `${s.cabinet.replace(/^.*?-DCM-/, "")} · ${s.baseplate} · ch ${s.ch}` : "—";
};

/** The from→to list: every change with its reason. Click a row → the camera flies to the slot and pulses it. */
export function ChangeList({ items, model, focus, onPick }: { items: DiffItem[]; model: WorldModel; focus: string | null; onPick: (it: DiffItem) => void }) {
  const shown = items.slice(0, 400);
  return (
    <ul className="divide-y divide-border" data-testid="change-list">
      {shown.map((it) => {
        const t = toneOf(it.kind);
        return (
          <li key={it.key}>
            <button onClick={() => onPick(it)} className={cn("block w-full px-4 py-2.5 text-left transition-colors hover:bg-accent", focus === it.key && "bg-accent")}>
              <div className="flex items-center gap-2">
                <span className={cn("rounded-chip px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider", t.chip)}>{it.kind}</span>
                <span className="truncate font-mono text-[12px]">{it.tag}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                <span className="truncate">{it.from ? slotLabel(it.from.id, model) : "new"}</span>
                {it.from?.id !== it.to?.id && <ArrowRight className="size-3 shrink-0" />}
                {it.from?.id !== it.to?.id && <span className="truncate">{it.to ? slotLabel(it.to.id, model) : "freed"}</span>}
                {it.from && it.to && it.from.id === it.to.id && <span className="text-muted-foreground/70">same slot</span>}
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{it.reason}</p>
            </button>
          </li>
        );
      })}
      {items.length > shown.length && <li className="px-4 py-2 text-[11.5px] text-muted-foreground">…and {items.length - shown.length} more (see Revision_Impact.xlsx)</li>}
    </ul>
  );
}
