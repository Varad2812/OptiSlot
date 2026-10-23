import { animate, AnimatePresence, motion, useMotionValue, useMotionValueEvent } from "framer-motion";
import { ChevronLeft, ChevronRight, FlipHorizontal2, Maximize2, Search, Sparkles, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { dimsOf, worldModel, type Dims, type WorldModel } from "@/api/derive";
import { useAllocation, useImportSummary, useProject, useRules, type AllocationResult, type Project, type Slot } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IO_COLOURS, IO_LABELS, IO_ORDER, ioKey, type IoKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { demoMode, registerDemo, setDemoReady } from "@/motion/demoHooks";
import { useSequence } from "@/motion/sequence";
import { EASE, phase, scoreProgress } from "@/motion/shared";
import { UploadDiveOverlay } from "@/motion/UploadDive";
import { typing } from "@/shell/useHotkeys";
import { NO_FILTERS, useUi, type ExplorerFilters, type Level } from "@/store/ui";
import { CabinetWorld, type Tier } from "@/world/CabinetWorld";
import { cabinetBounds, ciocRect, fit, plantRect, slotXY, type Cam, type Insets } from "@/world/geometry";
import { Minimap } from "@/world/Minimap";
import { useCamera } from "@/world/useCamera";

const INSETS: Insets = { top: 92, right: 40, bottom: 92, left: 40 };
const GLIDE_MS = 700;
// Zoom-out dip mid-glide. Kept above the Plant threshold (0.85× cabinet scale) so the level of detail never pops.
const GLIDE_DIP = 0.12;
const PLANT_MAX = 8; // long rows (10k ≈ 46 cabinets): the Plant view walks a window of the row; the minimap shows it all
const DIVE_S = 4;
const DIVE_CALM_S = 1.1;
const DIVE_KEY = "optislot-dive-seen";

export default function Explorer() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  if (!a) {
    return (
      <div className="grid h-full grid-rows-[48px_1fr] gap-3 p-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return <ExplorerInner a={a} p={p} />;
}

function ExplorerInner({ a, p }: { a: AllocationResult; p: Project | undefined }) {
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => worldModel(a, dims), [a, dims]);
  const n = model.cabinets.length;
  const cam = useCamera();
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const onSize = useCallback((w: number, h: number) => setVp((o) => (o.w === w && o.h === h ? o : { w, h })), []);

  const ui = useUi();
  const { side, level, focusCioc, filters, inspectorSlot, motion: motionMode } = ui;
  const calm = motionMode === "calm";
  const idx = Math.min(Math.max(0, ui.cabIdx), Math.max(0, n - 1));
  const [params, setParams] = useSearchParams();

  // ───── camera targets ─────
  const camFor = useCallback(
    (lvl: Level, i: number, focus: number | null, w = vp.w, h = vp.h): Cam => {
      if (lvl === "plant") return fit(plantRect(n, dims, i, PLANT_MAX), w, h, INSETS);
      if (lvl === "detail" && focus != null) {
        const r = ciocRect(i, focus, dims);
        return fit({ x: r.x - 14, y: r.y - 14, w: r.w + 28, h: r.h + 22 }, w, h, { top: 140, right: 64, bottom: 84, left: 40 });
      }
      return fit(cabinetBounds(i, dims), w, h, INSETS);
    },
    [n, dims, vp.w, vp.h],
  );
  const cabinetS = vp.w ? camFor("cabinet", 0, null).s : 1;

  // ───── the World's visible opacity (Calm-mode cross-fades) + flip rotation ─────
  const worldOpacity = useMotionValue(1);
  const rotateY = useMotionValue(0);
  const [shownSide, setShownSide] = useState(side);
  const fade = useCallback(async (mid: () => void) => {
    await animate(worldOpacity, 0, { duration: 0.12 });
    mid();
    animate(worldOpacity, 1, { duration: 0.2 });
  }, [worldOpacity]);

  // ───── Upload Dive ─────
  const dive = useSequence(1);
  const [diving, setDivingState] = useState(false);
  const divingRef = useRef(false);
  const setDiving = useCallback((v: boolean) => ((divingRef.current = v), setDivingState(v)), []);
  const reveal = useMotionValue(1);
  const drop = useMotionValue(1);
  const { data: imp } = useImportSummary();
  const startDive = useCallback(() => {
    if (!vp.w) return;
    useUi.setState({ cabIdx: 0, side: "F", level: "cabinet", focusCioc: null, inspectorSlot: null });
    setShownSide("F");
    setDiving(true);
    return dive.play(calm ? DIVE_CALM_S : DIVE_S);
  }, [vp.w, dive, calm, setDiving]);

  useMotionValueEvent(dive.progress, "change", (v) => divingRef.current && applyDive(v));
  function applyDive(v: number) {
    if (!vp.w) return;
    const plant = camFor("plant", 0, null);  // the row (or its first window)
    const cab0 = camFor("cabinet", 0, null);
    if (calm) {
      cam.set(cab0);
      reveal.set(1);
      drop.set(1);
      worldOpacity.set(phase(v, 0.3, 1));
      scoreProgress.set(phase(v, 0.3, 1));
    } else {
      reveal.set(phase(v, 0.28, 0.46));
      if (v < 0.42) cam.set(plant);
      else cam.at(plant, cab0, phase(v, 0.42, 0.66), vp.w, vp.h);
      drop.set(phase(v, 0.62, 0.97));
      scoreProgress.set(phase(v, 0.62, 1));
      worldOpacity.set(1);
    }
    if (v >= 1) {
      setDiving(false);
      reveal.set(1);
      drop.set(1);
      scoreProgress.set(1); // the scoreboard always ends on the REAL numbers from the allocation
      worldOpacity.set(1);
      cam.set(cab0);
      prev.current = { idx: 0, level: "cabinet", focus: null };
    }
  }
  useEffect(() => () => scoreProgress.set(1), []);

  // Any key or click skips the dive to its end state.
  useEffect(() => {
    if (!diving) return;
    const skip = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      dive.skip();
    };
    window.addEventListener("keydown", skip, true);
    window.addEventListener("pointerdown", skip, true);
    return () => {
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener("pointerdown", skip, true);
    };
  }, [diving, dive]);

  // Triggers: ?dive=1, ⌘K "Replay Upload Dive" (diveNonce), and once per session on the first visit.
  const nonce = ui.diveNonce;
  const lastNonce = useRef(nonce);
  useEffect(() => {
    if (!vp.w) return;
    let want = false;
    if (params.get("dive") === "1") {
      want = true;
      params.delete("dive");
      setParams(params, { replace: true });
    } else if (nonce !== lastNonce.current) {
      want = true;
    } else if (!demoMode) {
      try {
        if (!sessionStorage.getItem(DIVE_KEY)) want = true;
      } catch {
        /* storage blocked → no autoplay */
      }
    }
    lastNonce.current = nonce;
    if (want) {
      try {
        sessionStorage.setItem(DIVE_KEY, "1");
      } catch {
        /* ignore */
      }
      startDive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp.w > 0, nonce]);

  // ───── intent → camera (glide between cabinets, spring for zoom levels) ─────
  const prev = useRef<{ idx: number; level: Level; focus: number | null } | null>(null);
  const suppress = useRef(false);
  const [plateKey, setPlateKey] = useState(idx);
  useEffect(() => {
    if (!vp.w || diving) return;
    const target = camFor(level, idx, focusCioc);
    const pv = prev.current;
    prev.current = { idx, level, focus: focusCioc };
    setPlateKey(idx);
    if (suppress.current) return void (suppress.current = false);
    if (!pv) return cam.set(target);
    if (pv.idx === idx && pv.level === level && pv.focus === focusCioc) return cam.set(target); // resize
    if (calm) return void fade(() => cam.set(target));
    if (pv.idx !== idx && level !== "plant") {
      void cam.tween(cam.get(), target, GLIDE_MS, vp.w, vp.h, GLIDE_DIP);
    } else cam.springTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, level, focusCioc, vp.w, vp.h, diving]);

  // Store side → animated flip (F key, palette jumps, flyToSlot).
  useEffect(() => {
    if (side === shownSide) return;
    if (calm || diving) {
      void fade(() => setShownSide(side));
      return;
    }
    let cancelled = false;
    (async () => {
      await animate(rotateY, 90, { duration: 0.22, ease: [0.4, 0, 1, 1] });
      if (cancelled) return;
      setShownSide(side);
      rotateY.set(-90);
      await animate(rotateY, 0, { duration: 0.28, ease: EASE });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  // ───── demo hooks (Playwright) ─────
  useEffect(() => {
    if (!demoMode || !vp.w) return;
    const offDive = registerDemo("dive", {
      play: () => startDive(),
      seek: (pp: number) => {
        if (!divingRef.current) {
          useUi.setState({ cabIdx: 0, side: "F", level: "cabinet", focusCioc: null, inspectorSlot: null });
          setShownSide("F");
          setDiving(true);
        }
        dive.seek(pp);
        applyDive(pp);
      },
      skip: () => dive.skip(),
    });
    const offGlide = registerDemo("glide", {
      play: (to: number) => useUi.getState().goCabinet(to),
      seek: (from: number, to: number, pp: number) => {
        suppress.current = true;
        useUi.setState({ cabIdx: to, level: "cabinet", focusCioc: null });
        cam.stop();
        cam.at(camFor("cabinet", from, null), camFor("cabinet", to, null), pp, vp.w, vp.h, GLIDE_DIP);
      },
    });
    setDemoReady(true);
    return () => {
      offDive();
      offGlide();
      setDemoReady(false);
    };
  }, [vp.w, vp.h, diving, dive, cam, camFor, startDive]);

  // ───── keys: ←/→ glide · F flip · Esc out one level ─────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e) || e.metaKey || e.ctrlKey || e.altKey || useUi.getState().paletteOpen) return;
      const st = useUi.getState();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = Math.min(n - 1, Math.max(0, idx + (e.key === "ArrowRight" ? 1 : -1)));
        if (next !== idx) st.goCabinet(next);
      } else if (e.key.toLowerCase() === "f") {
        st.setSide(st.side === "F" ? "R" : "F");
      } else if (e.key === "Escape") {
        if (st.inspectorSlot) return st.inspect(null);
        const tier = currentTier();
        st.setLevel(tier === "detail" ? "cabinet" : "plant");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const tierRef = useRef<Tier>("cabinet");
  const currentTier = () => tierRef.current;
  const [tier, setTier] = useState<Tier>("cabinet");
  const onTier = useCallback((t: Tier) => ((tierRef.current = t), setTier(t)), []);

  // Keep the inspected slot visible left of the Inspector drawer (400 px).
  useEffect(() => {
    if (!inspectorSlot || !vp.w || diving) return;
    const s = model.bySlotId.get(inspectorSlot);
    const ci = s ? model.cabIndexByName.get(s.cabinet) : undefined;
    if (!s || ci == null) return;
    const t = window.setTimeout(() => {
      const xy = slotXY(ci, s.cioc_local, s.bp, s.ch, dims);
      const c = cam.get();
      const sx = xy.x * c.s + c.x;
      const limit = vp.w - 420 - 40 * c.s;
      if (sx > limit) cam.springTo({ ...c, x: c.x - (sx - limit) - 24 });
    }, 380);
    return () => window.clearTimeout(t);
  }, [inspectorSlot, vp.w, diving, model, dims, cam]);

  // ───── filters ─────
  const match = useMemo(() => matcher(filters), [filters]);

  const view = model.cabinets[idx];
  const zoom = (k: number) => {
    const c = cam.get();
    const ns = Math.min(cabinetS * 5, Math.max(cabinetS * 0.12, c.s * k));
    const cx = vp.w / 2;
    const cy = vp.h / 2;
    cam.springTo({ s: ns, x: cx - (cx - c.x) * (ns / c.s), y: cy - (cy - c.y) * (ns / c.s) });
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar model={model} idx={idx} tier={tier} side={side} dims={dims} filters={filters} onDive={() => startDive()} />
      <div className="relative min-h-0 flex-1">
        <motion.div className="absolute inset-0" style={{ opacity: worldOpacity, rotateY, transformPerspective: 1800 }}>
          <CabinetWorld
            model={model}
            dims={dims}
            cam={cam}
            side={shownSide}
            activeIdx={idx}
            cabinetS={cabinetS}
            match={match}
            selectedId={inspectorSlot}
            reveal={reveal}
            drop={drop}
            onSize={onSize}
            onTier={onTier}
            onSlot={(id) => ui.inspect(id)}
            onCabinet={(i) => useUi.setState({ cabIdx: i, level: "cabinet", focusCioc: null })}
            onCioc={(i, local) => useUi.setState({ cabIdx: i, level: "detail", focusCioc: local })}
          />
        </motion.div>

        {/* header plate: cross-fades per cabinet */}
        <div className="pointer-events-none absolute left-5 top-4 z-10">
          <AnimatePresence mode="wait">
            {view && !diving && tier !== "detail" && <HeaderPlate key={`${plateKey}-${shownSide}`} view={view} side={shownSide} />}
          </AnimatePresence>
        </div>

        <div className="absolute right-5 top-4 z-10 flex flex-col gap-1.5">
          <IconBtn label="Zoom in" onClick={() => zoom(1.35)}><ZoomIn /></IconBtn>
          <IconBtn label="Zoom out" onClick={() => zoom(1 / 1.35)}><ZoomOut /></IconBtn>
          <IconBtn label="Fit cabinet" onClick={() => cam.springTo(camFor("cabinet", idx, null))}><Maximize2 /></IconBtn>
          <IconBtn label="Flip front / rear (F)" onClick={() => ui.setSide(side === "F" ? "R" : "F")}><FlipHorizontal2 /></IconBtn>
        </div>

        <div className="absolute bottom-4 left-5 z-10"><Legend /></div>
        <div className="absolute bottom-4 right-5 z-10 flex items-end gap-2">
          <div className="flex gap-1">
            <IconBtn label="Previous cabinet (←)" onClick={() => idx > 0 && ui.goCabinet(idx - 1)} disabled={idx === 0}><ChevronLeft /></IconBtn>
            <IconBtn label="Next cabinet (→)" onClick={() => idx < n - 1 && ui.goCabinet(idx + 1)} disabled={idx >= n - 1}><ChevronRight /></IconBtn>
          </div>
          {vp.w > 0 && <Minimap model={model} dims={dims} cam={cam} vw={vp.w} vh={vp.h} activeIdx={idx} onPick={(i) => ui.goCabinet(i)} />}
        </div>

        {diving && <UploadDiveOverlay p={dive.progress} imp={imp} calm={calm} />}
      </div>
    </div>
  );
}

function matcher(f: ExplorerFilters): ((s: Slot) => boolean) | null {
  if (f === NO_FILTERS || (!f.io.length && !f.status.length && !f.family.length && !f.group && !f.search.trim())) return null;
  const q = f.search.trim().toLowerCase().replace(/\s+/g, "");
  return (s) =>
    (!f.io.length || f.io.includes(ioKey(s))) &&
    (!f.status.length || f.status.includes(s.status)) &&
    (!f.family.length || f.family.includes(s.family ?? "-")) &&
    (!f.group || s.group === f.group) &&
    (!q || s.tag_key.toLowerCase().includes(q) || s.cable.toLowerCase().includes(q));
}

function IconBtn({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" className="glass size-8 border-border" onClick={onClick} aria-label={label} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

function HeaderPlate({ view, side }: { view: WorldModel["cabinets"][number]; side: "F" | "R" }) {
  const c = view.counts;
  const used = c.field + c.alarm;
  const fill = (100 * (used + c.wired)) / Math.max(1, view.slots.length);
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.22, ease: EASE }}
      className="glass rounded-card border border-border px-4 py-2.5 inner-hi"
      data-testid="header-plate"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[15px] font-medium">{view.info.name}</span>
        <span className="rounded-chip bg-brand/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-brand">{side === "F" ? "FRONT" : "REAR"}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        {view.info.controller} · {view.info.system_cabinet}
      </div>
      <div className="mt-2 flex gap-4 text-[11.5px] tnum">
        <Mini k="Field" v={c.field} />
        <Mini k="Alarm" v={c.alarm} />
        <Mini k="Wired spare" v={c.wired} />
        <Mini k="Spare slot" v={c.spare} />
        <Mini k="Fill" v={`${fill.toFixed(1)}%`} />
      </div>
    </motion.div>
  );
}

function Mini({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
      <div className="font-semibold">{v}</div>
    </div>
  );
}

function Legend() {
  return (
    <div className="glass flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-card border border-border px-3 py-2 text-[11px] text-muted-foreground" data-testid="legend">
      {IO_ORDER.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="h-2.5 w-3.5 rounded-[3px]" style={{ background: IO_COLOURS[k] }} />
          {IO_LABELS[k]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="hatch h-2.5 w-3.5 rounded-[3px] border" style={{ color: IO_COLOURS.ai, borderColor: IO_COLOURS.ai }} /> Wired spare
      </span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border border-[color:var(--spare)]" /> Spare slot</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border border-dashed border-muted-foreground" /> Reserved BP</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border-2 border-brand/80" /> Family A</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border-2 border-dashed border-brand/80" /> Family B</span>
    </div>
  );
}

const STATUSES = ["Field", "Wired Spare", "Spare Slot", "Cabinet Alarm"];

function Toolbar({ model, idx, tier, side, dims, filters, onDive }: {
  model: WorldModel; idx: number; tier: Tier; side: "F" | "R"; dims: Dims; filters: ExplorerFilters; onDive: () => void;
}) {
  const ui = useUi();
  const { data: rules } = useRules();
  const view = model.cabinets[idx];
  const cioc = ui.focusCioc != null ? view?.info.ciocs.find((c) => c.local === ui.focusCioc) : null;
  const toggle = (key: "io" | "status" | "family", v: string) => {
    const cur = filters[key];
    ui.setFilters({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const strategy = rules?.settings?.cioc_strategy ?? "balanced";
  const active = filters.io.length + filters.status.length + filters.family.length + (filters.group ? 1 : 0) + (filters.search ? 1 : 0);
  return (
    <div className="border-b border-border bg-surface/50 backdrop-blur-sm">
    <div className="flex h-11 items-center gap-4 px-5">
      {/* breadcrumb */}
      <nav className="flex items-center gap-1 text-[12.5px]" aria-label="Zoom level">
        <Crumb on={tier === "plant"} onClick={() => ui.setLevel("plant")}>Plant</Crumb>
        <span className="text-muted-foreground">›</span>
        <Crumb on={tier === "cabinet"} onClick={() => ui.setLevel("cabinet")} mono>
          {view?.info.name ?? "—"} ({side})
        </Crumb>
        {tier === "detail" && (
          <>
            <span className="text-muted-foreground">›</span>
            <Crumb on mono onClick={() => undefined}>{cioc?.name ?? "CIOC"}</Crumb>
          </>
        )}
      </nav>

      {/* cabinet tabs */}
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist">
        {model.cabinets.map((c) => (
          <button
            key={c.info.name}
            role="tab"
            aria-selected={c.index === idx}
            onClick={() => ui.goCabinet(c.index)}
            className={cn(
              "shrink-0 rounded-chip border px-2 py-1 font-mono text-[11px] transition-colors",
              c.index === idx ? "border-brand/60 bg-brand/15 text-text" : "border-border text-muted-foreground hover:text-text",
            )}
          >
            {c.info.name}
          </button>
        ))}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="rounded-chip border border-border bg-raised px-2 py-1 text-[11px] text-muted-foreground" title="Rule set → Settings">
          Strategy: <span className="font-medium capitalize text-text">{strategy}</span>
        </span>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11.5px]" onClick={onDive}>
          <Sparkles className="size-3.5 text-live" /> Replay dive
        </Button>
      </div>
    </div>
      <div className="flex h-10 items-center gap-1.5 overflow-x-auto border-t border-hairline px-5">
        <span className="label-caps mr-1">Filter</span>
        {IO_ORDER.map((k) => (
          <FilterChip key={k} on={filters.io.includes(k)} onClick={() => toggle("io", k)}>
            <span className="size-2 rounded-full" style={{ background: IO_COLOURS[k as IoKey] }} />
            {IO_LABELS[k]}
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {STATUSES.map((s) => (
          <FilterChip key={s} on={filters.status.includes(s)} onClick={() => toggle("status", s)}>{s}</FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {["A", "B"].map((f) => (
          <FilterChip key={f} on={filters.family.includes(f)} onClick={() => toggle("family", f)}>Family {f}</FilterChip>
        ))}
        {model.groups.length > 0 && (
          <select
            value={filters.group ?? ""}
            onChange={(e) => ui.setFilters({ group: e.target.value || null })}
            className="h-7 rounded-chip border border-border bg-raised px-1.5 text-[11.5px] text-text outline-none focus:ring-1 focus:ring-live"
            aria-label="IO grouping"
          >
            <option value="">All groups</option>
            {model.groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <label className="flex h-7 shrink-0 items-center gap-1.5 rounded-chip border border-border bg-raised px-2 focus-within:ring-1 focus-within:ring-live">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={filters.search}
            onChange={(e) => ui.setFilters({ search: e.target.value })}
            placeholder="Tag or cable"
            className="w-28 bg-transparent font-mono text-[11.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
            data-testid="explorer-search"
          />
        </label>
        {active > 0 && (
          <button onClick={() => ui.setFilters(NO_FILTERS)} className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-text hover:underline">
            Clear {active}
          </button>
        )}
        <span className="ml-auto hidden shrink-0 pl-3 text-[11px] text-muted-foreground tnum min-[1680px]:inline">
          {model.cabinets.length} cabinets · {dims.ciocsPerCabinet} CIOC × {dims.bps} BP × {dims.channels} ch
        </span>
      </div>
    </div>
  );
}

function Crumb({ on, onClick, children, mono }: { on: boolean; onClick: () => void; children: React.ReactNode; mono?: boolean }) {
  return (
    <button onClick={onClick} className={cn("rounded-chip px-1.5 py-0.5 transition-colors", mono && "font-mono text-[12px]", on ? "bg-raised text-text" : "text-muted-foreground hover:text-text")}>
      {children}
    </button>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-chip border px-2 text-[11.5px] transition-colors",
        on ? "border-live/60 bg-live/10 text-text" : "border-border text-muted-foreground hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
