import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import type { components } from "@/api/types";
import { useUi } from "@/store/ui";

import { getJson, postForm, postJson, putJson } from "./client";
import { verifierLine } from "@/lib/checks";

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
export type ProjectSettings = S["ProjectSettings"];
export type ColumnMapping = S["ColumnMapping"];

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

let projectChecked = false;
/**
 * Once per session, on the first project list: a remembered project id that this database doesn't have (a fresh DB on `make demo`,
 * a stress project from yesterday) falls back to the demo project instead of leaving every page on 404s.
 */
export function useProjectFallback() {
  const { data, isSuccess } = useProjects();
  useEffect(() => {
    if (projectChecked || !isSuccess || !data?.length) return;
    projectChecked = true;
    const ui = useUi.getState();
    if (!data.some((p) => p.id === ui.projectId)) ui.setProject(data.find((p) => p.id === "demo")?.id ?? data[0].id);
  }, [data, isSuccess]);
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
      fn(`Verifier: ${rep.verdict}`, { description: verifierLine(rep) });
    },
    onError: (e) => toast.error("Verify failed", { description: String((e as Error).message) }),
  });
}

/** A new MDB / mapping / settings change re-runs the whole pipeline server-side; refetch everything derived from it. */
function refreshAll(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries();
}

export function useSettings() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["settings", pid], queryFn: () => getJson<ProjectSettings>(`/projects/${pid}/settings`) });
}

export function useImportMdb() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const f = new FormData();
      f.append("file", file);
      return postForm<ImportSummary>(`/projects/${pid}/import`, f);
    },
    onSuccess: async (sum) => {
      qc.setQueryData(["import", pid], sum);
      await refreshAll(qc);
    },
    onError: (e) => toast.error("Import failed", { description: String((e as Error).message) }),
  });
}

export function useSetMapping() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: ColumnMapping[]) => postJson<ImportSummary>(`/projects/${pid}/mapping`, m),
    onSuccess: async (sum) => {
      qc.setQueryData(["import", pid], sum);
      await refreshAll(qc);
    },
    onError: (e) => toast.error("Mapping failed", { description: String((e as Error).message) }),
  });
}

export function usePutSettings() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: ProjectSettings) => putJson<AllocationResult>(`/projects/${pid}/settings`, s),
    onSuccess: async (res) => {
      qc.setQueryData(["allocation", pid], res);
      await refreshAll(qc);
    },
    onError: (e) => toast.error("Settings failed", { description: String((e as Error).message) }),
  });
}

export function useApplyTq() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; option: number }) => postJson<AllocationResult>(`/projects/${pid}/tqs/${encodeURIComponent(v.id)}/apply?option=${v.option}`),
    onSuccess: async (res) => {
      qc.setQueryData(["allocation", pid], res);
      await refreshAll(qc);
    },
    onError: (e) => toast.error("Apply failed", { description: String((e as Error).message) }),
  });
}

export function useCloseTq() {
  const pid = useProjectId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: string }) =>
      postJson<AllocationResult>(`/projects/${pid}/tqs/${encodeURIComponent(v.id)}/close?decision=${encodeURIComponent(v.decision)}`),
    onSuccess: async (res) => {
      qc.setQueryData(["allocation", pid], res);
      await refreshAll(qc);
    },
    onError: (e) => toast.error("Close failed", { description: String((e as Error).message) }),
  });
}

export type GridRow = Record<string, string>;

/** Offline: a reduced grid rebuilt from the fixture slots (the real 76 columns come from the API). */
function rowsFromSlots(a: AllocationResult): GridRow[] {
  return a.slots.map((s, i) => ({
    "Sr. No.": String(i + 1), "Revision No": s.revision, "Tag Name": s.tag, "IO Type": s.io_type, "Signal Type": s.signal_type,
    "Electronic/ Marshalling Cabinet": s.cabinet, "CIOC/CSLS Name": s.cioc, "Baseplate": s.baseplate, "Channel_No": String(s.ch), "CHARM_No": String(s.charm_no),
    "CHARM Type": s.charm, "Charm Description": s.charm_desc, "CHARM TB Part No": s.tb, "CHARM TB Description": s.tb_desc, "CHARM TB1": s.tb1, "CHARM TB2": s.tb2, "CHARM TB3": s.tb3,
    "Field Cable No": s.cable, "Field Cable Size": s.cable_size == null ? "-" : String(s.cable_size), "Field Cable Pair": s.pair_label, "Tag Status": s.status,
    "Remarks": s.remarks, "Old Tag": s.old_tag, "Change Type": s.change_type, "Segregation": s.family,
  }));
}

/** The 76-column rows exactly as written to Excel; keyed by run so they follow every re-allocation. */
export function useRows() {
  const pid = useProjectId();
  const { data: a } = useAllocation();
  return useQuery({
    queryKey: ["rows", pid, a?.run_id],
    enabled: !!a,
    queryFn: () => getJson<GridRow[]>(`/projects/${pid}/rows`, () => rowsFromSlots(a!)),
  });
}
