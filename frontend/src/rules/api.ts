import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { deleteJson, getJson, postJson, putJson } from "@/api/client";
import { useProjectId, type AllocationResult, type RuleSet, type S } from "@/api/hooks";

// Rules Studio API (docs/api_workbench.md §5) — the types are generated from the backend schema.
export type RuleView = S["RuleView"];
export type RuleListing = S["RuleListing"];
export type RuleCatalogue = S["RuleCatalogue"];
export type RuleTypeInfo = S["RuleTypeInfo"];
export type ParamSpec = S["ParamSpec"];
export type RuleChange = S["RuleChange"];
export type RuleInput = S["RuleInput"];
export type RuleEdit = S["RuleEdit"];
export type RulePreviewRequest = S["RulePreviewRequest"];
export type Severity = "hard" | "soft";
export type Params = Record<string, unknown>;

export interface RuleVersion {
  version: number;
  ts: string;
  note: string;
}

/** What the user has changed on one rule and not saved yet. */
export type Pending =
  | { kind: "edit"; id: string; edit: RuleEdit }
  | { kind: "delete"; id: string };

/** Offline: the listing rebuilt from the generated rule-set fixture (no verifier results, no editing). */
async function listingFallback(): Promise<RuleListing> {
  const rs = (await import("@/mock/ruleset.json").then((m) => m.default)) as unknown as RuleSet;
  return {
    project_id: "demo", version: rs.version, settings: rs.settings ?? ({} as RuleListing["settings"]),
    rules: rs.rules.map((r) => ({
      id: r.id, type: r.type, label: r.label, enabled: r.enabled, severity: r.severity, params: (r.params ?? {}) as Params, custom: false,
      mode: !r.enabled ? "off" : r.severity === "hard" ? "enforced" : "advisory", summary: "", check_ids: [], passed: 0, failed: 0, excepted: 0,
    })),
  };
}

export function useRuleListing() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["rule-listing", pid], queryFn: () => getJson<RuleListing>(`/projects/${pid}/rules/listing`, listingFallback) });
}

export function useRuleCatalogue() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["rule-catalogue", pid], queryFn: () => getJson<RuleCatalogue>(`/projects/${pid}/rule-types`), staleTime: Infinity, retry: false });
}

export function useRuleVersions() {
  const pid = useProjectId();
  return useQuery({ queryKey: ["rule-versions", pid], queryFn: () => getJson<RuleVersion[]>(`/projects/${pid}/rules/versions`, () => []) });
}

const requestOf = (p: Pending): RulePreviewRequest =>
  p.kind === "edit" ? { action: "update", rule_id: p.id, edit: p.edit, force: false } : { action: "delete", rule_id: p.id, force: false };

/** The what-if of a change. Nothing is stored; the numbers equal what Save will give. `req` null = idle. */
export function useRulePreview(req: RulePreviewRequest | null) {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["rule-preview", pid, req],
    queryFn: () => postJson<RuleChange>(`/projects/${pid}/rules/preview`, req),
    enabled: !!req,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  });
}
export const previewRequestOf = requestOf;

/** A saved change re-runs allocate + verify on the server: refetch everything derived from it. */
function useAfterSave() {
  const qc = useQueryClient();
  const pid = useProjectId();
  return async (alloc?: AllocationResult) => {
    if (alloc) qc.setQueryData(["allocation", pid], alloc);
    await qc.invalidateQueries();
  };
}

export function useSaveRule() {
  const pid = useProjectId();
  const after = useAfterSave();
  return useMutation({
    mutationFn: (v: { pending: Pending } | { add: RuleInput }) => {
      if ("add" in v) return postJson<RuleChange>(`/projects/${pid}/rules`, v.add);
      const p = v.pending;
      return p.kind === "edit"
        ? putJson<RuleChange>(`/projects/${pid}/rules/${encodeURIComponent(p.id)}`, p.edit)
        : deleteJson<RuleChange>(`/projects/${pid}/rules/${encodeURIComponent(p.id)}`);
    },
    onSuccess: (res) => after().then(() => res),
  });
}

export function useUndoRule() {
  const pid = useProjectId();
  const after = useAfterSave();
  return useMutation({
    mutationFn: () => postJson<AllocationResult>(`/projects/${pid}/undo`),
    onSuccess: (alloc) => after(alloc).then(() => toast.success("Undone", { description: "Previous rule set restored and re-verified." })),
    onError: (e) => toast.error("Nothing to undo", { description: String((e as Error).message) }),
  });
}
