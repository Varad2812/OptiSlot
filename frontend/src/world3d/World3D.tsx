import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, FlaskConical, Info, Minus, Play, Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import type { Dims, WorldModel } from "@/api/derive";
import type { Slot } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { IO_COLOURS, IO_LABELS, ioKey, type IoKey } from "@/lib/io";
import { cn } from "@/lib/utils";
import { demoMode, registerDemo } from "@/motion/demoHooks";
import { DIVE_KEY, EASE, isCalm } from "@/motion/shared";
import { typing } from "@/shell/useHotkeys";
import { useUi } from "@/store/ui";
import { HeaderPlate, Legend } from "@/world/Plates";

import { world3dData, type World3DData } from "./data";
import { World3DEngine, type Level, type Selection, type WorldEvent } from "./engine";

/** Before | Now overlay (§10.8): slots that replace the allocation's, outlined changed CHARMs, ghosts at old slots. */
export interface Overlay3D {
  slots?: Slot[] | null;
  outline?: string[];
  ghosts?: string[];
}

interface Props {
  model: WorldModel;
  dims: Dims;
  match: ((s: Slot) => boolean) | null;
  /** WebGL could not start, or the FPS stayed under 30 even without bloom → the page falls back to the 2D World. */
  onFail: (why: "webgl" | "slow") => void;
  /** The 3D Room page (§10.8): full HUD — title plate, tag search, zoom ±, Replay dive, selection card, IO filter legend. */
  room?: boolean;
  overlay?: Overlay3D | null;
  /** Extra HUD controls at the top right (the Room's Before | Now toggle). */
  hudRight?: React.ReactNode;
  onEngine?: (e: World3DEngine | null) => void;
}

const ROOM: Selection = { level: 0, cab: -1, cioc: -1, bp: -1, ch: -1, face: "F" };
const allowFallbackInDemo = (() => {
  try {
    return new URLSearchParams(window.location.search).get("fallback") === "1";
  } catch {
    return false;
  }
})();

/** React wrapper for the World3DEngine: mounts it, feeds it the allocation, and draws the HTML overlay in our design system. */
export default function World3D({ model, dims, match, onFail, room, overlay, hudRight, onEngine }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const eng = useRef<World3DEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState<Selection>(ROOM);
  const [diving, setDiving] = useState(false);
  const data = useMemo(() => world3dData(model, dims), [model, dims]);
  const [params, setParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const card = useHoverCard();
  const slow = useRef(false); // demo hook: pretend the GPU is slow (tests the fallback)

  // mount / dispose
  useEffect(() => {
    if (!host.current) return;
    let e: World3DEngine;
    try {
      e = new World3DEngine(host.current, { calm: isCalm });
    } catch {
      onFail("webgl");
      return;
    }
    eng.current = e;
    const offs = [
      e.on("level", (s) => (setSel(s), card.clear())),
      e.on("hover", (h) => card.feed(h)),
      e.on("select", (s) => {
        const st = useUi.getState();
        if (s.cab >= 0 && s.cab !== st.cabIdx) useUi.setState({ cabIdx: s.cab });
      }),
    ];
    const ro = new ResizeObserver(() => e.resize());
    ro.observe(host.current);
    setReady(true);
    onEngine?.(e);
    return () => {
      offs.forEach((f) => f());
      ro.disconnect();
      onEngine?.(null);
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
    if (ready) eng.current?.setOverlay(overlay ?? {});
  }, [ready, data, overlay]);

  useEffect(() => {
    if (ready) eng.current?.setFilter(match);
  }, [ready, match, data, overlay]);

  // store → engine: cabinet tabs (cabIdx) and "Show in 3D" / Inspector (inspectorSlot)
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
    card.clear();
    setDiving(true);
    await e.playDive();
    setDiving(false);
  }

  // keys (§10.7 item 4): ←/→ sibling at the current level · F other face · / tag search · Esc Inspector first, then up one level
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || typing(ev) || useUi.getState().paletteOpen || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const e = eng.current;
      if (!e) return;
      if (ev.key === "Escape") {
        const st = useUi.getState();
        if (st.inspectorSlot) return st.inspect(null);
        e.back();
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        e.sibling(ev.key === "ArrowRight" ? 1 : -1);
      } else if (ev.key.toLowerCase() === "f") e.flip();
    };
    // "/" belongs to the Room's own tag search here (the global handler would open the palette): capture phase, first.
    const onSlash = (ev: KeyboardEvent) => {
      if (!room || ev.key !== "/" || typing(ev) || useUi.getState().paletteOpen) return;
      ev.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onSlash, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSlash, true);
    };
  }, [room]);

  // FPS fallback (§10.7 item 6): under 30 fps for 3 s → bloom off; still under 30 for another 3 s → the 2D World.
  useEffect(() => {
    if (!ready || (demoMode && !allowFallbackInDemo)) return;
    let since = 0, stage = 0, start = performance.now();
    const onVis = () => ((start = performance.now()), (since = 0));
    document.addEventListener("visibilitychange", onVis);
    const iv = window.setInterval(() => {
      const e = eng.current;
      const now = performance.now();
      if (!e || document.hidden || now - start < 2500) return;
      const fps = slow.current ? 12 : e.stats().fps;
      if (fps >= 30) return void (since = 0);
      if (!since) return void (since = now);
      if (now - since < 3000) return;
      since = 0;
      if (stage++ === 0) {
        e.setBloom(false);
        toast("3D is running slowly here — bloom switched off");
      } else {
        window.clearInterval(iv);
        toast("3D stayed under 30 fps — switched to the 2D World", { description: "Use the 3D | 2D toggle to try 3D again." });
        onFail("slow");
      }
    }, 500);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ?demo=1 hooks (Playwright: frames + FPS)
  useEffect(() => {
    if (!demoMode || !ready) return;
    return registerDemo("world3d", {
      ready: () => eng.current?.stats().firstFrameMs != null,
      goTo: (l: Level, a: object) => eng.current?.goTo(l, a),
      playDive: () => dive(),
      skipDive: () => eng.current?.skipDive(),
      flyToSlot: (id: string) => eng.current?.flyToSlot(id),
      sibling: (d: 1 | -1) => eng.current?.sibling(d),
      flip: () => eng.current?.flip(),
      animateMove: (from: string[], to: string[]) => eng.current?.animateMove(from, to),
      hoverAt: (x: number, y: number) => {
        const cv = host.current?.querySelector("canvas");
        const r = cv?.getBoundingClientRect();
        if (cv && r) cv.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
      },
      simulateSlow: () => (slow.current = true),
      stats: () => eng.current?.stats(),
      selection: () => eng.current?.selection,
      engine: () => eng.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const view = sel.cab >= 0 ? model.cabinets[sel.cab] : null;
  const cab3 = sel.cab >= 0 ? data.cabinets[sel.cab] : null;
  const cioc = cab3 && sel.cioc > 0 ? cab3.ciocs[sel.cioc - 1] : null;
  const selSlot = useMemo(() => {
    if (sel.level !== 4 || !eng.current) return null;
    const id = eng.current.selectedSlotId;
    return (id && (overlay?.slots?.find((s) => s.id === id) ?? model.bySlotId.get(id))) || null;
  }, [sel, model, overlay]);
  const go = (l: Level) => void eng.current?.goTo(l);

  const crumbs: { label: string; level: Level; mono?: boolean }[] = [{ label: "Room", level: 0 }];
  if (sel.level >= 1 && view) crumbs.push({ label: view.info.name, level: 1, mono: true });
  if (sel.level >= 2 && cioc) crumbs.push({ label: `${cioc.name} (${cioc.side})`, level: 2, mono: true });
  if (sel.level >= 3 && cioc) crumbs.push({ label: cioc.baseplates[sel.bp - 1]?.name ?? `BP ${sel.bp}`, level: 3, mono: true });
  if (sel.level >= 4) crumbs.push({ label: `CH ${sel.ch}`, level: 4, mono: true });

  const filters = useUi((s) => s.filters);
  const toggleIo = (k: IoKey) => useUi.getState().setFilters({ io: filters.io.length === 1 && filters.io[0] === k ? [] : [k] });

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="world3d">
      <div ref={host} className="absolute inset-0" />
      {/* vignette, as in the prototype */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,.55))]" />

      <div className="pointer-events-none absolute left-5 top-4 z-10 flex flex-col gap-2">
        {room && (
          <div className="select-none text-[12px] font-semibold tracking-[0.18em] text-text" data-testid="room-title">
            MARSHALLING <span className="text-brand">ROOM</span>
          </div>
        )}
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
          {!room && view && sel.level === 1 && !diving && <HeaderPlate key={`${view.info.name}-${sel.face}`} view={view} side={sel.face} />}
        </AnimatePresence>
      </div>

      <div className="absolute right-5 top-4 z-10 flex items-center gap-1.5" data-testid="room-hud">
        {room && hudRight}
        {room && <TagSearch inputRef={searchRef} model={model} onPick={(s) => void eng.current?.flyToSlot(s.id)} />}
        {room && (
          <>
            <HudBtn label="Zoom in" onClick={() => eng.current?.zoom(0.3)}><Plus className="size-3.5" /></HudBtn>
            <HudBtn label="Zoom out" onClick={() => eng.current?.zoom(-0.4)}><Minus className="size-3.5" /></HudBtn>
            <HudBtn label="Turn to the other face (F)" onClick={() => eng.current?.flip()}><RotateCw className="size-3.5" /></HudBtn>
          </>
        )}
        {sel.level > 0 && !diving && (
          <Button variant="outline" size="sm" className="glass h-8 gap-1 border-border px-2.5 text-[12px]" onClick={() => eng.current?.back()}>
            <ArrowLeft className="size-3.5" /> Back <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">Esc</kbd>
          </Button>
        )}
        {room && (
          <Button size="sm" className="h-8 gap-1.5 px-3 text-[12px]" onClick={() => useUi.getState().replayDive()} disabled={diving} data-testid="room-dive">
            <Play className="size-3.5 fill-current" /> Replay dive
          </Button>
        )}
      </div>

      <div className="absolute bottom-4 left-5 z-10">{room ? <Legend active={filters.io} onToggle={toggleIo} /> : <Legend />}</div>
      <div className="pointer-events-none absolute bottom-4 right-5 z-10 text-right text-[11px] text-muted-foreground" data-testid="room-hint">
        {diving
          ? "Upload Dive — press any key to skip"
          : room
            ? "Click to zoom in · ←/→ siblings · F other face · / find tag · drag to orbit · scroll to dolly"
            : "Click to zoom in · ←/→ siblings · F other face · drag to orbit · scroll to dolly"}
      </div>

      <AnimatePresence>
        {selSlot && !diving && <CharmPanel key={selSlot.id} slot={selSlot} model={model} dims={dims} />}
        {room && !selSlot && !diving && <SelectionCard key={`${sel.level}-${sel.cab}-${sel.cioc}-${sel.bp}`} sel={sel} model={model} data={data} dims={dims} />}
      </AnimatePresence>
      {card.h && !diving && (
        <HoverCard h={card.h} model={model} data={data} dims={dims} overlay={overlay} hostW={host.current?.clientWidth ?? 0} hostH={host.current?.clientHeight ?? 0} lock={card.lock} />
      )}
    </div>
  );
}

// ───────────── hover card state ─────────────

const keyOf = (h: WorldEvent | null) => (h ? `${h.level}/${h.cab}/${h.cioc}/${h.bp}/${h.ch}` : "");

/**
 * The hover card stays put while the pointer is on the same object (it only moves when the target changes, after a short
 * settle), and it locks while the pointer is on it — so its "Try changes" button can be reached and clicked.
 */
function useHoverCard() {
  const [h, setH] = useState<WorldEvent | null>(null);
  const cur = useRef("");
  const locked = useRef(false);
  const timer = useRef(0);
  return useMemo(() => {
    const feed = (e: WorldEvent | null) => {
      if (locked.current) return;
      const k = keyOf(e);
      window.clearTimeout(timer.current);
      if (k === cur.current) return;
      timer.current = window.setTimeout(() => {
        if (locked.current) return;
        cur.current = k;
        setH(e);
      }, e ? 110 : 260);
    };
    const clear = () => {
      window.clearTimeout(timer.current);
      locked.current = false;
      cur.current = "";
      setH(null);
    };
    const lock = (on: boolean) => {
      locked.current = on;
      if (!on) clear();
    };
    return { h, feed, clear, lock };
  }, [h]);
}

// ───────────── pieces ─────────────

function HudBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant="outline" size="icon" className="glass size-8 border-border" onClick={onClick} aria-label={label} title={label}>
      {children}
    </Button>
  );
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** "/" → find a tag: suggestions from the live allocation, Enter flies to the first match; no match shakes. */
function TagSearch({ inputRef, model, onPick }: { inputRef: React.RefObject<HTMLInputElement>; model: WorldModel; onPick: (s: Slot) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [bad, setBad] = useState(0);
  const [hi, setHi] = useState(0);
  const hits = useMemo(() => {
    const n = norm(q);
    if (!n) return [];
    const out: Slot[] = [];
    for (const cab of model.cabinets)
      for (const s of cab.slots) {
        if (s.status === "Spare Slot") continue;
        if (norm(s.tag_key).includes(n) || norm(s.cable).includes(n)) out.push(s);
        if (out.length >= 7) return out;
      }
    return out;
  }, [q, model]);
  const pick = (s: Slot | undefined) => {
    if (!s) return setBad((b) => b + 1);
    onPick(s);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };
  return (
    <div className="relative">
      <label key={bad} className={cn("glass flex h-8 items-center gap-1.5 rounded-card border border-border px-2 focus-within:ring-1 focus-within:ring-live", bad > 0 && "shake border-err/70")}>
        <Search className="size-3.5 text-muted-foreground" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => (setQ(e.target.value), setOpen(true), setHi(0))}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pick(hits[hi]);
            else if (e.key === "ArrowDown") (e.preventDefault(), setHi((i) => Math.min(hits.length - 1, i + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setHi((i) => Math.max(0, i - 1)));
            else if (e.key === "Escape") (setQ(""), inputRef.current?.blur());
            e.stopPropagation();
          }}
          placeholder="Find tag"
          className="w-40 bg-transparent font-mono text-[11.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
          data-testid="room-search"
          spellCheck={false}
          autoComplete="off"
        />
        <kbd className="font-mono text-[10px] text-muted-foreground">/</kbd>
      </label>
      {open && hits.length > 0 && (
        <div className="glass absolute right-0 top-9 z-30 w-72 overflow-hidden rounded-card border border-border py-1 inner-hi" data-testid="room-search-hits">
          {hits.map((s, i) => (
            <button
              key={s.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              onMouseEnter={() => setHi(i)}
              className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left", i === hi && "bg-raised")}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: IO_COLOURS[ioKey(s)] }} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{s.tag}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{s.baseplate} · {s.ch}</span>
            </button>
          ))}
        </div>
      )}
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

/** "Try changes" (§10.8): the Try-out Lab with the signal (or the slot / cabinet) preselected. */
function useTryChanges(dims: Dims) {
  const nav = useNavigate();
  return (a: { cab: number; cioc: number; bp: number; ch: number }, model: WorldModel, slot?: Slot | null) => {
    const view = model.cabinets[a.cab];
    const q = new URLSearchParams();
    if (slot && slot.status !== "Spare Slot" && slot.tag !== "-") q.set("tag", slot.tag);
    else if (slot) q.set("slot", slot.id);
    else if (view) {
      q.set("cabinet", view.info.name);
      if (a.cioc > 0) q.set("cioc", String(a.cioc));
      if (a.bp > 0) q.set("bp", String(a.bp));
    }
    if (a.cab >= 0) useUi.setState({ cabIdx: a.cab, side: a.cioc > dims.ciocsPerSide ? "R" : "F" });
    nav(`/lab?${q.toString()}`);
  };
}

function TryBtn({ onClick, wide }: { onClick: () => void; wide?: boolean }) {
  return (
    <Button size="sm" className={cn("h-7 gap-1.5 px-2.5 text-[11.5px]", wide && "w-full")} onClick={onClick} data-testid="try-changes">
      <FlaskConical className="size-3.5" /> Try changes
    </Button>
  );
}

/** L4: allocation data for the selected CHARM (no live values — we are not a DCS). "Why here?" opens the Inspector. */
function CharmPanel({ slot, model, dims }: { slot: Slot; model: WorldModel; dims: Dims }) {
  const inspect = useUi((s) => s.inspect);
  const tryChanges = useTryChanges(dims);
  const cab = model.cabIndexByName.get(slot.cabinet) ?? 0;
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
      <div className="mt-3.5 grid grid-cols-2 gap-2">
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={() => inspect(slot.id)}>
          <Info className="size-3.5" /> Why here?
        </Button>
        <Button size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => tryChanges({ cab, cioc: slot.cioc_local, bp: slot.bp, ch: slot.ch }, model, slot)} data-testid="try-changes">
          <FlaskConical className="size-3.5" /> Try changes
        </Button>
      </div>
    </motion.aside>
  );
}

interface Desc {
  title: string;
  mono: boolean;
  sub?: string;
  stats: [string, React.ReactNode][];
  chips?: { label: string; colour: string }[];
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;

/** Counts, fill and A/B mix for a level above the CHARM (hover card and selection card share it). */
function describe(level: Level, a: { cab: number; cioc: number; bp: number }, model: WorldModel, data: World3DData): Desc | null {
  if (level === 0) {
    let f = 0, al = 0, w = 0, sp = 0, slots = 0, ciocs = 0;
    for (const c of model.cabinets) (f += c.counts.field), (al += c.counts.alarm), (w += c.counts.wired), (sp += c.counts.spare), (slots += c.slots.length), (ciocs += c.info.ciocs.length);
    const ctrls = new Set(model.cabinets.map((c) => c.info.controller)).size;
    return {
      title: "Marshalling room", mono: false, sub: `${model.cabinets.length} cabinets · ${ctrls} controller${ctrls === 1 ? "" : "s"} · ${ciocs} CIOCs`,
      stats: [["Field", f], ["Alarm", al], ["Wired spare", w], ["Spare slot", sp], ["Fill", pct(f + al + w, slots)]],
    };
  }
  const view = model.cabinets[a.cab], cab = data.cabinets[a.cab];
  if (!view || !cab) return null;
  if (level === 1) {
    const c = view.counts;
    const fams = [...new Set(view.info.ciocs.map((x) => x.family).filter((x) => x !== "-"))].sort();
    return {
      title: view.info.name, mono: true, sub: `${view.info.controller} · ${view.info.ciocs.length} CIOC`,
      stats: [["Field", c.field], ["Alarm", c.alarm], ["Wired", c.wired], ["Spare", c.spare], ["Fill", pct(c.field + c.alarm + c.wired, view.slots.length)]],
      chips: fams.map((x) => ({ label: `Family ${x}`, colour: "#C9BDFF" })),
    };
  }
  const ci = cab.ciocs[a.cioc - 1];
  if (!ci) return null;
  if (level === 2)
    return {
      title: ci.name, mono: true, sub: `${ci.side === "F" ? "Front" : "Rear"} · ${ci.baseplates.length} baseplates${ci.family !== "-" ? ` · family ${ci.family}` : ""}`,
      stats: [["Used", ci.used], ["Wired", ci.wired_spares], ["Capacity", ci.capacity], ["Fill", pct(ci.used + ci.wired_spares, ci.capacity)]],
    };
  const bp = ci.baseplates[a.bp - 1];
  if (!bp) return null;
  const runs = cab.runs[a.cioc - 1]?.[a.bp - 1] ?? [];
  return {
    title: bp.name, mono: true,
    sub: bp.reserved ? `reserved · ${bp.reserved === "future" ? "future spare" : "cabinet alarm"}` : runs.length ? runs.map((r) => r.cable).join(" · ") : "no cable",
    stats: [["Used", bp.used], ["Wired", bp.wired_spares], ["Fill", pct(bp.used + bp.wired_spares, data.layout.M)]],
    chips: runs.map((r) => ({ label: r.cable, colour: IO_COLOURS[r.io] })),
  };
}

function DescBody({ d }: { d: Desc }) {
  return (
    <>
      <div className={cn("text-[13px] font-medium", d.mono && "font-mono text-[12.5px]")}>{d.title}</div>
      {d.sub && <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{d.sub}</div>}
      <div className="mt-2 flex gap-3.5 text-[11.5px] tnum">
        {d.stats.map(([k, v]) => (
          <div key={k}>
            <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{k}</div>
            <div className="font-semibold">{v}</div>
          </div>
        ))}
      </div>
      {d.chips && d.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {d.chips.slice(0, 6).map((c) => (
            <span key={c.label} className="rounded-full border px-1.5 font-mono text-[10px]" style={{ borderColor: `${c.colour}66`, color: c.colour }}>{c.label}</span>
          ))}
        </div>
      )}
    </>
  );
}

/** Room HUD (L0–L3): what is in focus, with Try changes. L4 shows the CHARM panel instead. */
function SelectionCard({ sel, model, data, dims }: { sel: Selection; model: WorldModel; data: World3DData; dims: Dims }) {
  const tryChanges = useTryChanges(dims);
  const d = describe(sel.level, sel, model, data);
  if (!d) return null;
  return (
    <motion.aside
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="glass absolute right-5 top-16 z-10 w-[280px] rounded-card border border-border p-3.5 inner-hi"
      data-testid="selection-card"
    >
      <DescBody d={d} />
      <div className="mt-3">
        <TryBtn wide onClick={() => tryChanges(sel.level === 0 ? { cab: Math.max(0, useUi.getState().cabIdx), cioc: -1, bp: -1, ch: -1 } : sel, model)} />
      </div>
    </motion.aside>
  );
}

/** Hover card (§10.8): a CHARM shows its allocation row; higher levels show counts, fill and A/B mix. Every card has Try changes. */
function HoverCard({ h, model, data, dims, overlay, hostW, hostH, lock }: {
  h: WorldEvent; model: WorldModel; data: World3DData; dims: Dims; overlay?: Overlay3D | null; hostW: number; hostH: number; lock: (on: boolean) => void;
}) {
  const tryChanges = useTryChanges(dims);
  let body: React.ReactNode;
  let slot: Slot | null = null;
  if (h.level === 4) {
    slot = (h.slotId && (overlay?.slots?.find((s) => s.id === h.slotId) ?? model.bySlotId.get(h.slotId))) || null;
    if (!slot) return null;
    const s = slot;
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
          {s.baseplate} · CH {s.ch} · No {s.charm_no} · {s.status}
        </div>
      </>
    );
  } else {
    const d = describe(h.level, h, model, data);
    if (!d) return null;
    body = <DescBody d={d} />;
  }
  const W = 300;
  const left = h.screen.x + 12 + W > hostW - 8 ? Math.max(8, h.screen.x - 12 - W) : h.screen.x + 12;
  // Baseplate / CHARM level: the card sits above the pointer — below it hang the CHARM tags it would cover.
  const above = h.level >= 3 && h.screen.y > 190;
  const top = above ? h.screen.y - 12 : Math.min(h.screen.y + 12, Math.max(8, hostH - 150));
  return (
    <div
      className={cn("glass absolute z-20 rounded-card border border-border px-3 py-2.5 inner-hi", above && "-translate-y-full")}
      style={{ left, top, width: W }}
      onPointerEnter={() => lock(true)}
      onPointerLeave={() => lock(false)}
      data-testid="room-hover"
    >
      {body}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-live/80">{h.level === 4 ? "Click to open" : "Click to zoom in"}</span>
        <TryBtn onClick={() => tryChanges(h, model, slot)} />
      </div>
    </div>
  );
}
