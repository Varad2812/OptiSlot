import { ChevronDown, Lock, Trash2 } from "lucide-react";
import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type { Params, RuleTypeInfo, RuleView, Severity } from "./api";
import { NumberInput, ParamField, Seg } from "./fields";
import { paramMetas } from "./text";

export interface Draft {
  enabled?: boolean;
  severity?: Severity;
  params?: Params;
}

const MODE = {
  enforced: { label: "Enforced", cls: "border-brand/50 bg-brand/15 text-text" },
  advisory: { label: "Advisory", cls: "border-warn/50 bg-warn/10 text-warn" },
  off: { label: "Off", cls: "border-border bg-raised text-muted-foreground" },
} as const;

export const modeOf = (enabled: boolean, severity: Severity) => (!enabled ? "off" : severity === "hard" ? "enforced" : "advisory");

export function RuleCard({ rule, info, fields, draft, locked, pendingDelete, onChange, onDelete }: {
  rule: RuleView; info?: RuleTypeInfo; fields: string[]; draft?: Draft; locked: boolean; pendingDelete: boolean;
  onChange: (d: Draft) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showFixed, setShowFixed] = useState(false);
  const enabled = draft?.enabled ?? rule.enabled;
  const severity = draft?.severity ?? rule.severity;
  const params: Params = { ...rule.params, ...draft?.params };
  const mode = modeOf(enabled, severity);
  const dirty = !!draft && (draft.enabled !== undefined || draft.severity !== undefined || !!draft.params);
  const all = rule.custom ? [] : paramMetas(params);
  const metas = all.filter((m) => m.editor !== "readonly");
  const fixed = all.filter((m) => m.editor === "readonly");
  const desc = rule.custom ? rule.summary : "";
  const set = (patch: Draft) => onChange({ ...draft, ...patch, params: patch.params ? { ...draft?.params, ...patch.params } : draft?.params });
  const specs = info?.params ?? [];
  const ran = rule.passed + rule.failed + rule.excepted;

  return (
    <article
      data-testid={`rule-${rule.id}`}
      data-mode={mode}
      className={cn(
        "card-surface relative p-4 transition-[border-color,opacity,box-shadow] duration-200 hover:border-brand/40",
        dirty && "border-brand/60 shadow-[0_0_0_1px_rgb(var(--brand)/.35),0_0_24px_-8px_rgb(var(--brand)/.5)]",
        pendingDelete && "border-err/60 opacity-70",
        locked && "opacity-55",
        mode === "off" && !dirty && "opacity-80",
      )}
    >
      <div className="flex items-start gap-3">
        <Switch checked={enabled} disabled={locked} onCheckedChange={(v) => set({ enabled: v })} aria-label={`${rule.label} on or off`} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[13.5px] font-semibold leading-snug">{rule.label}</h3>
            {dirty && <span className="rounded-[4px] bg-brand/20 px-1.5 py-px text-[10.5px] font-medium text-text">edited</span>}
          </div>
          {desc && <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{desc}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="rounded-chip border border-border bg-raised px-1.5 py-px font-mono text-[11px] text-muted-foreground" title="Rule id">{rule.id}</span>
            <span className={cn("rounded-chip border px-2 py-px text-[11px] font-semibold", MODE[mode].cls)} data-testid="rule-mode">{MODE[mode].label}</span>
          </div>
          <Seg
            label="Severity" value={severity} disabled={locked}
            options={[{ v: "hard", label: "Hard" }, { v: "soft", label: "Soft" }]} onChange={(v) => set({ severity: v })}
          />
        </div>
      </div>

      {metas.length > 0 && (
        <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3">
          {metas.map((m) => (
            <div key={m.name} className="flex items-center gap-2">
              <dt className="text-[12px] text-muted-foreground">{m.label}</dt>
              <dd className="flex items-center gap-1.5">
                {m.editor === "number" ? (
                  <>
                    <NumberInput label={`${rule.id} ${m.label}`} value={params[m.name] as number} min={m.min} max={m.max} step={m.step} disabled={locked}
                      onChange={(v) => v !== undefined && set({ params: { [m.name]: v } })} />
                    {m.unit && <span className="text-[12px] text-muted-foreground">{m.unit}</span>}
                  </>
                ) : m.editor === "bool" ? (
                  <Switch checked={!!params[m.name]} disabled={locked} onCheckedChange={(v) => set({ params: { [m.name]: v } })} aria-label={`${rule.id} ${m.label}`} />
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {fixed.length > 0 && (
        <div className={cn("pt-2.5", metas.length ? "" : "mt-3 border-t border-border")}>
          <button type="button" onClick={() => setShowFixed(!showFixed)} aria-expanded={showFixed} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-text">
            <ChevronDown className={cn("size-3.5 transition-transform", !showFixed && "-rotate-90")} />Other parameters <span className="tnum">({fixed.length})</span>
          </button>
          {showFixed && (
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
              {fixed.map((m) => (
                <div key={m.name} className="flex items-center gap-2">
                  <dt className="text-[12px] text-muted-foreground">{m.label}</dt>
                  <dd className="max-w-[260px] truncate rounded-chip border border-border bg-raised/60 px-2 py-0.5 font-mono text-[11.5px] text-muted-foreground" title={m.display}>{m.display}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {rule.custom && specs.length > 0 && (
        <div className="mt-3 border-t border-border pt-2.5">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-text">
            <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />Parameters
          </button>
          {open && (
            <div className="mt-2.5 grid gap-3.5">
              {specs.map((s) => (
                <ParamField key={s.name} spec={s} value={params[s.name]} fields={fields} disabled={locked} onChange={(v) => set({ params: { [s.name]: v } })} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2.5 text-[11.5px] text-muted-foreground">
        <span className="label-caps">Verifier</span>
        {(rule.check_ids ?? []).length ? (
          <span className="flex gap-1">{rule.check_ids!.map((c) => <span key={c} className="rounded-chip border border-border bg-raised px-1.5 py-px font-mono text-text">{c}</span>)}</span>
        ) : (
          <span>{rule.enabled ? "no verifier check" : "not checked while off"}</span>
        )}
        {ran > 0 && (
          <span className="tnum">
            <b className="text-ok">{rule.passed}</b> pass
            {rule.failed > 0 && <> · <b className="text-err">{rule.failed}</b> fail</>}
            {rule.excepted > 0 && <> · <b className="text-warn">{rule.excepted}</b> excepted by TQ</>}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {locked && <span className="flex items-center gap-1"><Lock className="size-3" />save or discard the pending change first</span>}
          {rule.custom && (
            <button type="button" disabled={locked} onClick={onDelete} className="flex items-center gap-1 rounded-chip px-1.5 py-0.5 hover:bg-err/10 hover:text-err disabled:opacity-50" aria-label={`Delete ${rule.id}`}>
              <Trash2 className="size-3.5" />Delete
            </button>
          )}
        </span>
      </div>
    </article>
  );
}
