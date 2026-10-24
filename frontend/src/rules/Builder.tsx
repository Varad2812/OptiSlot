import { Loader2, Plus, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { cn } from "@/lib/utils";

import { useRuleCatalogue, useRulePreview, useSaveRule, type Params, type RuleInput, type RuleTypeInfo, type Severity } from "./api";
import { ParamField, Seg } from "./fields";
import { Impact } from "./Impact";
import { missingParams, sentence } from "./text";
import { useDebounced } from "./useDebounced";

const defaults = (info: RuleTypeInfo): Params => {
  const p: Params = {};
  for (const s of info.params ?? []) {
    if (s.kind === "filter") p[s.name] = {}; // no condition = every signal
    else if (s.default != null && s.kind !== "io_types" && s.kind !== "cabinets") p[s.name] = s.default;
  }
  if (info.type === "extra_spares") delete p.extra_pct;
  return p;
};

/** "Add custom rule": pick a template, fill the form the backend's parameter schema describes, read it in English, preview, add. */
export function Builder({ onAdded }: { onAdded: (id: string) => void }) {
  const cat = useRuleCatalogue();
  const types = useMemo(() => cat.data?.types.filter((t) => t.custom) ?? [], [cat.data]);
  const [type, setType] = useState<string>("");
  const info = types.find((t) => t.type === type);
  const [params, setParams] = useState<Params>({});
  const [label, setLabel] = useState("");
  const [severity, setSeverity] = useState<Severity>("hard");
  const save = useSaveRule();
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (!type && types.length) pick(types[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.length]);

  function pick(t: RuleTypeInfo) {
    setType(t.type);
    setParams(defaults(t));
    setLabel("");
    setSaveErr(null);
  }

  const english = info ? sentence(info.type, params, info) : "";
  const missing = info ? missingParams(info, params) : [];
  const input: RuleInput | null = info
    ? { type: info.type as RuleInput["type"], label: label.trim() || english.replace(/\s+/g, " ").slice(0, 110), params, severity, enabled: true, reason: "", who: "engineer" }
    : null;
  const req = useMemo(() => (input && !missing.length ? { action: "add" as const, rule: input, force: false } : null), [JSON.stringify(input), missing.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const debounced = useDebounced(req, 500);
  const preview = useRulePreview(debounced);
  const settled = JSON.stringify(debounced) === JSON.stringify(req);
  const loading = !!req && (!settled || preview.isFetching);
  const error = req && settled && preview.error ? (preview.error instanceof ApiError ? preview.error.message : String(preview.error.message)) : null;
  const change = req && !preview.error ? preview.data : undefined;
  const canAdd = !!input && !missing.length && !loading && !!change?.allowed && !error && !save.isPending;

  async function add() {
    if (!input) return;
    setSaveErr(null);
    try {
      const res = await save.mutateAsync({ add: input });
      if (!res.stored) return setSaveErr(res.messages?.join(" ") || "The rule was not stored.");
      toast.success(`Rule ${res.rule_id} added`, { description: `Rule set v${res.ruleset_version} · ${res.messages?.[0] ?? "re-verified"}` });
      onAdded(res.rule_id);
      pick(info!);
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  }

  return (
    <section className="card-surface p-4" data-testid="rule-builder" aria-label="Add custom rule">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold"><Plus className="size-4 text-brand" />Add custom rule</h2>
      <p className="mt-0.5 text-[12px] text-muted-foreground">Rules are data. Pick a template, say which signals it covers — it is previewed against the real project before anything is stored.</p>

      {cat.isLoading && <div className="mt-4 text-[12.5px] text-muted-foreground"><Loader2 className="mr-1.5 inline size-3.5 animate-spin" />Loading rule templates…</div>}
      {cat.isError && <p className="mt-4 rounded-chip border border-dashed border-border p-3 text-[12.5px] text-muted-foreground">The rule-template catalogue needs the backend (GET /api/rule-types), which is not answering.</p>}

      {types.length > 0 && (
        <div className="mt-3.5 space-y-4">
          <div>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Template">
              {types.map((t) => (
                <button
                  key={t.type} type="button" role="radio" aria-checked={type === t.type} onClick={() => pick(t)} title={t.description}
                  className={cn("rounded-chip border px-2.5 py-2 text-left text-[12.5px] font-medium leading-snug transition-colors", type === t.type ? "border-brand/60 bg-brand/10" : "border-border bg-raised/40 text-muted-foreground hover:border-brand/30 hover:text-text")}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {info && <p className="mt-2 text-[12px] leading-snug text-muted-foreground">{info.description}</p>}
          </div>

          {info && (
            <>
              <div className="space-y-3.5 border-t border-border pt-3.5">
                {info.params?.map((s) => (
                  <ParamField key={`${info.type}.${s.name}`} spec={s} value={params[s.name]} fields={cat.data!.filter_fields} onChange={(v) => setParams((p) => ({ ...p, [s.name]: v }))} />
                ))}
                <div className="space-y-1">
                  <label className="text-[12px] font-medium" htmlFor="rule-label">Name <span className="font-normal text-muted-foreground">optional — defaults to the sentence below</span></label>
                  <input id="rule-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. FT signals only in cabinet 04" className="h-8 w-full rounded-chip border border-border bg-raised/60 px-2 text-[12.5px] outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-medium">Severity</span>
                  <Seg label="Severity" value={severity} onChange={setSeverity} options={[{ v: "hard", label: "Blocking" }, { v: "soft", label: "Warning" }]} />
                </div>
              </div>

              <div className="rounded-chip border border-brand/30 bg-brand/[0.07] px-3 py-2.5" data-testid="rule-sentence" aria-live="polite">
                <div className="label-caps mb-1 flex items-center gap-1.5"><Sparkles className="size-3 text-brand" />In plain English</div>
                <p className="text-[13px] leading-snug">{english}</p>
                <p className="mt-1 text-[11.5px] text-muted-foreground">{severity === "hard" ? "Blocking: the allocator keeps it and the verifier fails the run if it is broken." : "Warning: the verifier reports it; nothing is blocked."}</p>
              </div>

              {missing.length > 0 ? (
                <p className="text-[12px] text-muted-foreground">Fill in <span className="font-mono text-text">{missing.join(", ")}</span> to preview the impact.</p>
              ) : (
                <>
                  <Impact change={change} loading={loading} error={error} compact />
                  {change?.rule && change.rule.summary && (
                    <p className="text-[11.5px] text-muted-foreground">The verifier reads it as <span className="font-mono text-text">{change.rule.summary}</span>{change.rule.check_ids?.length ? <> and tests it as <span className="font-mono text-text">{change.rule.check_ids.join(", ")}</span></> : null}.</p>
                  )}
                </>
              )}

              {saveErr && <div role="alert" className="rounded-chip border border-err/50 bg-err/10 px-3 py-2 text-[12.5px] text-err" data-testid="rule-save-error">{saveErr}</div>}
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => info && pick(info)} className="flex items-center gap-1.5 rounded-chip px-2 py-1.5 text-[12px] text-muted-foreground hover:text-text"><RotateCcw className="size-3.5" />Reset</button>
                <button
                  type="button" disabled={!canAdd} onClick={() => void add()} data-testid="rule-add"
                  className="inline-flex h-9 items-center gap-2 rounded-chip bg-gradient-to-br from-brand to-[#5b3fe0] px-4 text-[13px] font-semibold text-white shadow-[0_0_18px_-4px_rgb(var(--brand)/.7)] transition-[opacity,filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                >
                  {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}Add rule
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
