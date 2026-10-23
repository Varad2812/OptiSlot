import { AnimatePresence, motion } from "framer-motion";
import { Pin, X } from "lucide-react";
import { useMemo } from "react";

import { useAllocation, useWhy, type Slot } from "@/api/hooks";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IO_COLOURS, IO_LABELS, ioKey } from "@/lib/io";
import { EASE, useCalm } from "@/motion/shared";
import { useUi } from "@/store/ui";

/** Right drawer: the full row + the "Why here?" timeline. Opens from any slot or row (`useUi.inspect(id)`). */
export function Inspector() {
  const id = useUi((s) => s.inspectorSlot);
  const inspect = useUi((s) => s.inspect);
  const calm = useCalm();
  const { data: a } = useAllocation();
  const slot = useMemo(() => (id && a ? a.slots.find((s) => s.id === id) ?? null : null), [id, a]);
  return (
    <AnimatePresence>
      {slot && (
        <motion.aside
          key="inspector"
          initial={calm ? { opacity: 0 } : { x: 420, opacity: 0.6 }}
          animate={{ x: 0, opacity: 1 }}
          exit={calm ? { opacity: 0 } : { x: 420, opacity: 0 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="glass absolute inset-y-0 right-0 z-40 flex w-[400px] flex-col border-l border-border shadow-[-24px_0_60px_-20px_rgba(0,0,0,.5)]"
          data-testid="inspector"
        >
          <InspectorBody slot={slot} onClose={() => inspect(null)} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function InspectorBody({ slot, onClose }: { slot: Slot; onClose: () => void }) {
  const k = ioKey(slot);
  const colour = IO_COLOURS[k];
  const own = slot.why ?? [];
  const { data: why, isLoading } = useWhy(slot.id, own);
  const steps = why?.length ? why : own;
  const groups: [string, [string, string | number | null | undefined][]][] = [
    ["Hardware", [["CHARM", `${slot.charm} · ${slot.charm_desc}`], ["Terminal block", `${slot.tb} · ${slot.tb_desc}`], ["TB terminals", [slot.tb1, slot.tb2, slot.tb3].filter((t) => t && t !== "-").join(" / ") || "-"], ["CHARM no.", slot.charm_no]]],
    ["Cable", [["Cable", slot.cable], ["Spec", slot.cable_spec], ["Pair", slot.pair_label], ["Group", slot.group], ["Segregation", slot.family]]],
    ["Names", [["Controller", slot.controller], ["System cabinet", slot.system_cabinet], ["CIOC", slot.cioc], ["Baseplate", slot.baseplate], ["Domain", slot.domain]]],
    ["Signal", [["Service", slot.service], ["Signal type", slot.signal_type], ["Level", slot.signal_level], ["Instrument", slot.instrument_type], ["Loop typical", slot.loop_typical], ["MDB row", slot.source_row]]],
    ["Revision", [["Revision", slot.revision], ["Change", slot.change_type], ["Old tag", slot.old_tag], ["Remarks", slot.remarks]]],
  ];
  return (
    <>
      <div className="border-b border-border p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="label-caps">{slot.status}</div>
            <div className="mt-1 truncate font-mono text-[17px] font-medium" title={slot.tag}>
              {slot.tag === "-" ? "— empty slot —" : slot.tag}
            </div>
          </div>
          <button onClick={onClose} className="rounded-chip p-1 text-muted-foreground hover:bg-raised hover:text-text" aria-label="Close inspector">
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span>{slot.cabinet}</span>›<span>CIOC {String(slot.cioc_seq).padStart(3, "0")}</span>›<span>BP {slot.bp}</span>›<span>CH {slot.ch}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1.5 border-border">
            <span className="size-2 rounded-full" style={{ background: colour }} />
            {k === "spare" ? "No signal" : IO_LABELS[k]}
          </Badge>
          {slot.family !== "-" && <Badge variant="outline" className="border-border">Family {slot.family}</Badge>}
          <Badge variant="outline" className="border-border">Side {slot.side}</Badge>
          {slot.pinned && (
            <Badge variant="outline" className="gap-1 border-brand/50 text-brand">
              <Pin className="size-3" /> pinned
            </Badge>
          )}
          {(slot.tq_ids ?? []).map((t) => (
            <Badge key={t} variant="outline" className="border-warn/50 text-warn">{t}</Badge>
          ))}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <section className="p-4">
          <div className="label-caps mb-3">Why here?</div>
          <ol className="relative ml-1.5 border-l border-border">
            {(isLoading ? own : steps).map((w, i) => (
              <motion.li
                key={i}
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04, duration: 0.2, ease: EASE }}
                className="relative pb-3 pl-4 last:pb-0"
              >
                <span className="absolute -left-[5px] top-1.5 size-[9px] rounded-full border-2 border-surface bg-brand" />
                <div className="text-[12.5px] leading-snug">{w.text}</div>
                {w.rule_id && <span className="mt-1 inline-block rounded-chip bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{w.rule_id}</span>}
              </motion.li>
            ))}
            {!steps.length && <li className="pl-4 text-muted-foreground">No placement decision — this slot is free.</li>}
          </ol>
        </section>
        {groups.map(([title, rows]) => (
          <section key={title} className="border-t border-border px-4 py-3">
            <div className="label-caps mb-2">{title}</div>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
              {rows.map(([k2, v]) => (
                <div key={k2} className="contents">
                  <dt className="text-muted-foreground">{k2}</dt>
                  <dd className="break-words font-mono text-[11.5px]">{v == null || v === "" ? "-" : v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </ScrollArea>
    </>
  );
}
