import { History, Loader2, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  previewRequestOf, useRuleCatalogue, useRuleListing, useRulePreview, useRuleVersions, useSaveRule, useUndoRule,
  type Pending, type RuleEdit, type RuleView,
} from "@/rules/api";
import { Impact } from "@/rules/Impact";
import { RuleCard, type Draft } from "@/rules/RuleCard";
import { diffParams } from "@/rules/fields";
import { fmtTs, labelOf, summariseValue } from "@/rules/text";
import { useDebounced } from "@/rules/useDebounced";

/** The edit that turns `rule` into the draft — only what really differs, so a toggled-back change is no change at all. */
function editOf(rule: RuleView, d: Draft, reason: string): RuleEdit | null {
  const e: RuleEdit = { replace_params: false, reason, who: "engineer" };
  let any = false;
  if (d.enabled !== undefined && d.enabled !== rule.enabled) (e.enabled = d.enabled), (any = true);
  if (d.severity !== undefined && d.severity !== rule.severity) (e.severity = d.severity), (any = true);
  const pd = d.params ? diffParams(rule.params, d.params) : {};
  if (Object.keys(pd).length) (e.params = pd), (any = true);
  return any ? e : null;
}

/** One line per change, for the dock: `Target 10 → 20 %`. */
function changeLines(rule: RuleView, e: RuleEdit): string[] {
  const out: string[] = [];
  if (e.enabled !== undefined) out.push(e.enabled ? "Switch on" : "Switch off");
  if (e.severity) out.push(`Severity ${rule.severity} → ${e.severity}`);
  for (const [k, v] of Object.entries(e.params ?? {})) out.push(`${labelOf(k)} ${summariseValue(rule.params[k])} → ${summariseValue(v)}`);
  return out;
}

export default function Rules() {
  const listing = useRuleListing();
  const cat = useRuleCatalogue();
  const versions = useRuleVersions();
  const undo = useUndoRule();
  const save = useSaveRule();

  const [draft, setDraft] = useState<{ id: string; d: Draft } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const fresh: string | null = null;

  const rules = listing.data?.rules ?? [];
  const enforced = rules.filter((r) => r.mode === "enforced").length;
  const types = cat.data?.types ?? [];
  const rule = draft ? rules.find((r) => r.id === draft.id) : undefined;
  const target = del ? rules.find((r) => r.id === del) : undefined;

  const pending: Pending | null = useMemo(() => {
    if (del && target) return { kind: "delete", id: del };
    if (draft && rule) {
      const e = editOf(rule, draft.d, reason);
      return e ? { kind: "edit", id: rule.id, edit: e } : null;
    }
    return null;
  }, [draft, rule, del, target, reason]);

  // the what-if re-runs allocate + verify on the server: debounce so typing "2","0" is one request
  const req = useMemo(() => (pending ? previewRequestOf(pending) : null), [pending]);
  const debounced = useDebounced(req, 450);
  const preview = useRulePreview(debounced);
  const settled = JSON.stringify(debounced) === JSON.stringify(req);
  const loading = !!req && (!settled || preview.isFetching);
  const err = req && settled && preview.error ? (preview.error instanceof ApiError ? preview.error.message : preview.error.message) : null;
  const change = req && !preview.error ? preview.data : undefined;
  const canSave = !!pending && settled && !loading && !err && !!change?.allowed && !save.isPending;

  const discard = () => (setDraft(null), setDel(null), setReason(""), setSaveErr(null));

  function edit(r: RuleView, d: Draft) {
    setSaveErr(null);
    setDraft({ id: r.id, d });
  }

  async function doSave() {
    if (!pending) return;
    setSaveErr(null);
    try {
      const res = await save.mutateAsync({ pending: pending.kind === "edit" ? { ...pending, edit: { ...pending.edit, reason } } : pending });
      if (!res.stored) return setSaveErr(res.messages?.join(" ") || "Nothing was stored.");
      discard();
      toast.success(`Saved — rule set v${res.ruleset_version}`, {
        description: res.messages?.[0],
        action: { label: "Undo", onClick: () => undo.mutate() },
        duration: 8000,
      });
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  }

  const sub = `${rules.length} rules · ${enforced} enforced · every change re-runs the verifier`;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rules-studio">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-border px-6 pb-4 pt-6">
        <div>
          <h1 className="text-page">Rules Studio</h1>
          <p className="mt-1 text-muted-foreground" data-testid="rules-sub">{listing.data ? `${sub}.` : "Rules are data — edit them live; the independent verifier re-checks every change."}</p>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          {listing.data && <span className="rounded-chip border border-border bg-raised px-2.5 py-1 font-mono text-muted-foreground">rule set v{listing.data.version} · {listing.data.settings?.cioc_strategy ?? "balanced"}</span>}
          <Button variant="outline" size="sm" className="gap-1.5" disabled={undo.isPending || (versions.data?.length ?? 0) < 2} onClick={() => undo.mutate()} data-testid="rules-undo">
            {undo.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}Undo last change
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(380px,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {listing.isLoading && <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}</div>}
            {listing.isError && <p className="card-surface p-4 text-err" role="alert">Could not load the rules: {listing.error.message}</p>}
            <div className="space-y-2.5">
              {rules.map((r) => {
                const d = draft?.id === r.id ? draft.d : undefined;
                return (
                  <div key={r.id} className={cn(fresh === r.id && "animate-[fadein_.6s_ease-out]")}>
                    <RuleCard
                      rule={r} info={types.find((t) => t.type === r.type)} fields={cat.data?.filter_fields ?? []}
                      draft={d} locked={!!pending && pending.id !== r.id} pendingDelete={del === r.id}
                      onChange={(nd) => edit(r, nd)} onDelete={() => (setDraft(null), setDel(r.id), setSaveErr(null))}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {pending && (
            <section className="shrink-0 border-t border-brand/40 bg-surface/95 px-6 py-3.5 shadow-[0_-12px_32px_-12px_rgb(0_0_0/.45)] backdrop-blur-md" data-testid="rules-dock" aria-label="Pending rule change">
              <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="label-caps">{pending.kind === "delete" ? "Delete rule" : "Unsaved change"}</span>
                <span className="font-mono text-[12px]">{pending.id}</span>
                {pending.kind === "edit" && rule && changeLines(rule, pending.edit).map((l) => <span key={l} className="rounded-chip border border-brand/40 bg-brand/10 px-2 py-px text-[12px]">{l}</span>)}
                {pending.kind === "delete" && <span className="text-[12px] text-muted-foreground">its constraint is removed and the project is re-allocated</span>}
              </div>
              <Impact change={change} loading={loading} error={err} />
              {saveErr && <div role="alert" className="mt-2 rounded-chip border border-err/50 bg-err/10 px-3 py-2 text-[12.5px] text-err" data-testid="rule-save-error">{saveErr}</div>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (goes in the decision log)" aria-label="Reason"
                  className="h-8 min-w-[220px] flex-1 rounded-chip border border-border bg-raised/60 px-2 text-[12.5px] outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40"
                />
                <Button variant="outline" size="sm" onClick={discard} data-testid="rules-discard">Discard</Button>
                <Button size="sm" disabled={!canSave} onClick={() => void doSave()} className="gap-1.5" data-testid="rules-save">
                  {save.isPending && <Loader2 className="size-3.5 animate-spin" />}{pending.kind === "delete" ? "Delete rule" : "Save as new version"}
                </Button>
              </div>
            </section>
          )}
        </div>

        <aside className="min-h-0 space-y-4 overflow-y-auto border-t border-border bg-surface/30 p-4 xl:border-l xl:border-t-0" aria-label="Add a rule and history">
          <Versions />
        </aside>
      </div>
    </div>
  );
}

function Versions() {
  const { data, isLoading } = useRuleVersions();
  const list = [...(data ?? [])].reverse();
  return (
    <section className="card-surface p-4" data-testid="rule-versions">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold"><History className="size-4 text-brand" />Rule-set versions</h2>
      <p className="mt-0.5 text-[12px] text-muted-foreground">Every save is a new version and a decision-log entry. Undo steps back one.</p>
      {isLoading && <Skeleton className="mt-3 h-20 w-full" />}
      <ol className="mt-3 space-y-1.5">
        {list.slice(0, 12).map((v, i) => (
          <li key={v.version} className={cn("flex gap-2.5 rounded-chip border px-2.5 py-2", i === 0 ? "border-brand/40 bg-brand/[0.06]" : "border-border bg-raised/30")}>
            <span className="font-mono text-[12px] font-semibold tnum">v{v.version}</span>
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[12px] leading-snug" title={v.note}>{v.note}</div>
              <div className="text-[11px] text-muted-foreground">{fmtTs(v.ts)}{i === 0 && <span className="ml-2 text-brand">current</span>}</div>
            </div>
          </li>
        ))}
        {!isLoading && !list.length && <li className="text-[12.5px] text-muted-foreground">No versions yet.</li>}
        {list.length > 12 && <li className="px-1 text-[11.5px] text-muted-foreground">+{list.length - 12} older</li>}
      </ol>
    </section>
  );
}
