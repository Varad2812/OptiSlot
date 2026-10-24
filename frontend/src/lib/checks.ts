import type { AllocationResult } from "@/api/hooks";

type Rep = Pick<AllocationResult["report"], "checks_passed" | "checks_total">;

/** "N rule checks" (all pass) or "P/N rule checks" — a check is a rule test, not a signal; the signal count is shown apart. */
export const ruleChecks = (r: Rep) => (r.checks_passed === r.checks_total ? `${r.checks_total} rule checks` : `${r.checks_passed}/${r.checks_total} rule checks`);

/** "0 violations · N rule checks · M signals" — the real verifier status. */
export const verifierLine = (r: Rep & { violations: number }, signals?: number | null) =>
  `${r.violations} violations · ${ruleChecks(r)}${signals != null ? ` · ${signals.toLocaleString("en-US")} signals` : ""}`;
