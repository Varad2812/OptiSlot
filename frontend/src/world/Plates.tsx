import { motion } from "framer-motion";

import type { WorldModel } from "@/api/derive";
import { IO_COLOURS, IO_LABELS, IO_ORDER } from "@/lib/io";
import { EASE } from "@/motion/shared";

// Shared by the 2D Cabinet Explorer and the 3D Marshalling Room so both read as one product (§10.8 cohesion).

export function HeaderPlate({ view, side }: { view: WorldModel["cabinets"][number]; side: "F" | "R" }) {
  const c = view.counts;
  const used = c.field + c.alarm;
  const fill = (100 * (used + c.wired)) / Math.max(1, view.slots.length);
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.22, ease: EASE }}
      className="glass rounded-card border border-border px-4 py-2.5 inner-hi"
      data-testid="header-plate"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[15px] font-medium">{view.info.name}</span>
        <span className="rounded-chip bg-brand/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-brand">{side === "F" ? "FRONT" : "REAR"}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        {view.info.controller} · {view.info.system_cabinet}
      </div>
      <div className="mt-2 flex gap-4 text-[11.5px] tnum">
        <Mini k="Field" v={c.field} />
        <Mini k="Alarm" v={c.alarm} />
        <Mini k="Wired spare" v={c.wired} />
        <Mini k="Spare slot" v={c.spare} />
        <Mini k="Fill" v={`${fill.toFixed(1)}%`} />
      </div>
    </motion.div>
  );
}

function Mini({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
      <div className="font-semibold">{v}</div>
    </div>
  );
}

export function Legend() {
  return (
    <div className="glass flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-card border border-border px-3 py-2 text-[11px] text-muted-foreground" data-testid="legend">
      {IO_ORDER.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="h-2.5 w-3.5 rounded-[3px]" style={{ background: IO_COLOURS[k] }} />
          {IO_LABELS[k]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="hatch h-2.5 w-3.5 rounded-[3px] border" style={{ color: IO_COLOURS.ai, borderColor: IO_COLOURS.ai }} /> Wired spare
      </span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border border-[color:var(--spare)]" /> Spare slot</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border border-dashed border-muted-foreground" /> Reserved BP</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border-2 border-brand/80" /> Family A</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border-2 border-dashed border-brand/80" /> Family B</span>
    </div>
  );
}
