import { ArrowRight, Ban, Cpu, Info, Layers, Repeat2, ShieldCheck, ShieldX, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

import { cabShort, shortSlot, type PlacementAlternative, type PlacementCheck } from "./api";

type Reason = NonNullable<PlacementCheck["reasons"]>[number];

const VERDICT = {
  allowed: { label: "ALLOWED", icon: ShieldCheck, box: "border-ok/45 bg-ok/8", text: "text-ok", blurb: "Every hard rule still holds — the independent verifier re-checked it." },
  refused: { label: "REFUSED", icon: Ban, box: "border-err/40 bg-err/5", text: "text-err", blurb: "This slot would break a rule. Nothing was changed." },
  swap: { label: "SWAP", icon: Repeat2, box: "border-brand/50 bg-brand/8", text: "text-brand", blurb: "The slot is occupied — exchanging the two cables is valid." },
} as const;

const KIND: Record<Reason["kind"], string> = {
  rule: "rule", capacity: "capacity", occupied: "occupied", reserved: "reserved", domain: "controller", data: "data", engine: "engine", verifier: "verifier", input: "input", error: "error", info: "info",
};

interface Props {
  check: PlacementCheck;
  onPickTag: (tag: string) => void;
  onAlt: (a: PlacementAlternative) => void;
  shake?: boolean;
}

/** A verdict is information, not a failure: refused moves show their reasons, the signals involved and one-click alternatives. */
export function CheckPanel({ check, onPickTag, onAlt, shake }: Props) {
  const v = VERDICT[check.verdict];
  const Icon = v.icon;
  const ch = check.changes;
  const moves = ch?.moves ?? [];
  const hw = ch?.hardware ?? [];
  const sp = ch?.spare;
  const viol = ch?.new_violations ?? [];
  const tqs = ch?.new_tqs ?? [];
  const reasons = check.reasons ?? [];
  const alts = (check.alternatives ?? []).slice(0, 5);
  const kb = check.kpis_before, ka = check.kpis_after;
  return (
    <div className={cn("rounded-card border p-3", v.box, shake && "shake")} data-testid="check-panel" data-verdict={check.verdict}>
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", v.text)} />
        <span className={cn("text-[12px] font-semibold tracking-[0.08em]", v.text)} data-testid="verdict">{v.label}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{v.blurb}</span>
      </div>

      {check.swap && (
        <div className="mt-2 rounded-md border border-brand/30 bg-raised/60 px-2.5 py-2 text-[12px]">
          Swaps with{" "}
          <button className="font-mono text-brand hover:underline" onClick={() => onPickTag(check.swap!.with_tag)}>
            {check.swap.with_tag}
          </button>{" "}
          <span className="text-muted-foreground">
            (cable {check.swap.with_cable} at {shortSlot(check.swap.with_slot)})
          </span>
          {check.swap.note && <div className="mt-0.5 text-muted-foreground">{check.swap.note}</div>}
        </div>
      )}

      {reasons.length > 0 && (
        <ul className="mt-2.5 space-y-2" data-testid="check-reasons">
          {reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] leading-[1.45]">
              {r.kind === "info" ? <Info className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" /> : <TriangleAlert className={cn("mt-[3px] size-3.5 shrink-0", check.verdict === "allowed" ? "text-warn" : "text-err")} />}
              <div className="min-w-0">
                <div>{r.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {r.kind !== "info" && <span className="rounded-chip bg-raised px-1.5 py-px text-[10px] uppercase tracking-wider text-muted-foreground">{KIND[r.kind]}</span>}
                  {r.rule_id && <span className="rounded-chip border border-border px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">{r.rule_id}</span>}
                  {(r.cables ?? []).map((c) => (
                    <span key={c} className="rounded-chip border border-border px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">{c}</span>
                  ))}
                  {(r.tags ?? []).slice(0, 4).map((t) => (
                    <button key={t} onClick={() => onPickTag(t)} className="rounded-chip border border-brand/30 bg-brand/10 px-1.5 py-px font-mono text-[10.5px] hover:border-brand" title="Select this signal">
                      {t}
                    </button>
                  ))}
                  {(r.tags?.length ?? 0) > 4 && <span className="text-[10.5px] text-muted-foreground">+{r.tags!.length - 4} more</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(moves.length > 0 || hw.length > 0 || sp || viol.length > 0 || tqs.length > 0) && (
        <div className="mt-3 border-t border-border/70 pt-2.5" data-testid="check-changes">
          <div className="label-caps mb-1.5">What would change</div>
          {moves.length > 0 && (
            <div className="space-y-1">
              {moves.slice(0, 5).map((m, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11.5px]">
                  <Layers className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 max-w-[40%] truncate font-mono">{m.tag}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{shortSlot(m.from_slot)}</span>
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-mono text-live">{shortSlot(m.to_slot)}</span>
                </div>
              ))}
              {moves.length > 5 && <div className="pl-[18px] text-[11px] text-muted-foreground">+ {moves.length - 5} more pair{moves.length - 5 === 1 ? "" : "s"} of the same cable</div>}
            </div>
          )}
          {hw.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {hw.slice(0, 3).map((h) => (
                <div key={h.slot_id} className="flex items-center gap-1.5 text-[11.5px]">
                  <Cpu className="size-3 shrink-0 text-warn" />
                  <span className="truncate font-mono">{h.tag}</span>
                  <span className="font-mono text-muted-foreground">{h.charm_before} → <span className="text-warn">{h.charm_after}</span> · {h.tb_before} → <span className="text-warn">{h.tb_after}</span></span>
                </div>
              ))}
            </div>
          )}
          {sp && (
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11.5px]">
              <Delta k="Wired spares" a={sp.wired_spares_before} b={sp.wired_spares_after} />
              <Delta k="Spare slots" a={sp.spare_slots_before} b={sp.spare_slots_after} />
              <Delta k="Spare target" a={sp.wired_target_before} b={sp.wired_target_after} />
            </div>
          )}
          {kb && ka && (
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11.5px]">
              <Delta k="Violations" a={kb.violations} b={ka.violations} bad />
              <Delta k="CIOCs" a={kb.ciocs} b={ka.ciocs} />
              <Delta k="Fill %" a={kb.fill_pct} b={ka.fill_pct} dec={1} />
            </div>
          )}
          {viol.map((x, i) => (
            <div key={i} className="mt-1.5 flex gap-1.5 text-[11.5px] text-err">
              <ShieldX className="mt-px size-3.5 shrink-0" />
              <span>
                <b className="font-mono">{x.check_id}</b> {x.message}
              </span>
            </div>
          ))}
          {tqs.length > 0 && <div className="mt-1.5 text-[11.5px] text-warn">Would raise {tqs.join(", ")}</div>}
        </div>
      )}

      {alts.length > 0 && (
        <div className="mt-3 border-t border-border/70 pt-2.5" data-testid="alternatives">
          <div className="label-caps mb-1.5">Nearest allowed slots</div>
          <div className="flex flex-wrap gap-1.5">
            {alts.map((a) => (
              <button
                key={a.slot_id}
                onClick={() => onAlt(a)}
                className="flex items-center gap-1.5 rounded-full border border-ok/35 bg-ok/8 px-2.5 py-1 font-mono text-[11px] text-text transition-colors hover:border-ok hover:bg-ok/15"
                title={a.slot_id}
                data-testid="alt-chip"
              >
                <ShieldCheck className="size-3 text-ok" />
                {cabShort(a.cabinet)} · {a.cioc.slice(-3)} · BP{a.bp} · ch{a.ch}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Delta({ k, a, b, dec = 0, bad }: { k: string; a: number; b: number; dec?: number; bad?: boolean }) {
  const same = Math.abs(a - b) < 1e-9;
  return (
    <div className="rounded-md bg-raised/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
      <div className="tnum font-mono">
        {a.toFixed(dec)}
        {!same && (
          <>
            {" "}
            <span className="text-muted-foreground">→</span> <span className={cn(bad && b > a ? "text-err" : "text-live")}>{b.toFixed(dec)}</span>
          </>
        )}
      </div>
    </div>
  );
}
