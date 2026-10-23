import type { WorldModel } from "@/api/derive";
import type { AllocationResult, RuleCheckReport, Slot, S } from "@/api/hooks";

// Verify scan (CLAUDE.md §10.4.3). One progress value p∈[0,1] drives the cyan beam, every check tick, the counters and the
// certificate stamp, so Playwright can freeze it at any point and "any key" can skip to the end.
export const SCAN_S = 2.2;
export const SCAN_CALM_S = 0.5;
export const BEAM: [number, number] = [0.04, 0.62];
export const STAMP: [number, number] = [0.64, 0.86];
export const TICKS_FROM = 0.1;
const TICKS_BY = 0.56;
const STEP_S = 0.04; // 40 ms between ticks

/** Progress at which check i of n ticks: 40 ms apart, compressed only if there are so many checks that they would run into the stamp. */
export function tickAt(i: number, n: number) {
  const step = Math.min(STEP_S / SCAN_S, (TICKS_BY - TICKS_FROM) / Math.max(1, n));
  return TICKS_FROM + i * step;
}
export const lastTick = (n: number) => tickAt(Math.max(0, n - 1), n);

export type CheckResult = S["CheckResult"];
export type Violation = S["Violation"];

export interface Fail {
  key: string;
  check: CheckResult;
  v: Violation;
  slot: Slot | null;
}

const squash = (t: string) => t.replace(/\s+/g, "");

/** Index of tag → slot for the fallbacks (a violation may carry only a tag, or only an Excel row). Built once per allocation. */
export function tagIndex(a: AllocationResult) {
  const m = new Map<string, Slot>();
  for (const s of a.slots) if (s.status !== "Spare Slot" && s.tag && s.tag !== "-") m.set(squash(s.tag), s);
  return m;
}

/** Where on the plant does a violation live? slot_id first, then the tag, then the Excel row (row 2 = first slot; the export keeps engine order). */
export function resolveSlot(v: Violation, a: AllocationResult, model: WorldModel, tags: Map<string, Slot>): Slot | null {
  if (v.slot_id) {
    const s = model.bySlotId.get(v.slot_id);
    if (s) return s;
  }
  if (v.tag) {
    const s = tags.get(squash(v.tag));
    if (s) return s;
  }
  if (v.row != null) {
    const s = a.slots[v.row - 2];
    if (s && (!v.tag || squash(s.tag) === squash(v.tag))) return s;
  }
  return null;
}

/** Violations (or TQ exceptions) of one check, each mapped to its slot. Capped: a wholly wrong file can fail thousands of rows. */
export function listFor(check: CheckResult, which: "violations" | "exceptions", a: AllocationResult, model: WorldModel, tags: Map<string, Slot>, cap = 300): Fail[] {
  const mark = which === "violations" ? "" : "x";
  return (check[which] ?? []).slice(0, cap).map((v, i) => ({ key: `${check.id}/${mark}${i}`, check, v, slot: resolveSlot(v, a, model, tags) }));
}

/** Every violation of a report in check order (the camera and the red markers use this), with the uncapped total. */
export function collectFails(rep: RuleCheckReport, a: AllocationResult, model: WorldModel, tags: Map<string, Slot>, cap = 300) {
  const fails: Fail[] = [];
  let total = 0;
  for (const check of rep.checks) {
    total += check.violations?.length ?? 0;
    if (fails.length < cap) fails.push(...listFor(check, "violations", a, model, tags, cap - fails.length));
  }
  return { fails, total };
}

/** The slot the camera flies to: the first failing one that is on the plant. */
export const firstFlyable = (fails: Fail[]) => fails.find((f) => f.slot);
