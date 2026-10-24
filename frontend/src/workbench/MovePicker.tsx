import { ArrowRight, CheckCheck, Lock, MapPin, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { WorldModel } from "@/api/derive";
import type { AllocationResult, Slot } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IO_COLOURS, ioKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { moveKey, publish } from "@/motion/bus";

import { shortSlot, tagKey, useApplyMove, usePlacementCheck, type PlacementAlternative, type PlacementApplyResult, type PlacementCheck, type SignalRow } from "./api";
import { CheckPanel } from "./CheckPanel";

export interface Target {
  cabinet: string;
  cioc: number;       // position 1..N inside the cabinet
  bp: number;
  ch: number | null;
}

export const targetFromSlot = (s: Slot): Target => ({ cabinet: s.cabinet, cioc: s.cioc_local, bp: s.bp, ch: s.ch });

const field = "h-8 rounded-md border border-input bg-surface px-2.5 text-[12px] text-text outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Props {
  sig: SignalRow;
  a: AllocationResult;
  model: WorldModel;
  overlay: Map<string, Slot> | null;    // slots as they look in the sandbox (changes.slots_now)
  hint: Partial<Target> | null;         // from ?slot= / ?cabinet= (Try changes from the 3D room)
  channels: number;
  onPickTag: (tag: string) => void;
  onApplied: (res: PlacementApplyResult) => void;
}

export function MovePicker({ sig, a, model, overlay, hint, channels, onPickTag, onApplied }: Props) {
  const own = sig.location;
  const cabs = a.cabinets;
  const initial = (): Target => {
    if (hint?.cabinet && cabs.some((c) => c.name === hint.cabinet)) return { cabinet: hint.cabinet, cioc: hint.cioc ?? 1, bp: hint.bp ?? 1, ch: hint.ch ?? null };
    if (own) return { cabinet: own.cabinet, cioc: own.cioc_local, bp: own.bp, ch: null };
    return { cabinet: cabs[0]?.name ?? "", cioc: 1, bp: 1, ch: null };
  };
  const [t, setT] = useState<Target>(initial);
  const [dbt, setDbt] = useState<Target>(t);
  const [refused, setRefused] = useState<PlacementCheck | null>(null);
  const [shake, setShake] = useState(false);
  const [paste, setPaste] = useState("");
  const apply = useApplyMove();
  const resRef = useRef<HTMLDivElement>(null);

  // the signal moved (apply / undo / redo): start the picker from where it sits now
  const slotId = own?.slot_id ?? null;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const n: Target = own ? { cabinet: own.cabinet, cioc: own.cioc_local, bp: own.bp, ch: null } : { cabinet: cabs[0]?.name ?? "", cioc: 1, bp: 1, ch: null };
    setT(n);
    setDbt(n);
    setRefused(null);
  }, [slotId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = window.setTimeout(() => setDbt(t), 280);
    return () => window.clearTimeout(id);
  }, [t]);

  const cab = cabs.find((c) => c.name === t.cabinet);
  const cioc = cab?.ciocs.find((c) => c.local === t.cioc) ?? cab?.ciocs[0];
  const slotIdOf = (c: Target) => {
    const ci = cabs.find((x) => x.name === c.cabinet)?.ciocs.find((x) => x.local === c.cioc);
    return ci && c.ch != null ? `${c.cabinet}/${String(ci.seq).padStart(3, "0")}/${c.bp}/${c.ch}` : null;
  };
  const targetId = slotIdOf(t);
  const same = !!targetId && targetId === slotId;
  const complete = t.ch != null && !same;
  const settled = dbt.cabinet === t.cabinet && dbt.cioc === t.cioc && dbt.bp === t.bp && dbt.ch === t.ch;
  const check = usePlacementCheck(complete && settled ? { tag: sig.tag, row: sig.row, target: { cabinet: t.cabinet, cioc: String(t.cioc), bp: t.bp, ch: t.ch } } : null);
  const checking = complete && (!settled || check.isFetching);
  const result = !checking ? (refused ?? check.data ?? null) : null;

  useEffect(() => setRefused(null), [targetId]);
  // a refused verdict shakes the target slot in the 3D Room (live in another window, or when the Room opens next)
  useEffect(() => {
    if (result?.verdict === "refused" && result.to_slot) publish({ kind: "refused", slot: result.to_slot, tag: sig.tag });
  }, [result?.verdict, result?.to_slot]); // eslint-disable-line react-hooks/exhaustive-deps
  // the verdict can land below the fold of the side panel: bring it (and Apply) into view
  useEffect(() => {
    if (result) resRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result?.verdict, result?.to_slot]); // eslint-disable-line react-hooks/exhaustive-deps

  const occ = (id: string): Slot | undefined => overlay?.get(id) ?? model.bySlotId.get(id);
  const ownBlock = sig.block_id;

  const pick = (patch: Partial<Target>) => setT((p) => ({ ...p, ...patch }));
  const pickCab = (name: string) => {
    const c = cabs.find((x) => x.name === name);
    setT({ cabinet: name, cioc: c?.ciocs[0]?.local ?? 1, bp: 1, ch: null });
  };
  const pickAlt = (alt: PlacementAlternative) => {
    const s = occ(alt.slot_id) ?? model.bySlotId.get(alt.slot_id);
    const n: Target = s ? targetFromSlot(s) : { cabinet: alt.cabinet, cioc: Number(alt.cioc.slice(-3)) || 1, bp: alt.bp, ch: alt.ch };
    setT(n);
    setDbt(n);
  };
  const applyPasted = () => {
    const id = paste.trim();
    const s = occ(id);
    if (s) {
      pick(targetFromSlot(s));
      setPaste("");
    } else if (id) toast.message("No such slot", { description: `“${id}” is not a slot of this project (cabinet/CIOC/baseplate/channel).` });
  };

  const verdict = result?.verdict;
  const canApply = !!result && (verdict === "allowed" || verdict === "swap") && !apply.isPending && sig.can_move;
  const doApply = () => {
    if (!result || t.ch == null) return;
    apply.mutate(
      { tag: sig.tag, row: sig.row, target: { cabinet: t.cabinet, cioc: String(t.cioc), bp: t.bp, ch: t.ch }, swap: result.verdict === "swap" },
      {
        onSuccess: (res) => {
          if (res.applied) {
            const n = res.state.changes?.moves?.length ?? 0;
            toast.success(`Moved ${sig.tag.replace(/\s+/g, " ")}`, {
              description: `${shortSlot(res.check.from_slot)} → ${shortSlot(res.check.to_slot)} · ${res.report?.violations ?? 0} violations · ${n} move${n === 1 ? "" : "s"} in the sandbox`,
            });
            // the 3D Room flies it in (arc, ghost at the old slot, glow at the new one) — camera follows there
            const mine = new Set([tagKey(sig.tag), ...(res.check.swap ? [tagKey(res.check.swap.with_tag)] : [])]);
            const keys = (res.state.changes?.moves ?? []).filter((m) => mine.has(tagKey(m.tag))).map(moveKey);
            if (keys.length) publish({ kind: "move", keys, tag: sig.tag });
            onApplied(res);
          } else {
            if (res.check.to_slot) publish({ kind: "refused", slot: res.check.to_slot, tag: sig.tag });
            // a refusal, not an error: show the reasons, shake once
            setRefused(res.check);
            setShake(true);
            window.setTimeout(() => setShake(false), 400);
          }
        },
      },
    );
  };

  const fillOf = (bp: number) => {
    if (!cioc) return 0;
    let n = 0;
    for (let c = 1; c <= channels; c++) {
      const s = occ(`${t.cabinet}/${String(cioc.seq).padStart(3, "0")}/${bp}/${c}`);
      if (s && s.status !== "Spare Slot") n++;
    }
    return n / channels;
  };

  return (
    <section id="wb-move" className="scroll-mt-2 space-y-3" data-testid="move-picker">
      <div className="flex items-center gap-1.5">
        <MapPin className="size-3.5 text-brand" />
        <span className="label-caps">Move to</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="truncate" title={slotId ?? ""}>{slotId ? shortSlot(slotId) : "not placed"}</span>
          <ArrowRight className="size-3 shrink-0" />
          <span className={cn("truncate", targetId ? "text-live" : "")} title={targetId ?? ""} data-testid="target-slot">{targetId ? shortSlot(targetId) : "pick a slot"}</span>
        </div>
      </div>

      <div className="space-y-2.5 rounded-card border border-border bg-raised/40 p-3">
        <div className="flex gap-2">
          <select value={t.cabinet} onChange={(e) => pickCab(e.target.value)} className={cn(field, "min-w-0 flex-1")} aria-label="Cabinet" data-testid="pick-cabinet">
            {cabs.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {own && c.controller !== own.controller ? " · other controller" : ""}
              </option>
            ))}
          </select>
        </div>

        <Row label="CIOC">
          {cab?.ciocs.map((c) => (
            <Pill key={c.local} on={c.local === t.cioc} onClick={() => pick({ cioc: c.local, ch: null })} title={`${c.name} · ${c.used} used · ${c.wired_spares} wired spares of ${c.capacity}`} testid={`pick-cioc-${c.local}`}>
              <span className="font-mono">{String(c.seq).padStart(3, "0")}</span>
              <span className={cn("rounded-[3px] px-1 font-mono text-[9.5px]", c.family === "A" ? "bg-foreground/10 text-text" : c.family === "B" ? "border border-dashed border-muted-foreground/60" : "text-muted-foreground")}>{c.family === "-" ? "–" : c.family}</span>
            </Pill>
          ))}
        </Row>

        <Row label="Baseplate">
          {cioc?.baseplates.map((b) => (
            <Pill key={b.bp} on={b.bp === t.bp} onClick={() => pick({ bp: b.bp, ch: null })} title={b.reserved ? `${b.name} · reserved (${b.reserved.replace("_", " ")})` : `${b.name} · ${Math.round(fillOf(b.bp) * channels)}/${channels} in use`} testid={`pick-bp-${b.bp}`} narrow>
              <span className="font-mono">{b.bp}</span>
              {b.reserved ? <Lock className="size-2.5 text-muted-foreground" /> : <span className="h-1 w-3 overflow-hidden rounded-full bg-border"><span className="block h-full bg-brand" style={{ width: `${fillOf(b.bp) * 100}%` }} /></span>}
            </Pill>
          ))}
        </Row>

        <div>
          <div className="label-caps mb-1">Slot · channel</div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${channels}, minmax(0, 1fr))` }} role="radiogroup" aria-label="Channel">
            {Array.from({ length: channels }, (_, i) => i + 1).map((ch) => {
              const id = cioc ? `${t.cabinet}/${String(cioc.seq).padStart(3, "0")}/${t.bp}/${ch}` : "";
              const s = occ(id);
              const k = s ? ioKey(s) : "spare";
              const colour = IO_COLOURS[k];
              const isOwn = id === slotId;
              const mine = !!ownBlock && s?.block_id === ownBlock;
              const on = t.ch === ch;
              const reserved = !!s?.reserved;
              const wired = s?.status === "Wired Spare";
              const spare = !s || s.status === "Spare Slot";
              return (
                <button
                  key={ch}
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick({ ch })}
                  title={`ch ${ch} · ${s ? (s.tag !== "-" ? s.tag : s.status) : "unknown"}${isOwn ? " · current slot" : mine ? " · same cable" : ""}${reserved ? ` · reserved (${s?.reserved})` : ""}`}
                  className={cn(
                    "relative flex aspect-[3/4] items-end justify-center rounded-[4px] pb-0.5 font-mono text-[9.5px] leading-none outline-none transition-transform focus-visible:ring-1 focus-visible:ring-ring",
                    spare ? "border text-muted-foreground" : "border border-transparent text-black/70",
                    reserved && "border-dashed",
                    on && "-translate-y-0.5 scale-110",
                    on && (result ? (result.verdict === "refused" ? "ring-2 ring-err" : result.verdict === "swap" ? "ring-2 ring-brand" : "ring-2 ring-ok") : "ring-2 ring-live"),
                    isOwn && !on && "ring-2 ring-text/80",
                  )}
                  style={spare ? { borderColor: "var(--spare)" } : wired ? { backgroundColor: `${colour}4D`, color: colour } : { backgroundColor: colour }}
                  data-testid="pick-ch"
                  data-ch={ch}
                >
                  {wired && <span className="hatch pointer-events-none absolute inset-0 rounded-[4px] opacity-40" />}
                  <span className="relative">{ch}</span>
                  {mine && !isOwn && <span className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-text ring-1 ring-surface" />}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
            <span><i className="mr-1 inline-block size-2 rounded-[2px] ring-2 ring-text/80" />current</span>
            <span><i className="mr-1 inline-block size-1.5 rounded-full bg-text" />same cable</span>
            <span><i className="mr-1 inline-block size-2 rounded-[2px] border" style={{ borderColor: "var(--spare)" }} />spare slot</span>
            <span><i className="mr-1 inline-block size-2 rounded-[2px] border border-dashed" />reserved</span>
          </div>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            applyPasted();
          }}
        >
          <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="…or paste a slot id  P30-DCM-32001-04/015/5/1" className={cn(field, "min-w-0 flex-1 bg-transparent font-mono text-[11.5px]")} aria-label="Slot id" />
          <Button type="submit" variant="outline" size="sm" className="h-8 text-[12px]" disabled={!paste.trim()}>
            Go
          </Button>
        </form>
      </div>

      {!sig.can_move && (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">This signal cannot be moved yet — fix its data first.</p>
      )}

      {same && <p className="rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">That is where this signal sits now — pick another slot.</p>}
      {!complete && !same && <p className="text-[12px] text-muted-foreground">Pick a channel — every choice is checked against the rules and the independent verifier before anything changes.</p>}
      {checking && (
        <div className="space-y-2 rounded-card border border-border p-3" data-testid="checking">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <RotateCw className="size-3.5 animate-spin text-live" /> Checking {targetId ? shortSlot(targetId) : "…"} against the rules and the verifier…
          </div>
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      )}
      {check.isError && complete && settled && !check.isFetching && (
        <p className="rounded-md border border-dashed border-warn/50 px-3 py-2 text-[12px] text-muted-foreground" data-testid="check-unreachable">
          The check could not be evaluated ({(check.error as Error).message}). Nothing was changed.{" "}
          <button className="text-brand hover:underline" onClick={() => void check.refetch()}>Try again</button>
        </p>
      )}
      {result && !checking && (
        <div ref={resRef}>
          <CheckPanel check={result} onPickTag={onPickTag} onAlt={pickAlt} shake={shake} />
        </div>
      )}

      <Button className="h-9 w-full gap-2 text-[13px]" disabled={!canApply} onClick={doApply} data-testid="apply-move">
        {apply.isPending ? <RotateCw className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
        {verdict === "swap" ? "Apply swap to the sandbox" : "Apply to the sandbox"}
      </Button>
      <p className="-mt-1 text-center text-[11px] text-muted-foreground">A draft — nothing is exported until you Commit.</p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label-caps mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Pill({ on, onClick, children, title, testid, narrow }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string; testid?: string; narrow?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      data-testid={testid}
      className={cn(
        "flex h-7 items-center justify-center gap-1.5 rounded-md border text-[12px] transition-colors",
        narrow ? "w-[38px] flex-col gap-0.5 px-0 py-0.5 text-[11px]" : "px-2.5",
        on ? "border-brand/70 bg-brand/20 text-text" : "border-border bg-transparent text-muted-foreground hover:border-brand/40 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
