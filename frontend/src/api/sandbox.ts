import { useQuery } from "@tanstack/react-query";

import type { AllocationResult, RuleSet, S } from "@/api/hooks";
import { useProjectId } from "@/api/hooks";

import { getJson, postForm, postJson, putJson } from "./client";

export type Move = S["Move"];
export type WhatIfRequest = S["WhatIfRequest"];
export type WhatIfResult = S["WhatIfResult"];
export type RevisionImpact = S["RevisionImpact"];
export type MoveItem = S["MoveItem"];

// What-if previews never commit; commit / undo / redo replay on the server (stored as inputs, so a restart reproduces them).
export const whatIf = (pid: string, req: WhatIfRequest) => postJson<WhatIfResult>(`/projects/${pid}/whatif`, req);
export const commitReq = (pid: string, req: WhatIfRequest) => postJson<AllocationResult>(`/projects/${pid}/commit`, req);
export const undoReq = (pid: string) => postJson<AllocationResult>(`/projects/${pid}/undo`);
export const redoReq = (pid: string) => postJson<AllocationResult>(`/projects/${pid}/redo`);
export const putRules = (pid: string, rs: RuleSet, why: string) =>
  putJson<AllocationResult>(`/projects/${pid}/rules?why=${encodeURIComponent(why)}`, rs);

// Revisions
export const gauntletReq = (pid: string) => postJson<RevisionImpact>(`/projects/${pid}/revisions/gauntlet`);
export const uploadRevisionReq = (pid: string, file: File) => {
  const f = new FormData();
  f.append("file", file);
  return postForm<RevisionImpact>(`/projects/${pid}/revisions`, f);
};

export function useRevisionImpact() {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["impact", pid],
    queryFn: () =>
      getJson<RevisionImpact | null>(`/projects/${pid}/revisions/impact`, () =>
        import("@/mock/revision_impact.json").then((m) => m.default as unknown as RevisionImpact),
      ),
    staleTime: Infinity,
  });
}

// Signal Workbench sandbox (docs/api_workbench.md §3): the working state against the committed base — drives the 3D Before | Now.
export type PlacementChangeSet = S["PlacementChangeSet"];
export type PlacementMove = S["PlacementMove"];

/** Polled while the 3D Room is open, so a move applied in the Workbench shows up (and animates) without a reload. */
export function usePlacementChanges() {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["placement-changes", pid],
    queryFn: () => getJson<PlacementChangeSet>(`/projects/${pid}/placement/changes`),
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 1500,
  });
}
