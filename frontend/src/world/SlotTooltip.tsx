import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import type { WorldModel } from "@/api/derive";
import { IO_COLOURS, IO_LABELS, ioKey } from "@/lib/io";

export interface TooltipApi {
  show: (id: string, clientX: number, clientY: number) => void;
  hide: () => void;
}

/** One tooltip for the whole World, positioned imperatively (hovering never re-renders the slots). */
export const SlotTooltip = forwardRef<TooltipApi, { model: WorldModel }>(function SlotTooltip({ model }, ref) {
  const [id, setId] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    show: (next, cx, cy) => {
      if (next !== id) setId(next);
      const el = box.current;
      if (el) {
        const flip = cx > window.innerWidth - 300;
        el.style.transform = `translate(${flip ? cx - 276 : cx + 16}px, ${cy + 14}px)`;
      }
    },
    hide: () => setId(null),
  }), [id]);
  const s = id ? model.bySlotId.get(id) : undefined;
  const k = s ? ioKey(s) : "spare";
  return (
    <div ref={box} className="pointer-events-none fixed left-0 top-0 z-50" style={{ visibility: s ? "visible" : "hidden" }}>
      {s && (
        <div className="glass w-[260px] rounded-card border border-border p-3 text-[12px] shadow-xl">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: IO_COLOURS[k] }} />
            <span className="truncate font-mono text-[13px] font-medium">{s.tag === "-" ? "Spare slot" : s.tag}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{s.baseplate} · ch {s.ch} · CHARM {s.charm_no}</div>
          <div className="mt-2 grid grid-cols-[64px_1fr] gap-y-0.5 text-[11.5px]">
            <span className="text-muted-foreground">Status</span><span>{s.status}{k !== "spare" ? ` · ${IO_LABELS[k]}` : ""}</span>
            {s.cable !== "-" && (<><span className="text-muted-foreground">Cable</span><span className="font-mono">{s.cable} · {s.pair_label}</span></>)}
            <span className="text-muted-foreground">CHARM</span><span className="font-mono">{s.charm}</span>
            <span className="text-muted-foreground">TB</span><span className="font-mono">{s.tb}</span>
          </div>
          <div className="mt-2 text-[10.5px] text-muted-foreground">Click for “Why here?”</div>
        </div>
      )}
    </div>
  );
});
