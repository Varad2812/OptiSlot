import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { commitReq, putRules, redoReq, undoReq, whatIf, type Move, type WhatIfResult } from "@/api/sandbox";
import { useProjectId, type AllocationResult, type RuleSet } from "@/api/hooks";
import { impactOf, overlayAllocation } from "@/lib/sandbox";

export type Strategy = "balanced" | "compact";

/** Everything the engineer has changed in the sandbox but not committed. Pure data, so undo/redo are snapshots. */
export interface Pending {
  moves: Move[];
  toggles: Record<string, boolean>;
  params: Record<string, Record<string, number>>;
  strategy: Strategy | null; // null = unchanged
}
export const EMPTY: Pending = { moves: [], toggles: {}, params: {}, strategy: null };

const hasWhatIf = (p: Pending) => p.moves.length > 0 || Object.keys(p.toggles).length > 0 || Object.keys(p.params).length > 0;
export const isDirty = (p: Pending) => hasWhatIf(p) || p.strategy !== null;
export const changeCount = (p: Pending) => p.moves.length + Object.keys(p.toggles).length + Object.keys(p.params).length + (p.strategy ? 1 : 0);

export type Attempt = { ok: true } | { ok: false; reason: string };

/**
 * The Try-out Lab's brain. Preview = POST /whatif (never commits). A strategy change has no what-if form, so it is
 * applied to the rule set provisionally (logged as a sandbox preview in the decision log) and restored on Discard.
 */
export function useSandbox(live: AllocationResult, rules: RuleSet) {
  const pid = useProjectId();
  const qc = useQueryClient();
  const orig = (rules.settings?.cioc_strategy ?? "balanced") as Strategy;

  const [frozen, setFrozen] = useState<AllocationResult | null>(null);   // Current pane while the sandbox is dirty
  const baseline = frozen ?? live;
  const [pending, setPending] = useState<Pending>(EMPTY);
  const [stratBase, setStratBase] = useState<AllocationResult | null>(null); // the allocation under a provisional strategy
  const [wi, setWi] = useState<WhatIfResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<Pending[]>([]);
  const [future, setFuture] = useState<Pending[]>([]);
  const [srvUndo, setSrvUndo] = useState(true);   // unknown until the server says "nothing to undo"
  const [srvRedo, setSrvRedo] = useState(false);

  const origRules = useRef(rules);
  if (!isDirty(pending)) origRules.current = rules;
  const latest = useRef({ pending, orig });
  latest.current = { pending, orig };

  const afterServerChange = useCallback(
    (res: AllocationResult) => {
      qc.setQueryData(["allocation", pid], res);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "allocation" });
    },
    [pid, qc],
  );

  const proposed = useMemo(() => overlayAllocation(stratBase ?? baseline, wi), [stratBase, baseline, wi]);
  const impact = useMemo(() => impactOf(baseline, proposed), [baseline, proposed]);

  const reset = useCallback(() => {
    setFrozen(null); setPending(EMPTY); setStratBase(null); setWi(null); setPast([]); setFuture([]);
  }, []);

  /** Move the sandbox to `target`; `strict` (a click-to-move) refuses instead of showing violations. */
  const evaluate = useCallback(
    async (target: Pending, strict: boolean): Promise<{ res: Attempt; apply?: () => void }> => {
      setBusy(true);
      try {
        const cur = latest.current.pending;
        let base = stratBase;
        const wantStrat = target.strategy ?? orig;
        if (wantStrat !== (cur.strategy ?? orig)) {
          const rs = { ...origRules.current, settings: { ...origRules.current.settings, cioc_strategy: wantStrat } };
          const why = target.strategy ? `Sandbox preview: CIOC strategy → ${wantStrat}` : `Sandbox: CIOC strategy restored to ${orig}`;
          base = await putRules(pid, rs, why);
          if (!target.strategy) afterServerChange(base);
        }
        const r = hasWhatIf(target) ? await whatIf(pid, { moves: target.moves, rule_toggles: target.toggles, params: target.params }) : null;
        if (strict && r && !r.allowed) return { res: { ok: false, reason: r.blocked_reason ?? "a hard rule rejected the move" } };
        const nextBase = target.strategy ? base : null;
        return {
          res: { ok: true },
          apply: () => {
            setFrozen((f) => f ?? live);
            setStratBase(nextBase);
            setWi(r);
            setPending(target);
          },
        };
      } catch (e) {
        return { res: { ok: false, reason: (e as Error).message } };
      } finally {
        setBusy(false);
      }
    },
    [pid, orig, stratBase, live, afterServerChange],
  );

  /** Run a change; on success push the previous state on the undo stack. */
  const change = useCallback(
    async (target: Pending, strict = false): Promise<Attempt> => {
      const { res, apply } = await evaluate(target, strict);
      if (res.ok && apply) {
        setPast((p) => [...p, latest.current.pending]);
        setFuture([]);
        apply();
        if (!isDirty(target)) setTimeout(() => setFrozen(null), 0);
      } else if (!res.ok && !strict) toast.error("Preview failed", { description: res.reason });
      return res;
    },
    [evaluate],
  );

  /** For animations: validate first, apply (state change) when the ghost lands. */
  const tryMove = useCallback(
    async (mv: Move) => {
      const cur = latest.current.pending;
      const next: Pending = { ...cur, moves: [...cur.moves.filter((m) => m.block_id !== mv.block_id), mv] };
      const { res, apply } = await evaluate(next, true);
      return {
        res,
        land: () => {
          if (!apply) return;
          setPast((p) => [...p, cur]);
          setFuture([]);
          apply();
        },
      };
    },
    [evaluate],
  );

  const undoLocal = useCallback(async () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    const { res, apply } = await evaluate(prev, false);
    if (!res.ok || !apply) return void toast.error("Undo failed", { description: res.ok ? "" : res.reason });
    setFuture((f) => [...f, latest.current.pending]);
    setPast((p) => p.slice(0, -1));
    apply();
    if (!isDirty(prev)) setTimeout(() => setFrozen(null), 0);
  }, [past, evaluate]);

  const redoLocal = useCallback(async () => {
    const nxt = future[future.length - 1];
    if (!nxt) return;
    const { res, apply } = await evaluate(nxt, false);
    if (!res.ok || !apply) return void toast.error("Redo failed", { description: res.ok ? "" : res.reason });
    setPast((p) => [...p, latest.current.pending]);
    setFuture((f) => f.slice(0, -1));
    apply();
  }, [future, evaluate]);

  const dirty = isDirty(pending);

  const undo = useCallback(async () => {
    if (dirty || past.length) return undoLocal();
    setBusy(true);
    try {
      const res = await undoReq(pid);
      afterServerChange(res);
      setSrvRedo(true);
      toast.success("Undid the last commit", { description: `${res.report.violations} violations · ${res.kpis.ciocs} CIOCs` });
    } catch (e) {
      setSrvUndo(false);
      toast.message("Nothing to undo", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [dirty, past.length, undoLocal, pid, afterServerChange]);

  const redo = useCallback(async () => {
    if (future.length) return redoLocal();
    setBusy(true);
    try {
      const res = await redoReq(pid);
      afterServerChange(res);
      setSrvUndo(true);
      toast.success("Redid the commit", { description: `${res.report.violations} violations · ${res.kpis.ciocs} CIOCs` });
    } catch (e) {
      setSrvRedo(false);
      toast.message("Nothing to redo", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [future.length, redoLocal, pid, afterServerChange]);

  const commit = useCallback(async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const req = { moves: pending.moves, rule_toggles: pending.toggles, params: pending.params };
      const res = hasWhatIf(pending) ? await commitReq(pid, req) : (stratBase ?? live);
      afterServerChange(res);
      reset();
      setSrvUndo(true);
      setSrvRedo(false);
      toast.success("Committed", { description: `${res.report.violations} violations · ${res.kpis.ciocs} CIOCs · ${res.kpis.cabinets} cabinets` });
    } catch (e) {
      toast.error("Commit refused", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [dirty, busy, pending, pid, stratBase, live, afterServerChange, reset]);

  const discard = useCallback(async () => {
    if (!dirty) return;
    setBusy(true);
    try {
      if (pending.strategy) afterServerChange(await putRules(pid, origRules.current, `Sandbox discarded: CIOC strategy restored to ${orig}`));
      reset();
      toast.message("Sandbox discarded", { description: "Nothing was committed." });
    } catch (e) {
      toast.error("Discard failed", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [dirty, pending.strategy, pid, orig, afterServerChange, reset]);

  // Leaving the Lab with a provisional strategy must not leave it on the server.
  useEffect(
    () => () => {
      const { pending: p } = latest.current;
      if (p.strategy) void putRules(pid, origRules.current, `Sandbox closed: CIOC strategy restored to ${latest.current.orig}`).then((res) => {
        qc.setQueryData(["allocation", pid], res);
        qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "allocation" });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pid],
  );

  return {
    baseline, proposed, impact, pending, dirty, busy, wi, orig,
    canUndo: dirty ? true : srvUndo, canRedo: future.length > 0 || srvRedo,
    change, tryMove, undo, redo, commit, discard,
  };
}
