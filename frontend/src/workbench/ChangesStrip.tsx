import { motion } from "framer-motion";
import { ArrowRight, Boxes, FlaskConical, GitCommitHorizontal, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import type { AllocationResult } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EASE } from "@/motion/shared";
import { CountUp } from "@/shell/CountUp";

import { shortSlot, useCommitMoves, useRedoMove, useResetSandbox, useUndoMove, type PlacementState } from "./api";
import { showIn3d } from "./Detail";

interface Tile {
  label: string;
  now: number;
  was: number;
  dec?: number;
  suffix?: string;
  goodWhenLower?: boolean;
  alert?: boolean;
}

/** Scoreboard for the sandbox, inline in the page header: committed → working, with the delta. Numbers tick on every move. */
export function ImpactBar({ a, state }: { a: AllocationResult; state: PlacementState | undefined }) {
  const ch = state?.changes ?? null;
  const kb = ch?.kpis_before ?? a.kpis, kn = ch?.kpis_now ?? a.kpis;
  const viol = ch ? ch.violations_now : a.report.violations;
  const tiles: Tile[] = [
    { label: "Violations", now: viol, was: a.report.violations, goodWhenLower: true, alert: viol > 0 },
    { label: "Allocated", now: kn.allocated_pct, was: kb.allocated_pct, dec: kn.allocated_pct % 1 ? 1 : 0, suffix: "%" },
    { label: "Moved", now: ch?.moves?.length ?? 0, was: 0 },
    { label: "CIOCs", now: kn.ciocs, was: kb.ciocs, goodWhenLower: true },
    { label: "Cabinets", now: kn.cabinets, was: kb.cabinets, goodWhenLower: true },
    { label: "Fill", now: kn.fill_pct, was: kb.fill_pct, dec: 1, suffix: "%" },
    { label: "Wired spares", now: kn.wired_spares, was: kb.wired_spares },
  ];
  return (
    <div className="flex items-stretch divide-x divide-border/70" data-testid="wb-impact">
      {tiles.map((t) => {
        const d = t.now - t.was;
        const changed = Math.abs(d) > 1e-9 && t.label !== "Moved";
        const good = t.goodWhenLower ? d < 0 : d > 0;
        return (
          <div key={t.label} className="relative px-3.5" title={changed ? `was ${t.was.toFixed(t.dec ?? 0)}${t.suffix ?? ""} before the sandbox` : "committed = working"}>
            {t.alert && <motion.span key={t.now} className="pointer-events-none absolute inset-0 bg-err/15" initial={{ opacity: 0.9 }} animate={{ opacity: 0.3 }} transition={{ duration: 0.9, ease: EASE }} />}
            <div className="label-caps text-[10px]">{t.label}</div>
            <div className="flex items-baseline gap-1.5">
              <span className={cn("text-[15px] font-semibold leading-5", t.alert ? "text-err" : t.label === "Violations" ? "text-ok" : "text-text")}>
                <CountUp value={t.now} decimals={t.dec} suffix={t.suffix} />
              </span>
              {changed && (
                <span className={cn("tnum text-[10.5px] font-semibold", good ? "text-ok" : "text-warn")}>
                  {d > 0 ? "+" : "−"}{Math.abs(d).toFixed(t.dec ?? 0)}{t.suffix}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  state: PlacementState | undefined;
  unavailable: boolean;
  onPickTag: (tag: string) => void;
}

/** Sandbox controls + the list of moves (N moves) with Show in 3D / Before | Now / the Room. */
export function ChangesStrip({ state, unavailable, onPickTag }: Props) {
  const nav = useNavigate();
  const undo = useUndoMove(), redo = useRedoMove(), reset = useResetSandbox();
  const [commit, setCommit] = useState(false);
  const moves = state?.changes?.moves ?? [];
  const n = moves.length;
  const depth = state?.depth ?? 0, redoDepth = state?.redo_depth ?? 0;
  const busy = undo.isPending || redo.isPending || reset.isPending;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface/60 px-4 py-2" data-testid="changes-strip">
      <div className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium", n > 0 ? "border-warn/50 bg-warn/10 text-warn" : "border-border text-muted-foreground")} data-testid="sandbox-badge">
        <FlaskConical className="size-3.5" /> Sandbox · <span className="tnum">{n}</span> move{n === 1 ? "" : "s"}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Btn icon={<Undo2 className="size-3.5" />} label="Undo" disabled={depth === 0 || busy} onClick={() => undo.mutate()} badge={depth || undefined} testid="undo" />
        <Btn icon={<Redo2 className="size-3.5" />} label="Redo" disabled={redoDepth === 0 || busy} onClick={() => redo.mutate()} badge={redoDepth || undefined} testid="redo" />
        <Btn icon={<RotateCcw className="size-3.5" />} label="Reset" disabled={depth === 0 || busy} onClick={() => reset.mutate()} testid="reset" />
        <Button size="sm" className="ml-1 h-7 gap-1.5 text-[12px]" disabled={n === 0 || busy} onClick={() => setCommit(true)} data-testid="commit">
          <GitCommitHorizontal className="size-3.5" /> Commit
        </Button>
      </div>

      <div className="min-w-0 flex-1 overflow-x-auto" data-testid="changes-list">
        {n === 0 ? (
          <span className="text-[12px] text-muted-foreground">{unavailable ? "The sandbox API did not answer — the table still shows the committed allocation." : "No draft moves. Pick a signal, choose a slot — Apply puts the move here."}</span>
        ) : (
          <div className="flex items-center gap-1.5">
            {moves.map((m) => (
              <div key={`${m.tag}|${m.from_slot}|${m.to_slot}`} className="flex h-7 shrink-0 items-center rounded-full border border-border bg-raised/60 pl-2.5 pr-1 text-[11px]" data-testid="change-chip">
                <button onClick={() => onPickTag(m.tag)} className="flex items-center gap-1.5 hover:text-brand" title={m.reason || undefined}>
                  <span className="max-w-[150px] truncate font-mono">{m.tag}</span>
                  <span className="font-mono text-muted-foreground">{shortSlot(m.from_slot)}</span>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span className="font-mono text-live">{shortSlot(m.to_slot)}</span>
                </button>
                <button onClick={() => showIn3d(nav, m.to_slot)} className="ml-1 grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-brand/20 hover:text-text" title="Show in 3D (Now)" aria-label="Show in 3D">
                  <Boxes className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {n > 0 && (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[12px]" onClick={() => showIn3d(nav, moves[0].to_slot, "now")} data-testid="show-now">
            <Boxes className="size-3.5" /> Now
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => showIn3d(nav, moves[0].from_slot, "before")} data-testid="show-before">
            Before
          </Button>
        </div>
      )}
      <Button size="sm" variant="ghost" className="h-7 shrink-0 text-[12px] text-muted-foreground" onClick={() => nav("/room")}>
        3D Room
      </Button>

      <CommitDialog open={commit} onClose={() => setCommit(false)} n={n} state={state} />
    </div>
  );
}

function Btn({ icon, label, disabled, onClick, badge, testid }: { icon: React.ReactNode; label: string; disabled: boolean; onClick: () => void; badge?: number; testid: string }) {
  return (
    <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-[12px]" disabled={disabled} onClick={onClick} data-testid={testid}>
      {icon} {label}
      {badge != null && <span className="tnum rounded-full bg-raised px-1.5 text-[10px] text-muted-foreground">{badge}</span>}
    </Button>
  );
}

function CommitDialog({ open, onClose, n, state }: { open: boolean; onClose: () => void; n: number; state: PlacementState | undefined }) {
  const [reason, setReason] = useState("");
  const [who, setWho] = useState("engineer");
  const [err, setErr] = useState<string | null>(null);
  const commit = useCommitMoves();
  const ch = state?.changes;
  const submit = () => {
    setErr(null);
    commit.mutate(
      { reason: reason.trim(), who: who.trim() || "engineer" },
      {
        onSuccess: (res) => {
          toast.success(`Committed ${res.committed} move${res.committed === 1 ? "" : "s"} as a manual override`, { description: `${res.report.violations} violations · logged in the decision log` });
          setReason("");
          onClose();
        },
        // a refused commit is a rule outcome, shown here; the sandbox is kept
        onError: (e) => setErr((e as Error).message),
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[460px]" data-testid="commit-dialog">
        <DialogHeader>
          <DialogTitle>Commit {n} move{n === 1 ? "" : "s"} as a manual override</DialogTitle>
          <DialogDescription>The moves become permanent input: every recompute and Rev B replays them, the decision log records why, and the export marks each slot “Moved”.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[12.5px]">
          <div className="max-h-28 space-y-1 overflow-y-auto rounded-md bg-raised/60 p-2 font-mono text-[11.5px]">
            {(ch?.moves ?? []).map((m, i) => (
              <div key={i} className="flex gap-1.5">
                <span className="max-w-[170px] truncate">{m.tag}</span>
                <span className="text-muted-foreground">{shortSlot(m.from_slot)}</span>→<span className="text-live">{shortSlot(m.to_slot)}</span>
              </div>
            ))}
          </div>
          <label className="block">
            <span className="label-caps">Why (kept in the decision log)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. closer to the junction box" className="mt-1 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring" data-testid="commit-reason" />
          </label>
          <label className="block">
            <span className="label-caps">Who</span>
            <input value={who} onChange={(e) => setWho(e.target.value)} className="mt-1 h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </label>
          {err && (
            <p className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-err" data-testid="commit-error">
              {err}
              <span className="mt-1 block text-muted-foreground">Nothing was stored and the sandbox is kept.</span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={commit.isPending || n === 0} data-testid="commit-confirm">
            {commit.isPending ? "Re-checking every rule…" : `Commit ${n} move${n === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
