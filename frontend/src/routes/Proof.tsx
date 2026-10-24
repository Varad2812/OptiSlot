import { useQueryClient } from "@tanstack/react-query";
import { motion, useTransform } from "framer-motion";
import { Bug, FileUp, Loader2, Maximize2, RefreshCw, ShieldCheck, Undo2, Upload, XCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { dimsOf, worldModel } from "@/api/derive";
import { postForm } from "@/api/client";
import { useAllocation, useProject, useProjectId, useRuns, useVerify, type AllocationResult, type Project, type RuleCheckReport } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { demoMode, registerDemo } from "@/motion/demoHooks";
import { useSequence } from "@/motion/sequence";
import { EASE, phase as phaseOf, useCalm } from "@/motion/shared";
import { ruleChecks, verifierLine } from "@/lib/checks";
import { CertStamp, CheckRow, DemoBanner, hashRow, RealStatus, RunHistory, type CertView } from "@/proof/parts";
import { collectFails, firstFlyable, lastTick, listFor, SCAN_CALM_S, SCAN_S, TICKS_FROM, tagIndex, type Fail } from "@/proof/scan";
import { CountUp } from "@/shell/CountUp";
import { ScanOverlay } from "@/proof/ScanOverlay";
import { makeTampered } from "@/proof/tamper";
import { sha256File, sleep } from "@/proof/util";
import { useUi } from "@/store/ui";
import { CabinetWorld } from "@/world/CabinetWorld";
import { cabinetBounds, fit, sideOf, SLOT_H, SLOT_W, slotXY, type Insets } from "@/world/geometry";
import { useStage } from "@/world/useStage";
import type { World3DEngine } from "@/world3d/engine";
import { hasWebGL } from "@/world3d/support";

const World3D = lazy(() => import("@/world3d/World3D"));

const INSETS: Insets = { top: 56, right: 18, bottom: 96, left: 18 };
const SCAN_KEY = "optislot-scan-seen";

type DemoInfo = { row: number; column: string; tag: string; from: string; to: string };
type Source = { kind: "run" } | { kind: "file"; name: string; report: RuleCheckReport; sha: string | null; at: string; demo?: DemoInfo };
type Phase = "idle" | "uploading" | "scanning" | "flying" | "done";

export default function Proof() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  if (!a) {
    return (
      <div className="grid h-full grid-cols-[1fr_480px] gap-4 p-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return <ProofInner a={a} p={p} />;
}

function ProofInner({ a, p }: { a: AllocationResult; p: Project | undefined }) {
  const pid = useProjectId();
  const qc = useQueryClient();
  const calm = useCalm();
  const ui = useUi();
  const verify = useVerify();
  const { data: runs } = useRuns();
  const seq = useSequence(1);
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => worldModel(a, dims), [a, dims]);
  const tags = useMemo(() => tagIndex(a), [a]);
  const stage = useStage(model.cabinets.length, dims, INSETS);
  // 3D stage (§10.7 motion 2 + 3): the whole room is scanned, the camera flies into the failing slot; 2D World as the fallback
  const use3d = useUi((s) => s.view3d) && hasWebGL();
  const eng = useRef<World3DEngine | null>(null);
  const onEngine = useCallback((e: World3DEngine | null) => (eng.current = e), []);
  const scanOn = useRef(false); // the sequence is a scan right now (the progress → beam bridge listens only then)
  const scanFails = useRef<string[]>([]);

  const [src, setSrc] = useState<Source>({ kind: "run" });
  const [phase, setPhase] = useState<Phase>("done");
  const [marked, setMarked] = useState<Fail[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [over, setOver] = useState(false);
  const token = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const verifyBusy = useRef(false);
  const srcRef = useRef(src);
  srcRef.current = src;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const live = useRef({ stage, dims, model, a, tags, calm });
  live.current = { stage, dims, model, a, tags, calm };

  // a new allocation (Commit in the Workbench, a rule change) retires a demo / uploaded view: the real verifier status is shown
  const runId = a.run_id;
  const lastRun = useRef(runId);
  useEffect(() => {
    if (lastRun.current === runId) return;
    lastRun.current = runId;
    setSrc((s) => (s.kind === "file" && s.demo ? { kind: "run" } : s));
  }, [runId]);

  const report = src.kind === "file" ? src.report : a.report;
  const cur = useMemo(() => {
    const { fails, total } = collectFails(report, a, model, tags);
    const exceptions = new Map(report.checks.filter((c) => c.exceptions?.length).map((c) => [c.id, listFor(c, "exceptions", a, model, tags, 60)]));
    return { fails, total, exceptions, byCheck: new Map(report.checks.map((c) => [c.id, fails.filter((f) => f.check.id === c.id)])) };
  }, [report, a, model, tags]);

  // ───── camera ─────
  /** Put the cabinet (and side) of a slot in view and wait for the glide / flip to finish. */
  const showCabinet = useCallback(async (f: Fail) => {
    const s = f.slot;
    if (!s) return;
    const L = live.current;
    const ci = L.model.cabIndexByName.get(s.cabinet);
    const want = sideOf(s.cioc_local, L.dims);
    const st = useUi.getState();
    if (ci == null || (st.cabIdx === ci && st.side === want)) return;
    useUi.setState({ cabIdx: ci, side: want, focusCioc: null });
    await sleep(L.calm ? 160 : 800);
  }, []);

  /** Fly in until the slot is large enough to read its tag (3D: the camera dives to the CHARM, which flashes red in its frame). */
  const flyTo = useCallback(async (f: Fail, all?: Fail[]) => {
    const s = f.slot;
    if (!s) return;
    const e = eng.current;
    if (e) {
      const ids = [s.id, ...(all ?? []).map((x) => x.slot?.id).filter((x): x is string => !!x && x !== s.id)];
      return e.playTamper(ids);
    }
    await showCabinet(f);
    const L = live.current;
    const ci = L.model.cabIndexByName.get(s.cabinet);
    if (ci == null || !L.stage.vp.w) return;
    const xy = slotXY(ci, s.cioc_local, s.bp, s.ch, L.dims);
    const target = fit({ x: xy.x - 190, y: xy.y - 100, w: 380 + SLOT_W, h: 200 + SLOT_H }, L.stage.vp.w, L.stage.vp.h, { top: 0, right: 0, bottom: 40, left: 0 }, 4);
    if (L.calm) L.stage.cam.set(target);
    else await L.stage.cam.tween(L.stage.cam.get(), target, 900, L.stage.vp.w, L.stage.vp.h, 0.1);
  }, [showCabinet]);

  const resetView = useCallback(() => {
    if (eng.current) return void eng.current.goTo(0);
    const L = live.current;
    L.stage.cam.springTo(fit(cabinetBounds(L.stage.idx, L.dims), L.stage.vp.w, L.stage.vp.h, INSETS));
  }, []);

  // ───── the scan ─────
  const play = useCallback(async () => {
    scanOn.current = true;
    seq.seek(0);
    setPhase("scanning");
    await seq.play(live.current.calm ? SCAN_CALM_S : SCAN_S);
    scanOn.current = false;
  }, [seq]);

  // the one progress value also drives the 3D beam: CHARMs flash green as the checks tick (red where they failed)
  useEffect(() => {
    if (!use3d) return;
    return seq.progress.on("change", (v) => {
      const e = eng.current;
      if (!e || !scanOn.current) return;
      if (e.momentName !== "scan") void e.playVerifyScan({ drive: true, follow: false, fails: scanFails.current });
      e.seek(v);
    });
  }, [use3d, seq]);

  /** Scan a report; if it fails, mark the slots, pulse them and fly the camera to the first one. */
  const settle = useCallback(async (rep: RuleCheckReport) => {
    const run = ++token.current;
    const L = live.current;
    seq.seek(0); // blank the stamp and ticks now, so the new verdict is not on screen while the camera glides to the failing cabinet
    setPhase("scanning");
    setMarked([]);
    setFocusKey(null);
    scrollRef.current?.scrollTo({ top: 0 }); // a new report starts at its first check; a flyable failure scrolls itself into view later
    const { fails } = collectFails(rep, L.a, L.model, L.tags);
    const first = firstFlyable(fails);
    scanFails.current = fails.map((f) => f.slot?.id).filter((x): x is string => !!x);
    const e = eng.current;
    if (e) {
      // the scan reads the whole room: fly out to it first
      const away = e.selection.level !== 0;
      void e.goTo(0);
      if (away) await sleep(L.calm ? 120 : 950);
    } else if (first) await showCabinet(first); // glide there first, so the beam crosses the cabinet that holds the failure
    if (run !== token.current) return;
    await play();
    if (run !== token.current) return;
    if (first) {
      setMarked(fails);
      setFocusKey(first.key);
      setPulseKey((k) => k + 1);
      setPhase("flying");
      await flyTo(first, fails);
      if (run !== token.current) return;
    }
    setPhase("done");
  }, [seq, play, showCabinet, flyTo]);

  // Re-verify now / V / A elsewhere replaces the report object → replay the scan on the current run.
  const lastReport = useRef(a.report);
  useEffect(() => {
    if (lastReport.current === a.report) return;
    lastReport.current = a.report;
    setSrc({ kind: "run" });
    void settle(a.report);
  }, [a.report, settle]);

  // first visit of the session: the scan plays once by itself (not in ?demo=1 — Playwright drives it)
  useEffect(() => {
    if (demoMode) return;
    let seen = false;
    try {
      seen = !!sessionStorage.getItem(SCAN_KEY);
    } catch {
      seen = true;
    }
    if (seen) return;
    const t = window.setTimeout(() => {
      try {
        sessionStorage.setItem(SCAN_KEY, "1");
      } catch {
        /* ignore */
      }
      void settle(live.current.a.report);
    }, 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // any key finishes a running scan (keys keep working: V, A, ← →)
  useEffect(() => {
    if (phase !== "scanning") return;
    const skip = (e: KeyboardEvent) => !(e.metaKey || e.ctrlKey || e.altKey) && seq.skip();
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [phase, seq]);

  // scroll the failing row into view once it has opened
  useEffect(() => {
    if (!focusKey) return;
    const t = window.setTimeout(() => document.querySelector(`[data-fail="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" }), 120);
    return () => window.clearTimeout(t);
  }, [focusKey, pulseKey, calm]);

  // ───── verify any Excel ─────
  const verifyFile = useCallback(async (file: File | undefined, demo?: DemoInfo) => {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) return void toast.error("Not an Excel file", { description: "Drop an IO Allocation .xlsx — ours, or a hand-edited copy." });
    // A Re-verify in flight would replace the report (and flip the view back to the run) when it lands — the buttons are disabled, a drop is not.
    if (verifyBusy.current) return void toast.info("Re-verify is still running", { description: "Drop the file again in a moment." });
    token.current++;
    setPhase("uploading");
    setMarked([]);
    setFocusKey(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const [sha, rep] = await Promise.all([sha256File(file), postForm<RuleCheckReport>(`/verify-file?project_id=${encodeURIComponent(pid)}`, form)]);
      void qc.invalidateQueries({ queryKey: ["runs", pid] });
      setSrc({ kind: "file", name: file.name, report: rep, sha, at: new Date().toISOString(), demo });
      await settle(rep);
    } catch (e) {
      setPhase("done");
      const net = e instanceof TypeError;
      toast.error(net ? "Verifier unreachable" : "Could not verify that file", { description: net ? "The API is offline — the independent verifier runs on the server." : (e as Error).message });
    }
  }, [pid, qc, settle]);

  /** Tamper test: a copy of our own export with ONE CHARM Type changed, verified like any dropped file — it must fail. */
  const [tampering, setTampering] = useState(false);
  const tamperTest = useCallback(async () => {
    setTampering(true);
    try {
      const t = await makeTampered(pid);
      toast.message(`Tampered copy: row ${t.row}, ${t.column}`, { description: `${t.tag.replace(/\s+/g, " ")}: ${t.from} → ${t.to}. Sending it to the independent verifier…` });
      await verifyFile(t.file, { row: t.row, column: t.column, tag: t.tag, from: t.from, to: t.to });
    } catch (e) {
      const net = e instanceof TypeError;
      toast.error(net ? "Export unreachable" : "Could not make the tampered copy", { description: net ? "The API is offline — the test needs the exported workbook." : (e as Error).message });
    } finally {
      setTampering(false);
    }
  }, [pid, verifyFile]);

  const reverify = useCallback(() => {
    if (verify.isPending) return;
    setSrc({ kind: "run" });
    verify.mutate(undefined, { onError: () => void settle(live.current.a.report) }); // offline: replay the cached report
  }, [verify, settle]);

  const backToRun = useCallback(() => {
    setSrc({ kind: "run" });
    void settle(a.report);
  }, [settle, a.report]);

  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useRef(0);
  const busy = phase === "uploading" || phase === "scanning" || verify.isPending || tampering;
  verifyBusy.current = verify.isPending;

  // ?demo=1 hooks for scripts/shots.mjs
  useEffect(() => {
    if (!demoMode) return;
    return registerDemo("verify", {
      seek: (v: number) => {
        token.current++;
        setPhase("scanning");
        scanOn.current = true; // the progress listener starts (or reuses) a driven 3D scan and seeks it
        seq.seek(v);
        scanOn.current = v < 1;
        if (v >= 1) setPhase("done");
      },
      tamper: () => tamperTest(),
      play: () => settle(live.current.a.report),
      state: () => phaseRef.current,
    });
  }, [seq, settle, tamperTest]);

  const certified = a.certificate.output_sha256;
  const cert: CertView = useMemo(() => {
    const c = a.certificate;
    if (src.kind === "file") {
      const same = src.sha ? src.sha === certified : null;
      return {
        kind: "file", demo: !!src.demo, title: src.demo ? "Demo result — modified copy" : "Uploaded file", engine: c.engine_version, at: src.at,
        rows: [["File", src.name], hashRow("File sha256", src.sha), hashRow("Input MDB", c.mdb_sha256), hashRow("Rule set", c.ruleset_hash)],
        note: same == null ? null : (
          <span className={cn("inline-flex items-center gap-1.5 rounded-chip px-2 py-1 text-[11.5px]", same ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn")}>
            {same ? "Byte-identical to the certified output" : "Differs from the certified output (sha256 mismatch)"}
          </span>
        ),
      };
    }
    return {
      kind: "run", title: "Run certificate", engine: c.engine_version, at: c.timestamp,
      rows: [hashRow("Input MDB", c.mdb_sha256), hashRow("Rule set", c.ruleset_hash), hashRow("Output .xlsx", c.output_sha256)],
    };
  }, [a.certificate, certified, src]);

  const hasMarks = (i: number) => marked.some((f) => f.slot && model.cabIndexByName.get(f.slot.cabinet) === i);
  const overlay = useMemo(
    () => <ScanOverlay p={seq.progress} cabIdx={stage.idx} side={stage.side} dims={dims} calm={calm} fails={marked} pulseKey={pulseKey} model={model} />,
    [seq.progress, stage.idx, stage.side, dims, calm, marked, pulseKey, model],
  );

  const ticked = useTransform(seq.progress, (v) => phaseOf(v, TICKS_FROM, lastTick(report.checks.length) + 0.02)); // the header count climbs with the ticks
  const failedCount = report.checks.filter((c) => c.failed > 0).length;

  return (
    <div className="flex h-full flex-col" data-testid="proof" data-phase={phase}>
      <input ref={fileRef} type="file" accept=".xlsx,.xls" hidden data-testid="verify-file-input" onChange={(e) => (void verifyFile(e.target.files?.[0]), (e.target.value = ""))} />

      {/* header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface/50 px-5">
        <h1 className="whitespace-nowrap text-[14px] font-semibold">Proof Center</h1>
        <span className="min-w-0 max-w-[420px] shrink truncate rounded-chip border border-border bg-raised px-2 py-0.5 font-mono text-[11px] text-muted-foreground" title={src.kind === "file" ? src.name : undefined}>
          {src.kind === "file" ? (src.demo ? `Demo · tampered copy · ${src.name}` : `Uploaded · ${src.name}`) : `Rev ${a.revision} · re-read from the exported workbook`}
        </span>
        <motion.span
          key={`${report.verdict}/${phase === "scanning"}`} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}
          className={cn("flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-[11.5px]", phase === "scanning" || phase === "uploading" ? "border-live/40 text-muted-foreground" : report.verdict === "PASS" ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err")}
          data-testid="verdict-chip"
        >
          {phase === "scanning" || phase === "uploading" ? <><RefreshCw className="size-3.5 animate-spin text-live" /> Verifying…</> : <>{report.verdict === "PASS" ? <ShieldCheck className="size-3.5" /> : <XCircle className="size-3.5" />}<span className="tnum whitespace-nowrap font-semibold" title={verifierLine(report, a.kpis.signals)}>{src.kind === "file" && src.demo ? "Demo copy · " : ""}{report.verdict} · {report.violations} violation{report.violations === 1 ? "" : "s"}{src.kind === "run" ? ` · ${ruleChecks(report)} · ${a.kpis.signals} signals` : ""}</span></>}
        </motion.span>
        <div className="ml-auto flex items-center gap-1.5">
          {src.kind === "file" && (
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={backToRun} disabled={busy} data-testid="back-to-run"><Undo2 className="size-3.5" /> Back to the current run</Button>
          )}
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="verify-any"><Upload className="size-3.5" /> Verify any Excel</Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => void tamperTest()} disabled={busy} data-testid="tamper-test" title="Change one CHARM Type in a copy of our export and verify it — it must fail">
            {tampering ? <Loader2 className="size-3.5 animate-spin" /> : <Bug className="size-3.5" />} Tamper test
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-[12px]" onClick={reverify} disabled={busy} data-testid="reverify">
            {verify.isPending || phase === "scanning" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Re-verify now
            <kbd className="rounded-[4px] bg-white/15 px-1 font-mono text-[10px]">V</kbd>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* stage: the cabinet being read */}
        <div
          className="relative min-w-0 flex-1"
          onDragEnter={(e) => (e.preventDefault(), drag.current++, setOver(true))}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => (drag.current = Math.max(0, drag.current - 1), drag.current === 0 && setOver(false))}
          onDrop={(e) => (e.preventDefault(), (drag.current = 0), setOver(false), void verifyFile(e.dataTransfer.files[0]))}
        >
          {use3d ? (
            <div className="absolute inset-0 bg-[#0A0D13]" data-testid="proof-3d">
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <World3D model={model} dims={dims} match={null} minimal onEngine={onEngine} onFail={() => useUi.getState().setView3d(false)} />
              </Suspense>
            </div>
          ) : (
            <>
            <div className="bg-world absolute inset-0">
              <motion.div className="absolute inset-0" style={{ opacity: stage.opacity, rotateY: stage.rotateY, transformPerspective: 1800 }}>
                <CabinetWorld
                  model={model} dims={dims} cam={stage.cam} side={stage.side} activeIdx={stage.idx} cabinetS={stage.cabinetS}
                  selectedId={marked.length ? marked.find((f) => f.key === focusKey)?.slot?.id ?? null : null}
                  overlay={overlay} onSize={stage.onSize} onSlot={(id) => ui.inspect(id)} onCabinet={(i) => ui.goCabinet(i)}
                />
              </motion.div>
            </div>

            <div className="pointer-events-none absolute left-4 top-3 z-10 flex items-center gap-2">
              <div className="pointer-events-auto flex gap-1">
                {model.cabinets.slice(0, 12).map((c) => (
                  <button
                    key={c.info.name} onClick={() => stage.goto(c.index)}
                    className={cn("flex items-center gap-1.5 rounded-chip border px-2 py-1 font-mono text-[11px] backdrop-blur transition-colors", c.index === stage.idx ? "border-brand/60 bg-brand/15 text-text" : "border-border bg-surface/70 text-muted-foreground hover:text-text")}
                  >
                    {hasMarks(c.index) && <span className="size-1.5 rounded-full bg-err" title="a failing slot is in this cabinet" />}
                    {c.info.name}
                  </button>
                ))}
                {model.cabinets.length > 12 && <span className="glass flex items-center rounded-chip border border-border px-2 text-[11px] text-muted-foreground">+{model.cabinets.length - 12} (← → keys)</span>}
              </div>
            </div>
            <button onClick={resetView} aria-label="Fit the cabinet" title="Fit the cabinet" className="glass absolute right-4 top-3 z-10 rounded-chip border border-border p-1.5 text-muted-foreground transition-colors hover:text-text">
              <Maximize2 className="size-3.5" />
            </button>

            </>
          )}

          {/* verify any Excel — the whole stage is the drop target; this bar says so */}
          <div className="glass pointer-events-none absolute inset-x-4 bottom-3 z-10 flex items-center gap-3 rounded-card border border-border px-3.5 py-2.5">
            <FileUp className="size-5 shrink-0 text-brand" />
            <div className="min-w-0 flex-1 text-[12px] leading-snug">
              <div className="font-medium">Verify any Excel — drop an allocation .xlsx anywhere on this view</div>
              <div className="truncate text-muted-foreground">Ours or a hand-edited copy. The verifier re-reads every row; a tampered cell fails with its exact row and check.</div>
            </div>
            <div className="hidden shrink-0 items-center gap-3 text-[11px] text-muted-foreground 2xl:flex">
              <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 rounded bg-live shadow-[0_0_8px_rgb(var(--live))]" />scan beam</span>
              <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] border-2 border-err bg-err/25" />failing slot</span>
            </div>
          </div>
          {over && (
            <div className="absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-live bg-bg/70 backdrop-blur-sm" data-testid="drop-overlay">
              <FileUp className="size-8 text-live" />
              <span className="text-[15px] font-semibold">Drop to verify</span>
              <span className="text-[12px] text-muted-foreground">POST /api/verify-file — the independent verifier re-reads the workbook</span>
            </div>
          )}
          {phase === "uploading" && (
            <div className="absolute left-1/2 top-16 z-20 flex -translate-x-1/2 items-center gap-2 rounded-chip border border-live/40 bg-surface/90 px-3 py-1.5 text-[12px]"><Loader2 className="size-3.5 animate-spin text-live" /> Reading the workbook…</div>
          )}
        </div>

        {/* proof column */}
        <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-surface/60" data-testid="proof-aside">
          <div className="shrink-0 p-4 pb-3">{src.kind === "file" && (
              <div className="mb-3 space-y-2">
                <RealStatus report={a.report} signals={a.kpis.signals} />
                {src.demo && <DemoBanner t={src.demo} onBack={backToRun} />}
              </div>
            )}
            <CertStamp report={report} cert={cert} p={seq.progress} signals={a.kpis.signals} /></div>
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4" data-testid="proof-scroll">

          {report.verdict === "FAIL" && phase !== "scanning" && phase !== "uploading" && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="shrink-0 rounded-card border border-err/40 bg-err/10 px-3.5 py-2.5 text-[12.5px]" data-testid="fail-banner">
              <div className="font-semibold text-err">
                {cur.total} violation{cur.total === 1 ? "" : "s"} in {failedCount} check{failedCount === 1 ? "" : "s"}
                {src.kind === "file" ? " — this file does not match the certified allocation" : ""}
              </div>
              <p className="mt-0.5 text-muted-foreground">Each failing row names its Excel row and the check it broke. “Fly to slot” shows where on the plant it sits.</p>
            </motion.div>
          )}

          <section className="card-surface shrink-0 p-3.5">
            <header className="mb-2 flex items-center justify-between gap-2 px-0.5">
              <h2 className="label-caps">Independent checks</h2>
              <span className="text-[11px] text-muted-foreground tnum"><CountUp value={report.checks_passed} follow={ticked} />/{report.checks_total} rule checks pass</span>
            </header>
            <p className="mb-1.5 px-0.5 text-[11.5px] text-muted-foreground">Re-read from the .xlsx by a verifier that shares no code with the engine.</p>
            <ul className="space-y-px" data-testid="checks">
              {report.checks.map((ch, i) => (
                <CheckRow
                  key={`${src.kind}/${ch.id}`} ch={ch} i={i} n={report.checks.length} p={seq.progress}
                  fails={cur.byCheck.get(ch.id) ?? []} exceptions={cur.exceptions.get(ch.id) ?? []}
                  focusKey={focusKey} pulseKey={pulseKey} onFly={(f) => (setMarked(cur.fails), setFocusKey(f.key), setPulseKey((k) => k + 1), void flyTo(f))}
                  defaultOpen={ch.failed > 0}
                />
              ))}
            </ul>
          </section>

          <RunHistory runs={runs} certified={certified} />
          </div>
        </aside>
      </div>
    </div>
  );
}
