import { Bot, Boxes, ChevronRight, History, Info, Layers, MapPin } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { ioColourOf, type SignalRow } from "./api";
import { IoChip, StateChip } from "./columns";

export function showIn3d(nav: ReturnType<typeof useNavigate>, slotId: string | null | undefined, mode: "now" | "before" = "now") {
  if (slotId) useUi.getState().inspect(slotId);
  nav(`/room${mode === "before" ? "?mode=before" : ""}`);
}

const Fact = ({ k, children, mono = true }: { k: string; children: React.ReactNode; mono?: boolean }) => (
  <div className="min-w-0">
    <div className="label-caps">{k}</div>
    <div className={cn("mt-0.5 truncate text-[12.5px]", mono && "font-mono text-[12px]")}>{children}</div>
  </div>
);

/** Plain-English reason → one line per clause (the API sends one long sentence list). */
export function clauses(reason: string): string[] {
  return reason
    .split(/(?<=\.)\s+(?=[A-Z0-9])|;\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function DetailCard({ r, stale, onAsk }: { r: SignalRow; stale: boolean; onAsk?: () => void }) {
  const nav = useNavigate();
  const loc = r.location, hw = r.hardware;
  const placed = !!loc;
  const why = useMemo(() => clauses(r.state === "quarantined" && r.quarantine_reason && !r.reason ? `Quarantined — ${r.quarantine_reason}` : r.reason), [r]);
  const title = placed ? "Why here" : r.state === "quarantined" ? "Why it is quarantined" : r.state === "deleted" ? "Deleted" : "Why it is not placed";
  const colour = r.io_type !== "-" ? ioColourOf(r) : "#2A3242";
  return (
    <div className={cn("space-y-3 transition-opacity", stale && "opacity-60")} data-testid="signal-detail">
      <div>
        <div className="flex items-start gap-2">
          <span className="mt-1.5 size-2.5 shrink-0 rounded-[3px]" style={{ background: colour }} />
          <h2 className="min-w-0 flex-1 break-all font-mono text-[16px] font-medium leading-6" data-testid="detail-tag">
            {r.tag}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[18px]">
          <StateChip state={r.state} />
          <IoChip r={r} />
          {r.tag_status !== "-" && <span className="rounded-full border border-border px-2 py-px text-[10.5px] text-muted-foreground">{r.tag_status}</span>}
          {r.family !== "-" && (
            <span className={cn("rounded-full border-2 px-2 py-px font-mono text-[10.5px]", r.family === "A" ? "border-solid border-muted-foreground/70" : "border-dashed border-muted-foreground/70")} title={`Segregation family ${r.family}`}>
              {r.family}
            </span>
          )}
          <span className="font-mono text-[10.5px] text-muted-foreground">MDB row {r.row}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-card border border-border bg-raised/40 p-3">
        <Fact k="Cable / pair">{r.cable !== "-" ? `${r.cable}${r.pair != null ? ` · pair ${r.pair}` : ""}${r.cable_size ? ` of ${r.cable_size}` : ""}` : "—"}</Fact>
        <Fact k="Group · instrument">{`${r.group} · ${r.instrument_type}`}</Fact>
        {placed && (
          <>
            <Fact k="Cabinet">{loc?.cabinet ?? "—"}</Fact>
                <Fact k="CIOC">{loc ? `${loc.cioc} · ${loc.side === "R" ? "rear" : "front"}` : "—"}</Fact>
                <Fact k="Baseplate · channel">{loc ? `${loc.baseplate} · ch ${loc.ch}` : "—"}</Fact>
                <Fact k="CHARM no.">{loc ? `${loc.charm_no} of 96` : "—"}</Fact>
                <Fact k="CHARM" mono={false}>
              {hw ? (
                <span title={hw.charm_desc}>
                  <span className="font-mono text-[12px]">{hw.charm}</span> <span className="text-muted-foreground">{hw.charm_desc}</span>
                </span>
              ) : (
                "—"
              )}
            </Fact>
                <Fact k="Terminal block" mono={false}>
              {hw ? (
                <span title={hw.tb_desc}>
                  <span className="font-mono text-[12px]">{hw.tb}</span> <span className="text-muted-foreground">{hw.tb_desc}</span>
                </span>
              ) : (
                "—"
              )}
            </Fact>
          </>
        )}
      </div>

      <section className="rounded-card border border-border p-3" data-testid="why-block">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Info className="size-3.5 text-brand" />
          <span className="label-caps">{title}</span>
        </div>
        {why.length ? (
          <ul className="space-y-1.5 text-[12.5px] leading-[1.45]">
            {why.map((c, i) => (
              <li key={i} className="flex gap-2">
                <ChevronRight className="mt-[3px] size-3 shrink-0 text-muted-foreground" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">The engine recorded no reason for this signal.</p>
        )}
        {((r.rule_ids?.length ?? 0) > 0 || (r.tq_ids?.length ?? 0) > 0) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {r.rule_ids?.map((id) => (
              <Link key={id} to="/rules" className="rounded-chip border border-border bg-raised px-1.5 py-px font-mono text-[10.5px] text-muted-foreground hover:border-brand/50 hover:text-text" title="Open the rule">
                {id}
              </Link>
            ))}
            {r.tq_ids?.map((id) => (
              <Link key={id} to="/tqs" className="rounded-chip border border-warn/40 bg-warn/10 px-1.5 py-px font-mono text-[10.5px] text-warn hover:border-warn" title="Open the TQ">
                {id}
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" disabled={!placed} onClick={() => showIn3d(nav, loc?.slot_id)} data-testid="show-3d">
          <Boxes className="size-3.5" /> Show in 3D
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" disabled={!placed} onClick={() => loc && useUi.getState().inspect(loc.slot_id)}>
          <History className="size-3.5" /> Why-here timeline
        </Button>
        {onAsk && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={onAsk} data-testid="ask-open">
            <Bot className="size-3.5" /> Ask OptiSlot
          </Button>
        )}
        {r.can_move && (
          <Button size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => document.getElementById("wb-move")?.scrollIntoView({ behavior: "smooth", block: "start" })} data-testid="jump-move">
            <MapPin className="size-3.5" /> Move…
          </Button>
        )}
        {r.block_id && (
          <span className="flex h-8 items-center gap-1.5 rounded-md px-1 text-[11.5px] text-muted-foreground" title="Cables never split: moving one signal moves its whole cable">
            <Layers className="size-3.5" /> moves with cable {r.block_id}
          </span>
        )}
      </div>

      {r.source && Object.keys(r.source).length > 0 && (
        <details className="group rounded-card border border-border text-[12px]">
          <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground hover:text-text">Raw MDB row · {Object.keys(r.source).length} columns</summary>
          <dl className="grid max-h-56 grid-cols-[140px_1fr] gap-x-3 gap-y-1 overflow-y-auto border-t border-border px-3 py-2">
            {Object.entries(r.source)
              .filter(([, v]) => v !== "" && v != null)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="truncate text-muted-foreground" title={k}>{k}</dt>
                  <dd className="truncate font-mono text-[11.5px]" title={String(v)}>{String(v)}</dd>
                </div>
              ))}
          </dl>
        </details>
      )}
    </div>
  );
}
