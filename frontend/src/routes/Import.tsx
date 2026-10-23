import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Pencil, Play, RotateCcw, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  useAllocate, useAllocation, useImportMdb, useImportSummary, usePutSettings, useSetMapping, useSettings,
  type ProjectSettings,
} from "@/api/hooks";
import { Panel } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DIVE_KEY, EASE, useCalm } from "@/motion/shared";
import { useUi } from "@/store/ui";
import { ALLOCATE_LANDING_ROUTE } from "@/world/actions";

const NONE = "__none__";
const ACCEPT = ".xlsx,.xlsm,.csv";
const isMdb = (f: File) => /\.(xlsx|xlsm|csv)$/i.test(f.name);
const CONFIRM_BELOW = 0.8;
// Optional future API fields: the file's raw header list, and a per-field needs_confirmation flag. Absent → derived as before.
type MapExtra = { needs_confirmation?: boolean };
const needsConfirm = (m: { source?: string | null; required?: boolean; confidence: number } & MapExtra) =>
  m.needs_confirmation ?? ((!!m.source && m.confidence < CONFIRM_BELOW) || (!!m.required && !m.source)); // the API has no needs_confirmation flag; a low-confidence match is the same thing for the user

/** Import & Mapping (§10.5.6) — where the Upload Dive starts. */
export default function Import() {
  const nav = useNavigate();
  const calm = useCalm();
  const { data: imp } = useImportSummary();
  const { data: a } = useAllocation();
  const importer = useImportMdb();
  const allocate = useAllocate();
  const [over, setOver] = useState(false);
  const drag = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fresh, setFresh] = useState(0); // bumps on every import → replays the chip stagger

  async function take(files: FileList | File[] | null | undefined) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const ok = list.filter(isMdb);
    if (!ok.length) {
      toast.error("Not an MDB file", { description: "Drop an .xlsx or .csv IO MDB." });
      return;
    }
    if (ok.length > 1) toast.info(`Using ${ok[0].name}`, { description: `A project takes one MDB at a time — ${ok.length - 1} other file(s) skipped.` });
    const sum = await importer.mutateAsync(ok[0]).catch(() => null);
    if (sum) {
      useUi.setState({ cabIdx: 0, side: "F", level: "cabinet", focusCioc: null, inspectorSlot: null });
      setFresh((n) => n + 1);
      toast.success(`Read ${sum.rows} rows from ${sum.file}`, { description: `${sum.live_rows} live · ${sum.quarantined} quarantined` });
    }
  }

  async function run() {
    await allocate.mutateAsync().catch(() => null);
    try {
      sessionStorage.setItem(DIVE_KEY, "1");
    } catch {
      /* storage can be blocked */
    }
    nav(`${ALLOCATE_LANDING_ROUTE}?dive=1`);
  }

  const busy = importer.isPending;
  return (
    <ScrollArea className="h-full">
      <div
        className="relative mx-auto max-w-[1680px] p-6"
        data-testid="import-page"
        onDragEnter={(e) => (e.preventDefault(), drag.current++, setOver(true))}
        onDragLeave={() => (drag.current = Math.max(0, drag.current - 1), drag.current === 0 && setOver(false))}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => (e.preventDefault(), (drag.current = 0), setOver(false), void take(e.dataTransfer.files))}
      >
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-page">Import &amp; Mapping</h1>
            <p className="mt-1 text-muted-foreground">Any IO MDB, zero code: columns auto-mapped, bad rows quarantined, never a crash.</p>
          </div>
          <Button onClick={run} disabled={!imp || busy || allocate.isPending} className="gap-2" data-testid="allocate-btn">
            {allocate.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Allocate
          </Button>
        </header>

        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden data-testid="mdb-input" onChange={(e) => (void take(e.target.files), (e.target.value = ""))} />

        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 xl:col-span-8 [&>section]:h-full">
            <DropCard imp={imp} busy={busy} over={over} onPick={() => fileRef.current?.click()} calm={calm} />
          </div>
          <div className="col-span-12 xl:col-span-4 [&>section]:h-full"><Preflight /></div>

          <div className="col-span-12 xl:col-span-8"><MappingTable fresh={fresh} calm={calm} /></div>
          <div className="col-span-12 xl:col-span-4"><SettingsPanel /></div>

          <div className="col-span-12"><PreviewTable /></div>
          {a && a.quarantine.length > 0 && <div className="col-span-12"><QuarantinePanel /></div>}
        </div>

        {over && (
          <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-live bg-bg/70 backdrop-blur-sm" data-testid="drop-overlay">
            <div className="flex items-center gap-2 text-[14px] font-medium"><Upload className="size-5 text-live" />Drop the MDB to read it</div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function DropCard({ imp, busy, over, onPick, calm }: { imp: ReturnType<typeof useImportSummary>["data"]; busy: boolean; over: boolean; onPick: () => void; calm: boolean }) {
  return (
    <Panel title="IO MDB" aside={imp && <span className="font-mono text-[11px] text-muted-foreground">sha {imp.sha256.slice(0, 10)}…</span>}>
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        className={cn(
          "flex h-full min-h-[96px] w-full items-center gap-5 rounded-card border border-dashed p-5 text-left transition-colors",
          over ? "border-live bg-live/5" : "border-border bg-raised/40 hover:border-brand/50 hover:bg-raised/70",
        )}
        data-testid="drop-zone"
      >
        <motion.div
          key={imp?.sha256 ?? "none"}
          initial={calm ? { opacity: 0 } : { scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="grid size-14 shrink-0 place-items-center rounded-card bg-surface inner-hi"
        >
          {busy ? <Loader2 className="size-7 animate-spin text-live" /> : imp ? <FileSpreadsheet className="size-7 text-ok" /> : <Upload className="size-7 text-brand" />}
        </motion.div>
        <div className="min-w-0 flex-1">
          {busy ? (
            <div className="text-[14px] font-medium">Reading, mapping and allocating…</div>
          ) : imp ? (
            <>
              <div className="truncate font-mono text-[14px]">{imp.file}</div>
              <div className="mt-1 text-[12px] text-muted-foreground tnum">sheet {imp.sheet} · header row {imp.header_row} · {imp.rows} rows</div>
            </>
          ) : (
            <div className="text-[14px] font-medium">No MDB loaded</div>
          )}
          <div className="mt-2 text-[12px] text-muted-foreground">Drop an <span className="font-mono">.xlsx</span> / <span className="font-mono">.csv</span> anywhere on this page, or click to browse. Loading a new file replaces the project's MDB.</div>
        </div>
      </button>
    </Panel>
  );
}

function Preflight() {
  const { data: imp } = useImportSummary();
  const { data: a } = useAllocation();
  const sev = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of a?.tqs ?? []) if (t.status === "open") c[t.severity] = (c[t.severity] ?? 0) + 1;
    return c;
  }, [a]);
  const open = a?.kpis.tqs_open ?? 0;
  return (
    <Panel title="Pre-flight" to="/tqs" aside={a && <span className={cn("rounded-chip px-1.5 py-0.5 text-[11px]", open ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok")}>{open ? `${open} open TQ${open > 1 ? "s" : ""}` : "clean"}</span>}>
      {!imp || !a ? <Skeleton className="h-24 w-full" /> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {([["Rows", imp.rows, ""], ["Live", imp.live_rows, ""], ["Placed", a.kpis.allocated, "text-ok"], ["Quarantined", imp.quarantined, imp.quarantined ? "text-warn" : ""]] as const).map(([k, v, tone]) => (
              <div key={k} className="rounded-chip bg-raised/60 p-2.5">
                <div className="label-caps truncate">{k}</div>
                <div className={cn("mt-0.5 text-[20px] font-semibold tnum", tone)}>{v}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            {Object.entries(sev).map(([k, v]) => (
              <span key={k} className="rounded-chip border border-border bg-raised px-2 py-0.5"><span className="text-muted-foreground">{k}</span> <span className="tnum">{v}</span></span>
            ))}
            {!open && <span className="flex items-center gap-1 text-ok"><CheckCircle2 className="size-3.5" />No open queries</span>}
          </div>
          <ul className="space-y-1.5">
            {a.tqs.filter((t) => t.status === "open").slice(0, 3).map((t) => (
              <li key={t.id} className="flex gap-2 text-[12px] leading-snug">
                <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", t.severity === "high" || t.severity === "critical" ? "text-err" : "text-warn")} />
                <span className="line-clamp-2"><span className="font-mono text-muted-foreground">{t.id}</span> {t.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function MappingTable({ fresh, calm }: { fresh: number; calm: boolean }) {
  const { data: imp } = useImportSummary();
  const setMap = useSetMapping();
  const [custom, setCustom] = useState<string | null>(null); // field being typed
  const [draft, setDraft] = useState("");
  const raw = (imp as { raw_headers?: string[] } | undefined)?.raw_headers;
  const sources = useMemo(() => (raw?.length ? raw : Array.from(new Set((imp?.mapping ?? []).map((m) => m.source).filter((s): s is string => !!s))).sort()), [imp, raw]);

  function change(field: string, source: string | null) {
    if (!imp) return;
    setMap.mutate(imp.mapping.map((m) => (m.field === field ? { ...m, source, overridden: true } : m)));
  }
  const overrides = imp?.mapping.filter((m) => m.overridden).length ?? 0;
  const confirm = imp?.mapping.filter((m) => needsConfirm(m)).length ?? 0;

  return (
    <Panel
      title="Column mapping"
      aside={
        imp && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {setMap.isPending && <Loader2 className="size-3.5 animate-spin text-live" />}
            {confirm > 0 && <span className="rounded-chip bg-warn/15 px-1.5 py-0.5 text-warn">{confirm} to confirm</span>}
            <span className="tnum">{overrides} override{overrides === 1 ? "" : "s"}</span>
          </div>
        )
      }
    >
      {!imp ? <Skeleton className="h-64 w-full" /> : (
        <div className="overflow-hidden rounded-chip border border-border" data-testid="mapping-table">
          <table className="w-full text-[12px]">
            <thead className="bg-raised text-left text-[11px] text-muted-foreground">
              <tr><th className="px-3 py-1.5 font-medium">Field</th><th className="px-3 py-1.5 font-medium">MDB column</th><th className="w-24 px-3 py-1.5 font-medium">Confidence</th><th className="w-8" /></tr>
            </thead>
            <tbody>
              {imp.mapping.map((m, i) => {
                const needs = needsConfirm(m);
                return (
                  <motion.tr
                    key={`${fresh}-${m.field}`}
                    initial={calm ? { opacity: 0 } : { opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(i, 24) * 0.03, ease: EASE }}
                    className={cn("border-t border-border", needs && "bg-warn/[0.07]")}
                  >
                    <td className="px-3 py-1.5">
                      <span>{m.label}</span>
                      {m.required && <span className="ml-1 text-err" title="Required">*</span>}
                      <span className="ml-2 font-mono text-[10.5px] text-muted-foreground">{m.field}</span>
                    </td>
                    <td className="px-3 py-1">
                      {custom === m.field ? (
                        <Input
                          autoFocus
                          value={draft}
                          placeholder="Exact column header…"
                          className="h-7 font-mono text-[12px]"
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => setCustom(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && draft.trim()) (change(m.field, draft.trim()), setCustom(null));
                            if (e.key === "Escape") setCustom(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <Select value={m.source ?? NONE} onValueChange={(v) => change(m.field, v === NONE ? null : v)}>
                            <SelectTrigger className={cn("h-7 w-full max-w-[280px] font-mono text-[12px]", !m.source && "text-warn")} aria-label={`Column for ${m.label}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>— unmapped —</SelectItem>
                              {Array.from(new Set([...(m.source ? [m.source] : []), ...sources])).map((s) => (
                                <SelectItem key={s} value={s} className="font-mono text-[12px]">{s}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            title="Type a column header"
                            aria-label={`Type a column for ${m.label}`}
                            className="rounded-chip p-1 text-muted-foreground hover:text-text"
                            onClick={() => (setDraft(m.source ?? ""), setCustom(m.field))}
                          >
                            <Pencil className="size-3" />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {m.overridden ? (
                        <span className="rounded-chip bg-brand/15 px-1.5 py-0.5 text-[11px] text-brand">manual</span>
                      ) : m.source ? (
                        <span className={cn("tnum text-[11.5px]", m.confidence >= 0.9 ? "text-ok" : "text-warn")}>{Math.round(m.confidence * 100)}%</span>
                      ) : (
                        <span className="text-[11.5px] text-muted-foreground">{m.required ? "missing" : "optional"}</span>
                      )}
                    </td>
                    <td className="pr-2">
                      {m.overridden && (
                        <button type="button" title="Reset to the automatic match" aria-label={`Reset ${m.label}`} className="rounded-chip p-1 text-muted-foreground hover:text-text" onClick={() => change(m.field, null)}>
                          <RotateCcw className="size-3" />
                        </button>
                      )}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const NUM_FIELDS: [keyof ProjectSettings, string][] = [
  ["ciocs_per_cabinet", "CIOCs / cabinet"], ["baseplates_per_cioc", "Baseplates / CIOC"], ["channels_per_baseplate", "Channels / baseplate"], ["max_cabinets_per_controller", "Cabinets / controller"],
];

function SettingsPanel() {
  const { data: s } = useSettings();
  const { data: imp } = useImportSummary();
  const { data: a } = useAllocation();
  const put = usePutSettings();
  const [d, setD] = useState<ProjectSettings | null>(null);
  useEffect(() => setD(s ?? null), [s]);

  const unmapped = (imp?.mapping ?? []).filter((m) => (m.field === "room" || m.field === "area") && !m.source).map((m) => m.field);
  const tqDefaults = (a?.tqs ?? []).filter((t) => /^Unmapped (room|area)$/.test(t.category)).length;
  const usedDefaults = unmapped.length > 0 || tqDefaults > 0;
  const dirty = !!s && !!d && JSON.stringify(s) !== JSON.stringify(d);

  return (
    <Panel
      title="Project settings"
      aside={
        usedDefaults && (
          <span className="rounded-chip bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn" title="Room / area could not be derived from the MDB — project defaults were used and one TQ raised." data-testid="defaults-chip">
            used defaults
          </span>
        )
      }
    >
      {!d ? <Skeleton className="h-56 w-full" /> : (
        <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), put.mutate(d, { onSuccess: () => toast.success("Settings saved — re-allocated and re-verified") }))}>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Location prefix"><Input value={d.loc_prefix_default} className="h-8 font-mono" onChange={(e) => setD({ ...d, loc_prefix_default: e.target.value })} /></Field>
            <Field label="Area code"><Input value={d.area_code_default} className="h-8 font-mono" onChange={(e) => setD({ ...d, area_code_default: e.target.value })} /></Field>
            {NUM_FIELDS.map(([k, label]) => (
              <Field key={k} label={label}>
                <Input type="number" min={1} value={d[k] as number} className="h-8 tnum" onChange={(e) => setD({ ...d, [k]: Math.max(1, Number(e.target.value) || 1) })} />
              </Field>
            ))}
          </div>
          <Field label="Controller domain = columns">
            <Input
              value={(d.domain_keys ?? []).join(", ")}
              placeholder="room, area (empty = one domain)"
              className="h-8 font-mono"
              onChange={(e) => setD({ ...d, domain_keys: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
            />
          </Field>
          {usedDefaults && (
            <p className="text-[11.5px] leading-snug text-muted-foreground">
              {unmapped.length ? `No ${unmapped.join(" / ")} column in the MDB` : "Room / area values did not match the patterns"} — using <span className="font-mono">{d.loc_prefix_default}</span> / <span className="font-mono">{d.area_code_default}</span>. Confirm or edit them above.
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Saving re-runs allocate + verify.</span>
            <Button type="submit" size="sm" disabled={!dirty || put.isPending} className="gap-1.5">
              {put.isPending && <Loader2 className="size-3.5 animate-spin" />}Save settings
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label-caps mb-1 block truncate">{label}</span>
      {children}
    </label>
  );
}

function PreviewTable() {
  const { data: imp } = useImportSummary();
  const cols = useMemo(() => (imp?.mapping ?? []).filter((m) => m.source), [imp]);
  return (
    <Panel title="Preview — first 10 rows, as mapped" aside={imp && <span className="text-[11px] text-muted-foreground tnum">{cols.length} of {imp.mapping.length} fields mapped</span>}>
      {!imp ? <Skeleton className="h-40 w-full" /> : !imp.preview?.length ? <p className="text-muted-foreground">No rows to preview.</p> : (
        <ScrollArea className="w-full">
          <table className="min-w-full text-[11.5px]" data-testid="preview-table">
            <thead className="bg-raised text-left text-[11px] text-muted-foreground">
              <tr>{cols.map((m) => <th key={m.field} className="whitespace-nowrap px-2 py-1.5 font-medium">{m.label}</th>)}</tr>
            </thead>
            <tbody className="font-mono">
              {(imp.preview ?? []).map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {cols.map((m) => <td key={m.field} className="max-w-[220px] truncate whitespace-nowrap px-2 py-1">{r[m.field] || <span className="text-muted-foreground">–</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
    </Panel>
  );
}

function QuarantinePanel() {
  const { data: a } = useAllocation();
  if (!a) return null;
  return (
    <Panel title="Quarantine — kept, never dropped" to="/tqs" aside={<span className="rounded-chip bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn tnum">{a.quarantine.length} row{a.quarantine.length === 1 ? "" : "s"}</span>}>
      <table className="w-full text-[12px]">
        <thead className="text-left text-[11px] text-muted-foreground"><tr><th className="w-16 py-1 font-medium">Row</th><th className="py-1 font-medium">Tag</th><th className="py-1 font-medium">Reason</th><th className="w-28 py-1 font-medium">TQ</th></tr></thead>
        <tbody>
          {a.quarantine.map((q) => (
            <tr key={q.row} className="border-t border-border">
              <td className="py-1.5 font-mono tnum">{q.row}</td>
              <td className="py-1.5 font-mono">{q.tag}</td>
              <td className="py-1.5">{q.reason}</td>
              <td className="py-1.5 font-mono text-muted-foreground">{q.tq_id ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
