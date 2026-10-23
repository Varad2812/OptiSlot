import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { Dims, WorldModel } from "@/api/derive";
import type { Slot } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { IO_COLOURS, IO_LABELS, ioKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { demoMode, registerDemo } from "@/motion/demoHooks";
import { DIVE_KEY, EASE, isCalm } from "@/motion/shared";
import { typing } from "@/shell/useHotkeys";
import { useUi } from "@/store/ui";
import { HeaderPlate, Legend } from "@/world/Plates";

import { world3dData } from "./data";
import { World3DEngine, type Level, type Selection, type WorldEvent } from "./engine";

interface Props {
  model: WorldModel;
  dims: Dims;
  match: ((s: Slot) => boolean) | null;
  /** WebGL context could not be created → the Explorer falls back to the 2D World. */
  onFail: () => void;
}

const ROOM: Selection = { level: 0, cab: -1, cioc: -1, bp: -1, ch: -1 };

/** React wrapper for the World3DEngine: mounts it, feeds it the allocation, and draws the HTML overlay in our design system. */
export default function World3D({ model, dims, match, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const eng = useRef<World3DEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState<Selection>(ROOM);
  const [hover, setHover] = useState<WorldEvent | null>(null);
  const [diving, setDiving] = useState(false);
  const data = useMemo(() => world3dData(model, dims), [model, dims]);
  const [params, setParams] = useSearchParams();

  // mount / dispose
  useEffect(() => {
    if (!host.current) return;
    let e: World3DEngine;
    try {
      e = new World3DEngine(host.current, { calm: isCalm });
    } catch {
      onFail();
      return;
    }
    eng.current = e;
    const offs = [
      e.on("level", (s) => setSel(s)),
      e.on("hover", (h) => setHover(h)),
      e.on("select", (s) => {
        const st = useUi.getState();
        if (s.cab >= 0 && s.cab !== st.cabIdx) useUi.setState({ cabIdx: s.cab });
      }),
    ];
    const ro = new ResizeObserver(() => e.resize());
    ro.observe(host.current);
    setReady(true);
    return () => {
      offs.forEach((f) => f());
      ro.disconnect();
      e.dispose();
      eng.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) eng.current?.setData(data);
  }, [ready, data]);

  useEffect(() => {
    if (ready) eng.current?.setFilter(match);
  }, [ready, match, data]);

  // store → engine: cabinet tabs / ←→ (cabIdx) and "Show in 3D" / Inspector (inspectorSlot)
  useEffect(() => {
    if (!ready) return;
    return useUi.subscribe((st, prev) => {
      const e = eng.current;
      if (!e || e.isDiving) return;
      if (st.cabIdx !== prev.cabIdx && st.cabIdx !== e.selection.cab) void e.goTo(1, { cab: st.cabIdx });
      if (st.inspectorSlot && st.inspectorSlot !== prev.inspectorSlot && e.selectedSlotId !== st.inspectorSlot) void e.flyToSlot(st.inspectorSlot);
    });
  }, [ready]);

  // A slot already chosen elsewhere (grid "Show in 3D" before this page mounted) → fly to it once.
  useEffect(() => {
    if (!ready) return;
    const id = useUi.getState().inspectorSlot;
    if (id) void eng.current?.flyToSlot(id);
    else {
      const idx = useUi.getState().cabIdx;
      if (idx > 0 && idx < model.cabinets.length) void eng.current?.goTo(1, { cab: idx });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Upload Dive: ?dive=1, ⌘K / toolbar "Replay dive" (diveNonce), and once per session on the first visit.
  const nonce = useUi((s) => s.diveNonce);
  const lastNonce = useRef(nonce);
  useEffect(() => {
    if (!ready) return;
    let want = false;
    if (params.get("dive") === "1") {
      want = true;
      params.delete("dive");
      setParams(params, { replace: true });
    } else if (nonce !== lastNonce.current) want = true;
    else if (!demoMode && !useUi.getState().inspectorSlot) {
      try {
        if (!sessionStorage.getItem(DIVE_KEY)) want = true;
      } catch {
        /* storage blocked → no autoplay */
      }
    }
    lastNonce.current = nonce;
    if (!want) return;
    try {
      sessionStorage.setItem(DIVE_KEY, "1");
    } catch {
      /* ignore */
    }
    void dive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, nonce]);

  async function dive() {
    const e = eng.current;
    if (!e) return;
    useUi.getState().inspect(null);
    setDiving(true);
    await e.playDive();
    setDiving(false);
  }

  // keys: Esc closes the Inspector first, then steps out one level
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented || typing(ev) || useUi.getState().paletteOpen) return;
      const st = useUi.getState();
      if (st.inspectorSlot) return st.inspect(null);
      eng.current?.back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ?demo=1 hooks (Playwright: frames + FPS)
  useEffect(() => {
    if (!demoMode || !ready) return;
    return registerDemo("world3d", {
      ready: () => eng.current?.stats().firstFrameMs != null,
      goTo: (l: Level, a: object) => eng.current?.goTo(l, a),
      playDive: () => dive(),
      skipDive: () => eng.current?.skipDive(),
      flyToSlot: (id: string) => eng.current?.flyToSlot(id),
      stats: () => eng.current?.stats(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const view = sel.cab >= 0 ? model.cabinets[sel.cab] : null;
  const cab3 = sel.cab >= 0 ? data.cabinets[sel.cab] : null;
  const cioc = cab3 && sel.cioc > 0 ? cab3.ciocs[sel.cioc - 1] : null;
  const selSlot = useMemo(() => {
    if (sel.level !== 4 || !view) return null;
    return view.slots.find((s) => s.cioc_local === sel.cioc && s.bp === sel.bp && s.ch === sel.ch) ?? null;
  }, [sel, view]);
  const go = (l: Level) => void eng.current?.goTo(l);

  const crumbs: { label: string; level: Level; mono?: boolean }[] = [{ label: "Room", level: 0 }];
  if (sel.level >= 1 && view) crumbs.push({ label: view.info.name, level: 1, mono: true });
  if (sel.level >= 2 && cioc) crumbs.push({ label: `${cioc.name} (${cioc.side})`, level: 2, mono: true });
  if (sel.level >= 3 && cioc) crumbs.push({ label: cioc.baseplates[sel.bp - 1]?.name ?? `BP ${sel.bp}`, level: 3, mono: true });
  if (sel.level >= 4) crumbs.push({ label: `CH ${sel.ch}`, level: 4, mono: true });

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="world3d">
      <div ref={host} className="absolute inset-0" />
      {/* vignette, as in the prototype */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,.55))]" />

      <div className="pointer-events-none absolute left-5 top-4 z-10 flex flex-col gap-2">
        <nav className="glass pointer-events-auto flex items-center gap-1 self-start rounded-card border border-border px-2 py-1 text-[12.5px] inner-hi" aria-label="Zoom level" data-testid="room-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.level} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">›</span>}
              <button
                onClick={() => c.level < sel.level && go(c.level)}
                className={cn(
                  "rounded-chip px-1.5 py-0.5 transition-colors",
                  c.mono && "font-mono text-[12px]",
                  c.level === sel.level ? "bg-raised text-text" : "text-muted-foreground hover:text-text",
                )}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <AnimatePresence mode="wait">
          {view && sel.level === 1 && !diving && <HeaderPlate key={view.info.name} view={view} side="F" />}
        </AnimatePresence>
      </div>

      <div className="absolute right-5 top-4 z-10 flex gap-1.5">
        {sel.level > 0 && !diving && (
          <Button variant="outline" size="sm" className="glass h-8 gap-1 border-border px-2.5 text-[12px]" onClick={() => eng.current?.back()}>
            <ArrowLeft className="size-3.5" /> Back <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">Esc</kbd>
          </Button>
        )}
      </div>

      <div className="absolute bottom-4 left-5 z-10"><Legend /></div>
      <div className="pointer-events-none absolute bottom-4 right-5 z-10 text-[11px] text-muted-foreground">
        {diving ? "Upload Dive — press any key to skip" : "Click to zoom in · drag to orbit · right-drag to pan · scroll to dolly"}
      </div>

      <AnimatePresence>{selSlot && !diving && <CharmPanel key={selSlot.id} slot={selSlot} />}</AnimatePresence>
      {hover && !diving && <HoverCard h={hover} model={model} data={data} />}
    </div>
  );
}

function Row({ k, children, mono }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("m-0 truncate text-right", mono && "font-mono text-[11.5px]")}>{children}</dd>
    </>
  );
}

function IoChip({ s }: { s: Slot }) {
  const k = ioKey(s);
  const c = IO_COLOURS[k];
  return (
    <span className="inline-block rounded-full border px-2 text-[11px]" style={{ borderColor: c, color: c }}>
      {s.status === "Field" || s.status === "Wired Spare" ? IO_LABELS[k] : s.status}
    </span>
  );
}

/** L4: allocation data for the selected CHARM (no live values — we are not a DCS). "Why here?" opens the Inspector. */
function CharmPanel({ slot }: { slot: Slot }) {
  const inspect = useUi((s) => s.inspect);
  return (
    <motion.aside
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="glass absolute right-5 top-16 z-10 w-[280px] rounded-card border border-border p-4 inner-hi"
      data-testid="charm-panel"
    >
      <div className="font-mono text-[15px] font-medium">{slot.tag}</div>
      <div className="mb-3 font-mono text-[11px] text-muted-foreground">
        {slot.cioc} · {slot.baseplate} · CH {slot.ch}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[12px]">
        <Row k="IO"><IoChip s={slot} /></Row>
        <Row k="Status">{slot.status}</Row>
        <Row k="CHARM" mono>{slot.charm}</Row>
        <Row k=""><span className="text-[11px] text-muted-foreground">{slot.charm_desc || "—"}</span></Row>
        <Row k="TB" mono>{slot.tb}</Row>
        <Row k="Cable" mono>{slot.cable}</Row>
        <Row k="Pair" mono>{slot.pair_label}</Row>
        <Row k="CHARM No" mono>{slot.charm_no}</Row>
        <Row k="Cabinet" mono>{slot.cabinet}</Row>
      </dl>
      <Button size="sm" className="mt-3.5 h-8 w-full gap-1.5 text-[12px]" onClick={() => inspect(slot.id)}>
        <Info className="size-3.5" /> Why here?
      </Button>
    </motion.aside>
  );
}

/** Hover card (§10.8): a CHARM shows its allocation row; higher levels show counts, fill and A/B mix. */
function HoverCard({ h, model, data }: { h: WorldEvent; model: WorldModel; data: ReturnType<typeof world3dData> }) {
  const view = model.cabinets[h.cab];
  if (!view) return null;
  const cab = data.cabinets[h.cab];
  let body: React.ReactNode;
  if (h.level === 4) {
    const s = h.slotId ? model.bySlotId.get(h.slotId) : null;
    if (!s) return null;
    body = (
      <>
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[12.5px] font-medium">{s.tag}</span>
          <IoChip s={s} />
        </div>
        <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">
          {s.charm} · {s.tb} · {s.cable === "-" ? "no cable" : `${s.cable} / ${s.pair_label}`}
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
          {s.baseplate} · CH {s.ch} · No {s.charm_no}
        </div>
      </>
    );
  } else if (h.level === 1) {
    const c = view.counts;
    const fill = (100 * (c.field + c.alarm + c.wired)) / Math.max(1, view.slots.length);
    const fams = new Set(view.info.ciocs.map((x) => x.family).filter((f) => f !== "-"));
    body = (
      <>
        <div className="font-mono text-[12.5px] font-medium">{view.info.name}</div>
        <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{view.info.controller}</div>
        <div className="mt-1.5 text-[11px] tnum text-muted-foreground">
          {view.info.ciocs.length} CIOC · {c.field} field · {c.wired} wired spare · {c.spare} spare · fill {fill.toFixed(1)}%
          {fams.size > 0 && ` · ${[...fams].sort().join("/")}`}
        </div>
      </>
    );
  } else {
    const ci = cab.ciocs[h.cioc - 1];
    if (!ci) return null;
    const bp = h.level === 3 ? ci.baseplates[h.bp - 1] : null;
    const runs = h.level === 3 ? cab.runs[h.cioc - 1][h.bp - 1] : [];
    body = bp ? (
      <>
        <div className="font-mono text-[12.5px] font-medium">{bp.name}</div>
        <div className="mt-1 text-[11px] tnum text-muted-foreground">
          {bp.used} used · {bp.wired_spares} wired spare{bp.reserved ? ` · reserved (${bp.reserved === "future" ? "future spare" : "cabinet alarm"})` : ""}
        </div>
        {runs.length > 0 && <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{runs.map((r) => r.cable).join(" · ")}</div>}
      </>
    ) : (
      <>
        <div className="font-mono text-[12.5px] font-medium">{ci.name}</div>
        <div className="mt-1 text-[11px] tnum text-muted-foreground">
          {ci.side === "F" ? "Front" : "Rear"} · family {ci.family} · {ci.used} used · {ci.wired_spares} wired spare · fill{" "}
          {((100 * (ci.used + ci.wired_spares)) / Math.max(1, ci.capacity)).toFixed(0)}%
        </div>
      </>
    );
  }
  return (
    <div
      className="glass pointer-events-none absolute z-20 max-w-[320px] rounded-card border border-border px-3 py-2 inner-hi"
      style={{ left: h.screen.x + 14, top: h.screen.y + 14 }}
      data-testid="room-hover"
    >
      {body}
      <div className="mt-1 text-[10px] uppercase tracking-wider text-live/80">{h.level === 4 ? "Click to open" : "Click to zoom in"}</div>
    </div>
  );
}
