import { Eye, Plus, RotateCw, Wrench, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { shortSlot, usePatchSignal, type SignalFix, type SignalPatchResult, type SignalRow } from "./api";

const FIELDS = ["io_type", "cable", "pair", "group", "instrument_type", "cable_spec", "status", "tag"];

interface Row {
  key: string;
  value: string;
}

const input = "h-8 rounded-md border border-input bg-transparent px-2.5 text-[12px] text-text outline-none focus-visible:ring-1 focus-visible:ring-ring";

function rowsOf(fix: SignalFix): Row[] {
  const p = (fix.patch ?? {}) as { fields?: Record<string, unknown>; needs_value?: boolean };
  const need = !!p.needs_value;
  return Object.entries(p.fields ?? {}).map(([key, v]) => ({ key, value: need && (v == null || v === "" || v === "?") ? "" : String(v ?? "") }));
}

/** Unallocated / quarantined signals: the engine's suggested fixes + a "Fix data" form (preview first, then store, then place). */
export function FixPanel({ sig }: { sig: SignalRow }) {
  const all = sig.fixes ?? [];
  const [more, setMore] = useState(false);
  // the API offers one "set the pair to N" per free pair; the first fix of each kind is the useful one, the rest sit behind "more"
  const seen = new Set<string>();
  const fixes = all.filter((f) => {
    const k = f.kind === "data_patch" ? JSON.stringify(f.patch) : f.label;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const shown = more ? fixes : fixes.slice(0, 3);
  const [rows, setRows] = useState<Row[]>(() => {
    const first = fixes.find((f) => f.kind === "data_patch");
    return first ? rowsOf(first) : [{ key: sig.quarantine_reason?.includes("pair") ? "pair" : "cable", value: "" }];
  });
  const [preview, setPreview] = useState<SignalPatchResult | null>(null);
  const patch = usePatchSignal();
  const fields = Object.fromEntries(rows.filter((r) => r.key && r.value.trim() !== "").map((r) => [r.key, r.value.trim()]));
  const ready = Object.keys(fields).length > 0;

  const run = (isPreview: boolean) =>
    patch.mutate(
      { tag: sig.tag, row: sig.row, fields, preview: isPreview, reason: "Workbench: fix data" },
      {
        onSuccess: (res) => {
          if (isPreview) {
            setPreview(res);
            return;
          }
          setPreview(null);
          if (res.stored) {
            const at = res.after?.location?.slot_id;
            toast.success(res.verdict === "placed" ? `${sig.tag} placed` : `Data patch stored — ${res.verdict}`, {
              description: at ? `${shortSlot(at)} · ${res.report?.violations ?? 0} violations` : res.messages?.[0],
            });
          } else toast.message("Patch not stored", { description: res.messages?.[0] ?? "It would add a hard violation, so it was rolled back." });
        },
      },
    );

  const set = (i: number, p: Partial<Row>) => {
    setPreview(null);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  };
  const use = (fix: SignalFix) => {
    setPreview(null);
    setRows(rowsOf(fix));
  };
  const pv = preview;

  return (
    <section className="space-y-3 rounded-card border border-border p-3" data-testid="fix-panel">
      <div className="flex items-center gap-1.5">
        <Wrench className="size-3.5 text-warn" />
        <span className="label-caps">Fix it</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{sig.state === "quarantined" ? "data problem" : "no feasible slot"}</span>
      </div>

      {fixes.length > 0 ? (
        <ul className="space-y-1.5">
          {shown.map((f, i) => (
            <li key={i} className="flex items-start gap-2 rounded-md bg-raised/50 px-2.5 py-1.5 text-[12px]">
              <span className="min-w-0 flex-1 leading-[1.4]">{f.label}</span>
              {f.kind === "data_patch" && (
                <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => use(f)}>
                  Use
                </Button>
              )}
              {f.kind === "rule_patch" && (
                <Link to="/tqs" className="shrink-0 text-[11px] text-brand hover:underline">
                  TQ Center
                </Link>
              )}
              {f.kind === "placement" && <span className="shrink-0 text-[11px] text-muted-foreground">use Move to ↓</span>}
            </li>
          ))}
          {fixes.length > shown.length && (
            <li>
              <button onClick={() => setMore(true)} className="px-1 text-[11.5px] text-muted-foreground hover:text-text">+ {fixes.length - shown.length} more suggestion{fixes.length - shown.length === 1 ? "" : "s"}</button>
            </li>
          )}
        </ul>
      ) : (
        <p className="text-[12px] text-muted-foreground">No automatic fix was found — correct the MDB value below, or edit the rule that blocks it.</p>
      )}

      <div className="space-y-1.5" data-testid="fix-form">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <select value={r.key} onChange={(e) => set(i, { key: e.target.value })} className={cn(input, "w-[132px] bg-surface font-mono")} aria-label="Field">
              {[...new Set([r.key, ...FIELDS])].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <input value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="new value" className={cn(input, "min-w-0 flex-1 font-mono")} aria-label="Value" data-testid="fix-value" />
            {rows.length > 1 && (
              <button onClick={() => (setPreview(null), setRows((rs) => rs.filter((_, j) => j !== i)))} className="rounded p-1 text-muted-foreground hover:bg-raised hover:text-text" aria-label="Remove field">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button onClick={() => setRows((rs) => [...rs, { key: FIELDS.find((f) => !rs.some((r) => r.key === f)) ?? "group", value: "" }])} className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-text">
            <Plus className="size-3" /> field
          </button>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" disabled={!ready || patch.isPending} onClick={() => run(true)} data-testid="fix-preview">
              {patch.isPending && patch.variables?.preview ? <RotateCw className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />} Preview
            </Button>
            <Button size="sm" className="h-8 gap-1.5 text-[12px]" disabled={!ready || patch.isPending || !pv || !(pv.applied || pv.verdict !== "unchanged")} onClick={() => run(false)} data-testid="fix-apply" title={pv ? "" : "Preview first"}>
              {patch.isPending && !patch.variables?.preview && <RotateCw className="size-3.5 animate-spin" />} Store &amp; place
            </Button>
          </div>
        </div>
      </div>

      {patch.isError && <p className="text-[12px] text-err" data-testid="fix-error">{(patch.error as Error).message}</p>}

      {pv && (
        <div className={cn("rounded-md border px-3 py-2 text-[12px]", pv.verdict === "placed" ? "border-ok/40 bg-ok/8" : pv.verdict === "unchanged" ? "border-border" : "border-warn/40 bg-warn/8")} data-testid="fix-preview-result">
          <div className="mb-1 flex items-center gap-2">
            <span className="label-caps">Preview</span>
            <span className="rounded-full border border-current px-2 py-px text-[10.5px] font-medium">{pv.verdict}</span>
            {pv.kpis_after && pv.kpis_before && (
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                allocated {pv.kpis_before.allocated} → <span className="text-text">{pv.kpis_after.allocated}</span> · {pv.report?.violations ?? pv.kpis_after.violations} violations
              </span>
            )}
          </div>
          <ul className="space-y-0.5 leading-[1.4]">
            {(pv.messages ?? []).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          {(pv.diff?.length ?? 0) > 0 && <div className="mt-1 text-muted-foreground">{pv.diff!.length} other slot{pv.diff!.length === 1 ? "" : "s"} would change.</div>}
          {(pv.new_tqs?.length ?? 0) > 0 && <div className="mt-1 text-warn">Raises {pv.new_tqs!.join(", ")}</div>}
        </div>
      )}
    </section>
  );
}
