import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { getJson, postJson } from "@/api/client";
import type { AllocationResult, RuleCheckReport } from "@/api/hooks";
import { useProjectId } from "@/api/hooks";
import { gauntletReq, uploadRevisionReq, type RevisionImpact } from "@/api/sandbox";
import { useUi } from "@/store/ui";

export type FlowPhase = "idle" | "injecting" | "verifying";

/**
 * Inject Rev B (the deterministic gauntlet) or upload your own, then refresh everything and re-verify automatically.
 * Rev A's allocation is parked in the query cache (["revA", pid]) so the diff can show each slot's old look.
 */
export function useRevisionFlow() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<FlowPhase>("idle");
  const [verified, setVerified] = useState<RuleCheckReport | null>(null);

  const run = useCallback(
    async (source: "gauntlet" | File): Promise<{ impact: RevisionImpact; alloc: AllocationResult } | null> => {
      setPhase("injecting");
      setVerified(null);
      try {
        const before = qc.getQueryData<AllocationResult>(["allocation", pid]);
        if (before && before.revision === "A") qc.setQueryData(["revA", pid], before);
        let impact: RevisionImpact;
        let alloc: AllocationResult;
        try {
          impact = source === "gauntlet" ? await gauntletReq(pid) : await uploadRevisionReq(pid, source);
          alloc = await getJson<AllocationResult>(`/projects/${pid}/allocation`);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e; // a real API error is shown; only an unreachable API falls back to the fixtures
          useUi.getState().setOffline(true);
          impact = (await import("@/mock/revision_impact.json")).default as unknown as RevisionImpact;
          alloc = (await import("@/mock/allocation_revb.json")).default as unknown as AllocationResult;
        }
        qc.setQueryData(["impact", pid], impact);
        qc.setQueryData(["allocation", pid], alloc);
        qc.invalidateQueries({ predicate: (q) => !["allocation", "impact", "revA"].includes(q.queryKey[0] as string) });
        setPhase("verifying");
        void postJson<RuleCheckReport>(`/projects/${pid}/verify`)
          .then((rep) => {
            setVerified(rep);
            qc.setQueryData<AllocationResult>(["allocation", pid], (a) => (a ? { ...a, report: rep } : a));
          })
          .catch(() => setVerified(alloc.report))
          .finally(() => setPhase("idle"));
        return { impact, alloc };
      } catch (e) {
        setPhase("idle");
        toast.error("Revision failed", { description: (e as Error).message });
        return null;
      }
    },
    [pid, qc],
  );

  return { phase, run, verified, busy: phase !== "idle" };
}
