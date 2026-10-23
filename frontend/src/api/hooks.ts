import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { components } from "@/api/types";
import { useUi } from "@/store/ui";

import { getJson, postJson } from "./client";

export type S = components["schemas"];
export type AllocationResult = S["AllocationResult"];
export type Slot = S["Slot"];
export type CabinetInfo = S["CabinetInfo"];
export type CiocInfo = S["CiocInfo"];
export type Project = S["Project"];
export type TQ = S["TQ"];
export type WhyStep = S["WhyStep"];
export type ImportSummary = S["ImportSummary"];
export type RuleSet = S["RuleSet"];
export type RunRecord = S["RunRecord"];
export type ExportFile = S["ExportFile"];
export type RuleCheckReport = S["RuleCheckReport"];

// Offline fallbacks: the generated fixtures (lazy, so the 1.5 MB allocation never sits in the main bundle).
const fx = {
  allocation: () => import("@/mock/allocation.json").then((m) => m.default as unknown as AllocationResult),
  project: () => import("@/mock/project.json").then((m) => m.default as unknown as Project),
  ruleset: () => import("@/mock/ruleset.json").then((m) => m.default as unknown as RuleSet),
  runs: () => import("@/mock/runs.json").then((m) => m.default as unknown as RunRecord[]),
  exports: () => import("@/mock/exports.json").then((m) => m.default as unknown as ExportFile[]),
  tqs: () => import("@/mock/tqs.json").then((m) => m.default as unknown as TQ[]),
};

/** No import fixture exists; derive a plausible summary from the project + mapping field names. */
async function importFallback(): Promise<ImportSummary> {
  const p = await fx.project();
  const fields = ["tag", "status", "io_type", "signal_type", "instrument_type", "cable", "cable_spec", "pair", "group", "family", "room", "area", "equipment", "service"];
  return {
    file: p.mdb_file ?? "MDB.xlsx", sheet: "MDB-1", header_row: 1, rows: 190, live_rows: 189, quarantined: 0, sha256: "offline",
    mapping: fields.map((f) => ({ field: f, label: f.replace(/_/g, " "), source: f, confidence: 1, required: false, overridden: false })),
    preview: [],
  };
}

export const useProjectId = () => useUi((s) => s.projectId);

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => getJson<Project[]>("/projects", async () => [await fx.project()]) });
}

export function useProject() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["project", pid], queryFn: () => getJson<Project>(`/projects/${pid}`, fx.project) });
}

export function useAllocation() {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["allocation", pid],
    queryFn: () => getJson<AllocationResult>(`/projects/${pid}/allocation`, fx.allocation),
    staleTime: Infinity,
  });
}

export function useImportSummary() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["import", pid], queryFn: () => getJson<ImportSummary>(`/projects/${pid}/import`, importFallback) });
}

export function useRules() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["rules", pid], queryFn: () => getJson<RuleSet>(`/projects/${pid}/rules`, fx.ruleset) });
}

export function useRuns() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["runs", pid], queryFn: () => getJson<RunRecord[]>(`/projects/${pid}/runs`, fx.runs) });
}

export function useExports() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["exports", pid], queryFn: () => getJson<ExportFile[]>(`/projects/${pid}/exports`, fx.exports) });
}

export function useWhy(slotId: string | null, fallback: WhyStep[] = []) {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["why", pid, slotId],
    enabled: !!slotId,
    queryFn: () => getJson<WhyStep[]>(`/projects/${pid}/slots/${slotId}/why`, () => fallback),
  });
}

export function useAllocate() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<AllocationResult>(`/projects/${pid}/allocate`),
    onSuccess: (res) => {
      qc.setQueryData(["allocation", pid], res);
      qc.invalidateQueries({ queryKey: ["runs", pid] });
      qc.invalidateQueries({ queryKey: ["project", pid] });
      toast.success(`Allocated ${res.kpis.allocated}/${res.kpis.signals} signals`, {
        description: `${res.report.violations} violations · ${res.kpis.tqs_open} open TQs · ${Math.round(res.runtime_ms)} ms`,
      });
    },
    onError: (e) => toast.error("Allocate failed", { description: String((e as Error).message) }),
  });
}

export function useVerify() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<RuleCheckReport>(`/projects/${pid}/verify`),
    onSuccess: (rep) => {
      qc.setQueryData<AllocationResult>(["allocation", pid], (a) => (a ? { ...a, report: rep } : a));
      qc.invalidateQueries({ queryKey: ["runs", pid] });
      const fn = rep.verdict === "PASS" ? toast.success : toast.error;
      fn(`Verifier: ${rep.verdict}`, { description: `${rep.violations} violations · ${rep.checks_passed}/${rep.checks_total} checks` });
    },
    onError: (e) => toast.error("Verify failed", { description: String((e as Error).message) }),
  });
}
