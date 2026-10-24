import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Boxes, Check, CheckCircle2, ChevronDown, Loader2, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { dimsOf } from "@/api/derive";
import { useAllocation, useApplyTq, useCloseTq, useProject, type AllocationResult, type Slot, type TQ } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EASE, useCalm } from "@/motion/shared";
import { ALLOCATE_LANDING_ROUTE, flyToSlot } from "@/world/actions";
import { ruleChecks } from "@/lib/checks";

// The generated types mark defaulted list fields optional; the API always sends them, but be safe about it.
type NTQ = TQ & { rows: number[]; tags: string[]; slot_ids: string[]; rules_in_conflict: string[]; fix_options: NonNullable<TQ["fix_options"]> };
const norm = (t: TQ): NTQ => ({ ...t, rows: t.rows ?? [], tags: t.tags ?? [], slot_ids: t.slot_ids ?? [], rules_in_conflict: t.rules_in_conflict ?? [], fix_options: t.fix_options ?? [] });

type Tab = "open" | "applied" | "closed";
const TABS: Tab[] = ["open", "applied", "closed"];
const SEV: Record<string, string> = { critical: "bg-err/20 text-err", high: "bg-err/15 text-err", medium: "bg-warn/15 text-warn", low: "bg-raised text-muted-foreground", info: "bg-raised text-muted-foreground" };
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** The slots a TQ is about: explicit slot ids, else every placed slot born from one of its MDB rows. */
function affected(a: AllocationResult, t: NTQ): Slot[] {
  if (t.slot_ids.length) {
    const ids = new Set(t.slot_ids);
    return a.slots.filter((s) => ids.has(s.id));
  }
  if (!t.rows.length) return [];
  const rows = new Set(t.rows);
  return a.slots.filter((s) => s.source_row != null && rows.has(s.source_row));
}

/** "r-hw · lists.high_current_do += "UZV"" — the exact change the Apply will make, before it does. */
function patchLines(f: NTQ["fix_options"][number]): string[] {
  const out: string[] = [];
  const r = f.rule_patch as Record<string, unknown> | null;
  if (r) {
    const op = String(r.op ?? "set");
    const sym = op === "list_add" ? "+=" : op === "list_remove" ? "-=" : op === "toggle" ? "toggle" : "=";
    out.push(`rule ${r.rule_id}: ${r.path ?? ""} ${sym} ${JSON.stringify(r.value ?? r.enabled ?? "")}`.replace(/\s+/g, " ").trim());
  }
  const d = f.data_patch as Record<string, unknown> | null;
  if (d) out.push(`data row ${d.row}: ${d.field} = ${JSON.stringify(d.value)}`);
  if (!out.length) out.push("no rule change — records the decision in the log");
  return out;
}

export default function TqCenter() {
  const { data: a } = useAllocation();
  const [tab, setTab] = useState<Tab>("open");
  const tqs = useMemo(
    () => [...(a?.tqs ?? [])].sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9) || x.id.localeCompare(y.id)),
    [a],
  );
  const count = (s: Tab) => tqs.filter((t) => t.status === s).length;
  // Cards the user just resolved stay in the Open tab with their result (until they leave it), so the flash can be seen.
  const [recent, setRecent] = useState<Record<string, { before: Record<string, Slot>; verb: string }>>({});
  const shown = tqs.filter((t) => t.status === tab || (tab === "open" && !!recent[t.id]));

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1100px] p-6" data-testid="tq-center">
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-page">TQ Center</h1>
            <p className="mt-1 text-muted-foreground">Every open question names the clash, offers a fix and says what stays unchanged.</p>
          </div>
          {a && (
            <div className="flex items-center gap-1.5 rounded-chip border border-border bg-raised px-2.5 py-1 text-[12px]" data-testid="tq-violations">
              <ShieldCheck className={cn("size-3.5", a.report.violations ? "text-err" : "text-ok")} />
              <span className="tnum">{a.report.violations} violations</span>
              <span className="text-muted-foreground tnum">· {ruleChecks(a.report)} · {a.kpis.signals} signals</span>
            </div>
          )}
        </header>

        <div className="mb-4 inline-flex rounded-card border border-border bg-surface p-1" role="tablist">
          {TABS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => (setTab(k), k !== "open" && setRecent({}))}
              className={cn("rounded-chip px-3.5 py-1.5 text-[12.5px] font-medium capitalize transition-colors", tab === k ? "bg-brand/15 text-text" : "text-muted-foreground hover:text-text")}
            >
              {k} <span className="ml-1 tnum text-muted-foreground">{count(k)}</span>
            </button>
          ))}
        </div>

        {!a ? (
          <div className="space-y-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {shown.map((t) => (
                <TqCard key={t.id} t={t} a={a} onResolved={(before, verb) => setRecent((r) => ({ ...r, [t.id]: { before, verb } }))} result={recent[t.id]} />
              ))}
            </AnimatePresence>
            {!shown.length && (
              <div className="card-surface flex items-center gap-3 p-6 text-muted-foreground">
                <CheckCircle2 className="size-5 text-ok" />
                {tab === "open" ? "No open queries — every live signal is placed and explained." : `Nothing ${tab} yet.`}
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function TqCard({ t: raw, a, onResolved, result }: { t: TQ; a: AllocationResult; onResolved: (before: Record<string, Slot>, verb: string) => void; result?: { before: Record<string, Slot>; verb: string } }) {
  const t = useMemo(() => norm(raw), [raw]);
  const calm = useCalm();
  const nav = useNavigate();
  const { data: p } = useProject();
  const apply = useApplyTq();
  const close = useCloseTq();
  const [pick, setPick] = useState<number | null>(null);
  const [open, setOpen] = useState(true);
  const slots = useMemo(() => affected(a, t), [a, t]);
  const isOpen = t.status === "open";
  const busy = apply.isPending || close.isPending;

  const snapshot = () => Object.fromEntries(slots.map((s) => [s.id, s]));
  function doApply(i: number) {
    const before = snapshot();
    apply.mutate({ id: t.id, option: i }, { onSuccess: () => onResolved(before, "Applied") });
  }
  function doClose() {
    close.mutate({ id: t.id, decision: "Accepted as is" }, { onSuccess: () => onResolved(snapshot(), "Closed") });
  }
  function show(s: Slot) {
    flyToSlot(a, s, dimsOf(a, p).ciocsPerSide);
    nav(ALLOCATE_LANDING_ROUTE);
  }

  return (
    <motion.article
      layout="position"
      initial={calm ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className="card-surface p-4"
      data-testid={`tq-${t.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="font-mono text-muted-foreground">{t.id}</span>
        <span className={cn("rounded-[4px] px-1.5 py-px font-medium", SEV[t.severity] ?? SEV.low)}>{t.severity}</span>
        <span className="text-muted-foreground">{t.category}</span>
        <span
          className={cn("rounded-[4px] px-1.5 py-px", t.confidence === "candidate" ? "border border-dashed border-warn/60 text-warn" : "bg-ok/15 text-ok")}
          title={t.confidence === "candidate" ? "Cause not proven — confirm before relying on it" : "Cause confirmed from the data"}
        >
          {t.confidence}
        </span>
        <span className="ml-auto" />
        {t.decision && <span className="rounded-[4px] bg-raised px-1.5 py-px text-muted-foreground">{t.decision}</span>}
        <button className="rounded-chip p-0.5 text-muted-foreground hover:text-text" onClick={() => setOpen(!open)} aria-label="Toggle details">
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>
      <p className="mt-2 text-[13.5px] leading-snug">{t.message}</p>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-muted-foreground">
            {t.rows.length > 0 && <span>MDB row{t.rows.length > 1 ? "s" : ""} <span className="font-mono text-text">{t.rows.slice(0, 8).join(", ")}{t.rows.length > 8 ? ` +${t.rows.length - 8}` : ""}</span></span>}
            {t.tags.length > 0 && <span>Tags <span className="font-mono text-text">{t.tags.slice(0, 3).join(", ")}{t.tags.length > 3 ? ` +${t.tags.length - 3}` : ""}</span></span>}
            {t.field && <span>Field <span className="font-mono text-text">{t.field}</span></span>}
            {t.rules_in_conflict.length > 0 && (
              <span className="flex items-center gap-1.5">Rules in conflict {t.rules_in_conflict.map((r) => <span key={r} className="rounded-chip border border-border bg-raised px-1.5 py-px font-mono text-text">{r}</span>)}</span>
            )}
          </div>

          {isOpen && t.fix_options.length > 0 && (
            <div className="space-y-1.5" role="radiogroup" aria-label="Fix options">
              <div className="label-caps">Fix options</div>
              {t.fix_options.map((f, i) => (
                <div key={i} className={cn("rounded-chip border transition-colors", pick === i ? "border-brand/60 bg-brand/[0.06]" : "border-border bg-raised/40 hover:border-brand/30")}>
                  <button type="button" role="radio" aria-checked={pick === i} onClick={() => setPick(pick === i ? null : i)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px]">
                    <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border", pick === i ? "border-brand bg-brand" : "border-border")}>{pick === i && <Check className="size-3 text-white" />}</span>
                    {f.label}
                  </button>
                  {pick === i && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="overflow-hidden">
                      <div className="border-t border-border px-3 py-2.5">
                        <div className="label-caps mb-1">Patch preview</div>
                        {patchLines(f).map((l) => <div key={l} className="font-mono text-[11.5px] text-live">{l}</div>)}
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <span className="text-[11.5px] text-muted-foreground">Re-runs allocate + verify, and logs the decision.</span>
                          <Button size="sm" disabled={busy} onClick={() => doApply(i)} className="gap-1.5" data-testid="tq-apply">
                            {apply.isPending && <Loader2 className="size-3.5 animate-spin" />}Apply
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>
              ))}
            </div>
          )}

          {isOpen && slots.length > 0 && (
            <button type="button" onClick={() => show(slots[0])} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-brand" data-testid="tq-show3d"><Boxes className="size-3.5" />Show in 3D · {slots.length} slot{slots.length > 1 ? "s" : ""}</button>
          )}

          {isOpen && (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <p className="text-[12px] text-muted-foreground"><span className="label-caps mr-2">Stays unchanged</span>{t.unchanged_note || "Every other signal keeps its slot."}</p>
              <Button variant="outline" size="sm" disabled={busy} onClick={doClose} className="shrink-0 gap-1.5">
                {close.isPending && <Loader2 className="size-3.5 animate-spin" />}{t.fix_options.length ? "Accept as is" : "Acknowledge"}
              </Button>
            </div>
          )}

          {result && !isOpen && <ResultStrip a={a} slots={slots} result={result} onShow={show} calm={calm} />}
          {!isOpen && !result && slots.length > 0 && (
            <button type="button" onClick={() => show(slots[0])} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-brand"><Boxes className="size-3.5" />Show in 3D · {slots.length} slot{slots.length > 1 ? "s" : ""}</button>
          )}
        </div>
      )}
    </motion.article>
  );
}

/** After Apply: the affected slots flash and show what changed in place (e.g. SE4302T01 → SE4302T02). */
function ResultStrip({ a, slots, result, onShow, calm }: { a: AllocationResult; slots: Slot[]; result: { before: Record<string, Slot>; verb: string }; onShow: (s: Slot) => void; calm: boolean }) {
  const ok = a.report.violations === 0;
  return (
    <div className="rounded-chip border border-ok/30 bg-ok/[0.06] p-3" data-testid="tq-result">
      <div className="flex items-center gap-2 text-[12.5px]">
        <CheckCircle2 className="size-4 text-ok" />
        <span>{result.verb} — re-verified: <b className={ok ? "text-ok" : "text-err"}>{a.report.violations} violations</b> · {ruleChecks(a.report)} · {a.kpis.signals} signals</span>
      </div>
      {slots.length > 0 && (
        <ul className="mt-2 space-y-1">
          {slots.slice(0, 6).map((s) => {
            const old = result.before[s.id];
            const changed = !!old && (old.charm !== s.charm || old.tb !== s.tb);
            return (
              <motion.li
                key={s.id}
                initial={calm ? false : { backgroundColor: "rgb(var(--live) / .35)" }}
                animate={{ backgroundColor: "rgb(var(--live) / 0)" }}
                transition={{ duration: 1.4, ease: EASE }}
                className="flex items-center gap-2 rounded-chip px-2 py-1 font-mono text-[11.5px]"
                data-testid="tq-flash"
              >
                <span className="truncate">{s.tag}</span>
                <span className="text-muted-foreground">{s.baseplate}·ch{s.ch}</span>
                {changed ? (
                  <span className="ml-auto flex items-center gap-1.5">{old.charm}/{old.tb}<ArrowRight className="size-3 text-muted-foreground" /><b>{s.charm}/{s.tb}</b></span>
                ) : (
                  <span className="ml-auto text-muted-foreground">{s.charm}/{s.tb} · same slot</span>
                )}
                <button type="button" onClick={() => onShow(s)} className="flex shrink-0 items-center gap-1 rounded-chip border border-border px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground hover:border-brand/50 hover:text-brand"><Boxes className="size-3" />Show in 3D</button>
              </motion.li>
            );
          })}
          {slots.length > 6 && <li className="px-2 text-[11.5px] text-muted-foreground">+{slots.length - 6} more</li>}
        </ul>
      )}
    </div>
  );
}
