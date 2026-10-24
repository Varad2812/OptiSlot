import { useQuery } from "@tanstack/react-query";
import { animate, motion } from "framer-motion";
import { ArrowRight, Box, Download, LayoutDashboard, Moon, Sun, Upload, WifiOff } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject, useRuns, type AllocationResult } from "@/api/hooks";
import { useRevisionImpact } from "@/api/sandbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EASE, useCalm } from "@/motion/shared";
import { Logo } from "@/shell/TopBar";
import { useUi } from "@/store/ui";
import { openInRoom } from "@/world/actions";
import { hasWebGL } from "@/world3d/support";

import { isMdb, MDB_ACCEPT } from "./Import";

const MiniRoom = lazy(() => import("@/world3d/MiniRoom"));

/** The launch page orbits a few more cabinets than the Mission Control card: it is the whole screen. */
const HERO_CABINETS = 8;

/**
 * Launch page (CLAUDE.md §10.10), ported from legacy3d/reference_launch.html: the live marshalling room orbits behind the promise,
 * the hook cards carry the loaded project's real numbers (a hook without data is not shown), and Import MDB / a file dropped
 * anywhere hands the file to Import & Mapping. With no project the room is the bundled demo allocation — never an empty page.
 */
export default function Hero() {
  const nav = useNavigate();
  const calm = useCalm();
  const { data: a, isError } = useAllocation();
  const { data: p } = useProject();
  const offline = useUi((s) => s.offline);
  // background only: the demo allocation the app ships with (the hooks never read it)
  const { data: demoAlloc } = useQuery({
    queryKey: ["hero-fixture"],
    queryFn: () => import("@/mock/allocation.json").then((m) => m.default as unknown as AllocationResult),
    enabled: !a && isError,
    staleTime: Infinity,
  });
  const bg = a ?? demoAlloc;
  const dims = useMemo(() => dimsOf(bg, a ? p : undefined), [bg, a, p]);
  const model = useMemo(() => (bg ? worldModel(bg, dims) : null), [bg, dims]);
  const [flat, setFlat] = useState(!hasWebGL());
  const [wide, setWide] = useState(() => window.innerWidth > 900);
  useEffect(() => {
    const on = () => setWide(window.innerWidth > 900);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // Import MDB / drop anywhere → Import & Mapping reads the file on arrival (store.pendingMdb)
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hand = (files: FileList | File[] | null | undefined) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const f = list.find(isMdb);
    if (!f) return void toast.error("Not an MDB file", { description: "Drop an .xlsx or .csv IO MDB." });
    useUi.getState().setPendingMdb(f);
    nav("/import");
  };
  const handRef = useRef(hand);
  handRef.current = hand;
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => files(e) && (e.preventDefault(), depth++, setOver(true));
    const leave = (e: DragEvent) => files(e) && --depth <= 0 && ((depth = 0), setOver(false));
    const overFn = (e: DragEvent) => files(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      handRef.current(e.dataTransfer?.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const openDemo = () => {
    if (useUi.getState().projectId !== "demo") useUi.getState().setProject("demo");
    nav("/mission");
  };

  const t = (d: number) => ({ duration: calm ? 0.15 : 0.6, delay: calm ? 0 : d, ease: EASE });
  return (
    <div className="relative h-full overflow-hidden bg-[#0A0D13] text-text" data-testid="hero">
      {/* the room: real engine, low-cost mode, orbiting; a click on a cabinet dives into the 3D Room */}
      <div className="absolute inset-0" data-testid="hero-room">
        {model && !flat ? (
          <Suspense fallback={null}>
            <MiniRoom model={model} dims={dims} hot={null} onHot={() => {}} onPick={(c) => openInRoom(nav, c)} onFail={() => setFlat(true)} orbit offsetX={wide ? 0.17 : 0} labels={false} cabinets={HERO_CABINETS} />
          </Suspense>
        ) : (
          <FlatFloor />
        )}
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(0,0,0,.6))]" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: wide
            ? "linear-gradient(90deg, rgb(var(--bg) / .9), rgb(var(--bg) / .5) 38%, transparent 66%), linear-gradient(0deg, rgb(var(--bg) / .82), transparent 34%)"
            : "linear-gradient(180deg, rgb(var(--bg) / .88), rgb(var(--bg) / .35) 55%, rgb(var(--bg) / .85))",
        }}
      />

      {/* brand + way into the app */}
      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-4 px-[clamp(16px,3vw,40px)] pt-5">
        <Link to="/mission" className="flex items-center gap-2.5" aria-label="OptiSlot — Mission Control">
          <span className="grid size-8 place-items-center rounded-[9px] bg-surface/80 shadow-[0_0_18px_rgb(var(--brand)/.4)] ring-1 ring-border">
            <Logo className="size-5" />
          </span>
          <span className="text-[16px] font-bold tracking-tight">OptiSlot</span>
          <span className="ml-1 hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">Allocate · Prove · Revise</span>
        </Link>
        <nav className="flex items-center gap-1.5" aria-label="Open the app">
          {offline && (
            <span className="mr-1 flex items-center gap-1 rounded-chip border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              <WifiOff className="size-3" /> Offline — saved demo data
            </span>
          )}
          {a && (
            <span className="glass mr-1 hidden rounded-chip border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground md:inline" data-testid="hero-project">
              {p?.name ?? a.project_id} · <span className="font-mono">Rev {a.revision}</span>
            </span>
          )}
          <Button asChild variant="outline" size="sm" className="glass h-8 gap-1.5 border-border text-[12px]">
            <Link to="/mission"><LayoutDashboard className="size-3.5" /> Mission Control</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="glass h-8 gap-1.5 border-border text-[12px]">
            <Link to="/room"><Box className="size-3.5" /> 3D Room</Link>
          </Button>
          <ThemeBtn />
        </nav>
      </header>

      {/* the promise */}
      <section
        className={cn("absolute z-10 w-[min(640px,90vw)]", wide ? "left-[clamp(20px,5vw,72px)] top-[calc(50%-64px)] -translate-y-1/2" : "left-5 top-24")}
        data-testid="hero-promise"
      >
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={t(0.05)} className="mb-4 flex items-center gap-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-live">
          <span className="h-px w-7 bg-live shadow-[0_0_10px_rgb(var(--live))]" />
          DeltaV · CHARM I/O · signal allocation
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={t(0.12)}
          className="text-[clamp(40px,6.2vw,80px)] font-bold leading-[0.98] tracking-[-0.035em] [@media(max-height:700px)]:text-[54px]"
        >
          <span className="block">Allocate.</span>
          <span className="block bg-[linear-gradient(90deg,rgb(var(--brand)),rgb(var(--live)))] bg-clip-text text-transparent">Prove.</span>
          <span className="block">Revise.</span>
        </motion.h1>
        <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={t(0.22)} className="mb-7 mt-[18px] max-w-[520px] text-[clamp(14px,1.45vw,18px)] leading-normal text-text/75">
          Drop your IO list. Every signal lands in the right cabinet, baseplate and CHARM — verified, certified, and stable when the list changes.
        </motion.p>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={t(0.3)} className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={cn(
              "inline-flex items-center gap-2.5 rounded-[14px] bg-[linear-gradient(135deg,rgb(var(--brand)),#5B8CFF)] px-8 py-4 text-[17px] font-bold text-white shadow-[0_8px_44px_rgb(var(--brand)/.6)] transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live",
              !calm && "hero-pulse",
            )}
            data-testid="hero-import"
          >
            <Download className="size-5" /> Import MDB
          </button>
          <Button variant="outline" onClick={openDemo} className="glass h-11 gap-2 rounded-[12px] border-border px-4 text-[13px] font-semibold" data-testid="hero-demo">
            Open demo project <ArrowRight className="size-4" />
          </Button>
          <span className="basis-full text-[12px] text-muted-foreground">
            or drop an IO MDB anywhere on this page · <span className="font-mono">.xlsx · .xlsm · .csv</span>
          </span>
        </motion.div>
        <input ref={fileRef} type="file" accept={MDB_ACCEPT} hidden onChange={(e) => (hand(e.target.files), (e.target.value = ""))} data-testid="hero-file" />
      </section>

      <Hooks a={a} t={t} />

      {over && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-bg/75 backdrop-blur-sm" data-testid="hero-drop">
          <div className="rounded-[24px] border-2 border-dashed border-brand bg-[radial-gradient(ellipse_at_top,rgb(var(--brand)/.14),transparent_70%)] px-[90px] py-[60px] text-center shadow-[0_0_60px_rgb(var(--brand)/.35)]">
            <Upload className="mx-auto mb-3 size-7 text-brand" />
            <div className="text-[22px] font-bold">Drop your IO list</div>
            <div className="mt-1.5 text-[13px] text-muted-foreground">.xlsx · .xlsm · .csv — anywhere on this page; Import &amp; Mapping reads it</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── hook cards ─────────────

interface Hook {
  key: string;
  label: string;
  to: string;
  body: ReactNode;
}

/** 3–4 hooks from the loaded project; each is left out when its data is missing (no Rev B → no stability hook). */
function Hooks({ a, t }: { a: AllocationResult | undefined; t: (d: number) => object }) {
  const { data: runs } = useRuns();
  const { data: impact } = useRevisionImpact();
  const hooks = useMemo<Hook[]>(() => {
    if (!a) return [];
    const k = a.kpis, cert = a.certificate, out: Hook[] = [];
    out.push({
      key: "alloc", label: "Allocation", to: "/room",
      body: (
        <>
          <Big><Num to={k.signals} /><Small>signals → {k.cabinets} cabinet{k.cabinets === 1 ? "" : "s"}</Small></Big>
          <Foot><b className="font-mono text-text"><Num to={k.allocated_pct} decimals={k.allocated_pct % 1 ? 1 : 0} />%</b> allocated · solved in <b className="font-mono text-text"><Num to={a.runtime_ms / 1000} decimals={1} /></b> s</Foot>
          <Meter pct={k.allocated_pct} />
        </>
      ),
    });
    const fail = cert.verdict !== "PASS" || cert.violations > 0;
    out.push({
      key: "proof", label: "Proof", to: "/proof",
      body: (
        <>
          <Big className={fail ? "text-err" : "text-ok"}><Num to={cert.violations} /><Small>violation{cert.violations === 1 ? "" : "s"}</Small></Big>
          <Foot>independently verified · <b className="font-mono text-text"><Num to={cert.checks_total} /></b> rule checks · {k.signals.toLocaleString("en-US")} signals</Foot>
          <Ticks checks={a.report.checks} />
        </>
      ),
    });
    if (k.stability_pct != null && impact) {
      out.push({
        key: "stability", label: "Revision stability", to: "/revisions",
        body: (
          <>
            <Big><span><Num to={impact.stability_pct} decimals={1} />%</span><Small>unchanged</Small></Big>
            <Foot>Rev {impact.from_rev} → {impact.to_rev} · <b className="font-mono text-text">{impact.unchanged_in_place}</b> of {impact.previous_live} signals stayed put</Foot>
            <Meter pct={impact.stability_pct} />
          </>
        ),
      });
    }
    const caught = (runs ?? []).filter((r) => r.kind === "verify-file" && r.verdict === "FAIL");
    const hashed = (runs ?? []).filter((r) => r.kind !== "verify-file").length;
    const sha = `${cert.output_sha256.slice(0, 12)}…${cert.output_sha256.slice(-4)}`;
    if (caught.length) {
      out.push({
        key: "tamper", label: "Tamper test", to: "/proof",
        body: (
          <>
            <Big className="text-err">CAUGHT<Small>{caught.length === 1 ? "1 edited copy" : `${caught.length} edited copies`} failed</Small></Big>
            <Foot>re-read by the independent verifier → FAIL</Foot>
            <Foot className="font-mono text-[11px]">this run: sha256 {sha}</Foot>
          </>
        ),
      });
    } else {
      // no tampered copy checked yet: the certificate that a tampered copy would fail against
      out.push({
        key: "cert", label: "Run certificate", to: "/proof",
        body: (
          <>
            <Big className="text-[28px]">{cert.output_sha256.slice(0, 8)}<Small>output sha256</Small></Big>
            <Foot>input · ruleset · output hashed{hashed ? ` · ${hashed} run${hashed === 1 ? "" : "s"} on record` : ""}</Foot>
            <Foot>same inputs → same hash · an edited copy fails</Foot>
          </>
        ),
      });
    }
    return out;
  }, [a, runs, impact]);

  const cls = "absolute inset-x-[clamp(14px,3vw,40px)] bottom-[clamp(12px,3vh,32px)] z-10 grid gap-3.5";
  if (!a) {
    // no project loaded (fresh database / unknown id): what the tool does, no numbers
    return (
      <section className={cn(cls, "md:grid-cols-3")} data-testid="hero-steps">
        {[
          ["01 · Import", "Any IO MDB, zero code", "columns auto-mapped · bad rows quarantined, never a crash"],
          ["02 · Allocate", "Every signal gets a slot", "or a TQ that names the clash · CP-SAT with a greedy fallback"],
          ["03 · Prove", "An independent verifier", "re-reads the exported Excel · a tampered copy fails"],
        ].map(([k, n, f], i) => (
          <motion.div key={k} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={t(0.4 + i * 0.08)} className="glass min-w-0 rounded-[14px] border border-border px-4 py-3.5 inner-hi">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{k}</div>
            <div className="text-[18px] font-semibold">{n}</div>
            <div className="mt-1.5 text-[12px] text-muted-foreground">{f}</div>
          </motion.div>
        ))}
      </section>
    );
  }
  return (
    <section className={cls} style={{ gridTemplateColumns: `repeat(${hooks.length}, minmax(0, 1fr))` }} data-testid="hero-hooks">
      {hooks.map((h, i) => (
        <motion.div key={h.key} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={t(0.4 + i * 0.08)} className="min-w-0">
          <Link
            to={h.to}
            className="glass block h-full rounded-[14px] border border-border px-4 py-3.5 inner-hi transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_0_28px_rgb(var(--brand)/.15)]"
            data-testid={`hook-${h.key}`}
          >
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{h.label}</div>
            {h.body}
          </Link>
        </motion.div>
      ))}
    </section>
  );
}

const Big = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("flex items-baseline gap-2 whitespace-nowrap font-mono text-[34px] font-bold leading-[1.05] tnum [@media(max-height:700px)]:text-[28px] max-md:text-[24px]", className)}>{children}</div>
);
const Small = ({ children }: { children: ReactNode }) => <small className="whitespace-normal font-sans text-[12px] font-medium leading-tight text-muted-foreground">{children}</small>;
const Foot = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn("mt-1.5 truncate text-[12px] text-text/70", className)}>{children}</div>;

/** A number that counts up from 0 on mount (text written straight to the node: no re-render per frame). */
function Num({ to, decimals = 0 }: { to: number; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = animate(0, to, { duration: calm ? 0.2 : 1.5, delay: calm ? 0 : 0.45, ease: EASE, onUpdate: (v) => (el.textContent = v.toFixed(decimals)) });
    return () => c.stop();
  }, [to, decimals, calm]);
  return <span ref={ref} className="tnum">{(0).toFixed(decimals)}</span>;
}

function Meter({ pct }: { pct: number }) {
  const calm = useCalm();
  return (
    <div className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-bg/80 [@media(max-height:700px)]:hidden">
      <motion.i
        className="block h-full bg-[linear-gradient(90deg,rgb(var(--brand)),rgb(var(--live)))]"
        initial={{ width: 0 }} animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        transition={{ duration: calm ? 0.2 : 1.8, delay: calm ? 0 : 0.5, ease: [0.2, 0.8, 0.2, 1] }}
      />
    </div>
  );
}

/** One square per verifier check, ticking in one by one: green passed, amber excepted by a TQ, red failed. */
function Ticks({ checks }: { checks: AllocationResult["report"]["checks"] }) {
  const calm = useCalm();
  return (
    <div className="mt-2.5 grid gap-0.5 [@media(max-height:700px)]:hidden max-md:hidden" style={{ gridTemplateColumns: `repeat(${Math.max(1, checks.length)}, minmax(0, 1fr))` }} data-testid="hook-ticks">
      {checks.map((c, i) => {
        const col = c.failed > 0 ? "rgb(var(--err))" : c.excepted > 0 ? "rgb(var(--warn))" : "rgb(var(--ok))";
        return (
          <motion.i
            key={c.id} title={`${c.id} · ${c.label}`}
            className="h-[5px] rounded-[2px] bg-border"
            animate={{ backgroundColor: col, boxShadow: `0 0 6px ${col}` }}
            transition={{ duration: 0.2, delay: calm ? 0 : 0.5 + i * 0.062 }}
          />
        );
      })}
    </div>
  );
}

function ThemeBtn() {
  const theme = useUi((s) => s.theme);
  const toggle = useUi((s) => s.toggleTheme);
  return (
    <Button variant="outline" size="icon" className="glass size-8 border-border" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
      {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </Button>
  );
}

/** No WebGL: a still floor grid in the room's colours instead of the orbiting room. */
function FlatFloor() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-world" data-testid="hero-flat">
      <div
        className="absolute inset-x-[-20%] bottom-[-10%] h-[70%] opacity-60 [transform:perspective(600px)_rotateX(62deg)]"
        style={{ backgroundImage: "linear-gradient(rgb(var(--brand) / .35) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--brand) / .35) 1px, transparent 1px)", backgroundSize: "48px 48px", maskImage: "linear-gradient(0deg, #000, transparent)" }}
      />
    </div>
  );
}
