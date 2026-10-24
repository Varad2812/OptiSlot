import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import type { ParamSpec, Params } from "./api";
import { filterText, humanise, parseCabinets, type Filter } from "./text";

const box = "h-8 rounded-chip border border-border bg-raised/60 px-2 text-[12.5px] text-text outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-brand/60 focus:ring-1 focus:ring-brand/40 disabled:opacity-50";

export function Seg<T extends string>({ value, options, onChange, disabled, label }: { value: T | undefined; options: { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-chip border border-border bg-raised/60 p-0.5", disabled && "opacity-50")}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn("rounded-[4px] px-2.5 py-1 text-[12px] font-medium transition-colors", value === o.v ? "bg-brand/20 text-text shadow-[inset_0_0_0_1px_rgb(var(--brand)/.45)]" : "text-muted-foreground hover:text-text")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, options, onChange, placeholder, disabled, label, className }: { value: string; options: string[]; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; label: string; className?: string }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(box, "pr-6 font-mono", className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/** A number box that lets the user type freely ("1." , "") and only reports finished numbers. */
export function NumberInput({ value, onChange, min, max, step, disabled, label, width = "w-[72px]" }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; disabled?: boolean; label: string; width?: string }) {
  const [txt, setTxt] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setTxt((t) => (Number(t) === value && t !== "" ? t : value == null ? "" : String(value)));
  }, [value]);
  return (
    <input
      type="number" inputMode="decimal" aria-label={label} disabled={disabled} min={min} max={max} step={step}
      value={txt}
      onChange={(e) => {
        setTxt(e.target.value);
        onChange(e.target.value === "" || Number.isNaN(Number(e.target.value)) ? undefined : Number(e.target.value));
      }}
      className={cn(box, "text-right font-mono tnum", width)}
    />
  );
}

// ───── filter editor ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Cond { field: string; text: string }
const toConds = (f: unknown): Cond[] =>
  f && typeof f === "object" ? Object.entries(f as Filter).filter(([k]) => k !== "not" && k !== "any").map(([field, v]) => ({ field, text: Array.isArray(v) ? v.join(", ") : String(v ?? "") })) : [];
const fromConds = (cs: Cond[]): Filter =>
  Object.fromEntries(cs.filter((c) => c.field && c.text.trim()).map((c) => {
    const vals = c.text.split(",").map((x) => x.trim()).filter(Boolean);
    return [c.field, vals.length === 1 ? vals[0] : vals];
  }));

function CondRows({ conds, fields, onChange, disabled, label }: { conds: Cond[]; fields: string[]; onChange: (c: Cond[]) => void; disabled?: boolean; label: string }) {
  const set = (i: number, patch: Partial<Cond>) => onChange(conds.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-1.5">
      {conds.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select label={`${label} field ${i + 1}`} value={c.field} options={fields} onChange={(v) => set(i, { field: v })} disabled={disabled} className="w-[132px] shrink-0" />
          <span className="text-[12px] text-muted-foreground">is</span>
          <input
            aria-label={`${label} value ${i + 1}`} value={c.text} disabled={disabled} onChange={(e) => set(i, { text: e.target.value })}
            placeholder="320-FT*, DOR  (globs; comma = or)" className={cn(box, "min-w-0 flex-1 font-mono")}
          />
          <button type="button" aria-label="Remove condition" disabled={disabled} onClick={() => onChange(conds.filter((_, j) => j !== i))} className="rounded-chip p-1 text-muted-foreground hover:bg-raised hover:text-err">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function FilterEditor({ value, onChange, fields, disabled, label }: { value: unknown; onChange: (f: Filter) => void; fields: string[]; disabled?: boolean; label: string }) {
  const f = (value && typeof value === "object" ? value : {}) as Filter;
  const nested = Array.isArray(f.any) || (!!f.not && typeof f.not === "object" && Object.keys(f.not as object).some((k) => k === "not" || k === "any"));
  const all = toConds(f);
  const not = toConds(f.not);
  // half-typed rows (no value yet) live in local state; the parent only sees finished conditions
  const [a, setA] = useState<Cond[]>(all);
  const [n, setN] = useState<Cond[]>(not);
  useEffect(() => {
    if (JSON.stringify(fromConds(a)) !== JSON.stringify(fromConds(all))) setA(all);
    if (JSON.stringify(fromConds(n)) !== JSON.stringify(fromConds(not))) setN(not);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(f)]);
  if (nested) {
    return (
      <div className="rounded-chip border border-dashed border-border px-2.5 py-2 text-[12px] text-muted-foreground">
        This filter uses nested “any / not” groups, which the form cannot show: <span className="font-mono text-text">{filterText(f)}</span>
      </div>
    );
  }
  const emit = (x: Cond[], y: Cond[]) => {
    const out = fromConds(x);
    const nf = fromConds(y);
    onChange(Object.keys(nf).length ? { ...out, not: nf } : out);
  };
  const add = (which: "a" | "n") => {
    const row = { field: fields.includes("tag") ? "tag" : fields[0] ?? "", text: "" };
    if (which === "a") setA([...a, row]);
    else setN([...n, row]);
  };
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="text-[11px] text-muted-foreground">All of{!a.length && <span className="ml-1 text-muted-foreground/70">(no condition = every signal)</span>}</div>
        <CondRows conds={a} fields={fields} label={`${label} match`} disabled={disabled} onChange={(c) => (setA(c), emit(c, n))} />
        <button type="button" disabled={disabled} onClick={() => add("a")} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-brand disabled:opacity-50"><Plus className="size-3" />Add condition</button>
      </div>
      {(n.length > 0 || a.length > 0) && (
        <div className="space-y-1.5">
          {n.length > 0 && <div className="text-[11px] text-muted-foreground">Except when</div>}
          <CondRows conds={n} fields={fields} label={`${label} except`} disabled={disabled} onChange={(c) => (setN(c), emit(a, c))} />
          <button type="button" disabled={disabled} onClick={() => add("n")} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-brand disabled:opacity-50"><Plus className="size-3" />Add exception</button>
        </div>
      )}
    </div>
  );
}

// ───── one parameter, from its ParamSpec ────────────────────────────────────────────────────────────────────────────────

const IO_TYPES = ["AIR", "AOR", "DIR", "DOR"];
const SCOPE_LABEL: Record<string, string> = { baseplate: "Baseplate", cioc: "CIOC", cabinet: "Cabinet" };
const UNIT: Record<string, string> = { max: "signals", extra_pct: "%", extra_count: "spares" };

export function ParamField({ spec, value, onChange, fields, disabled }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void; fields: string[]; disabled?: boolean }) {
  const label = humanise(spec.name);
  const choices = spec.choices ?? [];
  let input: JSX.Element;
  switch (spec.kind) {
    case "filter":
      input = <FilterEditor value={value} onChange={onChange} fields={fields} disabled={disabled} label={label} />;
      break;
    case "scope":
    case "enum":
      input = <Seg label={label} value={value as string} disabled={disabled} options={choices.map((c) => ({ v: c, label: SCOPE_LABEL[c] ?? humanise(c) }))} onChange={onChange} />;
      break;
    case "field":
      input = <Select label={label} value={(value as string) ?? ""} options={choices.length ? choices : fields} placeholder="— none —" onChange={(v) => onChange(v || undefined)} disabled={disabled} className="w-[200px]" />;
      break;
    case "int":
    case "float":
      input = (
        <span className="inline-flex items-center gap-1.5">
          <NumberInput label={label} value={value as number | undefined} min={0} step={spec.kind === "int" ? 1 : 0.5} disabled={disabled} onChange={onChange} />
          {UNIT[spec.name] && <span className="text-[12px] text-muted-foreground">{UNIT[spec.name]}</span>}
        </span>
      );
      break;
    case "io_types": {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      input = (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
          {IO_TYPES.map((t) => {
            const on = sel.includes(t);
            return (
              <button key={t} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? sel.filter((x) => x !== t) : [...sel, t])}
                className={cn("rounded-chip border px-2.5 py-1 font-mono text-[12px] transition-colors", on ? "border-brand/60 bg-brand/15 text-text" : "border-border text-muted-foreground hover:text-text")}>{t}</button>
            );
          })}
        </div>
      );
      break;
    }
    case "cabinets":
      input = <CabinetsInput value={value} onChange={onChange} disabled={disabled} label={label} />;
      break;
    default:
      input = spec.name === "io_type"
        ? <Seg label={label} value={value as string} disabled={disabled} options={IO_TYPES.map((t) => ({ v: t, label: t }))} onChange={onChange} />
        : <input aria-label={label} value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(box, "w-full font-mono")} />;
  }
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium">{label}</span>
        {!spec.required && <span className="text-[11px] text-muted-foreground">optional</span>}
      </div>
      {input}
      {spec.help && <p className="text-[11.5px] leading-snug text-muted-foreground">{spec.help}</p>}
    </div>
  );
}

function CabinetsInput({ value, onChange, disabled, label }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean; label: string }) {
  const [txt, setTxt] = useState(Array.isArray(value) ? value.join(", ") : "");
  useEffect(() => {
    if (Array.isArray(value) && value.join(", ") !== parseCabinets(txt).join(", ")) setTxt(value.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  return (
    <input
      aria-label={label} disabled={disabled} value={txt} placeholder="4  or  1, 4  or  P30-DCM-*"
      onChange={(e) => (setTxt(e.target.value), onChange(parseCabinets(e.target.value)))}
      className={cn(box, "w-full font-mono")}
    />
  );
}

/** Which of `params` differ from `base` — keeps PUT bodies minimal. */
export function diffParams(base: Params, next: Params): Params {
  const out: Params = {};
  for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) out[k] = next[k];
  return out;
}
