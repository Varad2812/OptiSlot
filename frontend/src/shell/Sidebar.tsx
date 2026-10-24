import { motion } from "framer-motion";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { useAllocation } from "@/api/hooks";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { Logo } from "./TopBar";
import { SCREENS, type Screen } from "./routes";

const main = SCREENS.filter((s) => s.group === "main");
const more = SCREENS.filter((s) => s.group === "more");
const numbered = main.filter((s) => s.path !== "/");

/** Reference rail (§10.9): logo tile + tagline, numbered story, a "More" group and a live status footer. 216 px; the chevron folds it to icons. */
export function Sidebar() {
  const loc = useLocation();
  const collapsed = useUi((s) => s.railCollapsed);
  const toggle = useUi((s) => s.setRailCollapsed);
  const inMore = more.some((s) => loc.pathname.startsWith(s.path));
  const [moreOpen, setMoreOpen] = useState(true);
  const showMore = moreOpen || inMore || collapsed;

  const item = (s: Screen) => {
    const active = s.path === "/" ? loc.pathname === "/" : loc.pathname.startsWith(s.path);
    const n = numbered.indexOf(s) + 1;
    const Icon = s.icon;
    return (
      <NavLink
        key={s.path} to={s.path} title={collapsed ? s.title : s.blurb} aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-9 items-center gap-2.5 rounded-[9px] border px-2.5 text-[13px] transition-[color,background-color,box-shadow] duration-200",
          active ? "border-brand/35 bg-gradient-to-r from-brand/20 to-brand/[0.05] text-text" : "border-transparent text-muted-foreground hover:bg-raised hover:text-text hover:shadow-[0_0_14px_rgb(var(--brand)/0.13)]",
        )}
        data-testid={`nav-${s.path === "/" ? "home" : s.path.slice(1)}`}
      >
        {active && (
          <motion.span layoutId="rail-active" className="absolute -left-3 bottom-2 top-2 w-[3px] rounded-full bg-brand shadow-[0_0_10px_rgb(var(--brand))]" transition={{ type: "spring", stiffness: 260, damping: 30 }} />
        )}
        {collapsed ? <Icon className={cn("mx-auto size-[18px]", active && "text-brand")} /> : (
          <>
            <b className={cn("w-[18px] shrink-0 font-mono text-[10px] font-semibold", active ? "text-brand" : "text-muted-foreground/70")}>{n > 0 ? String(n).padStart(2, "0") : ""}</b>
            <Icon className={cn("size-[17px] shrink-0", active && "text-brand")} />
            <span className="truncate">{s.title}</span>
          </>
        )}
      </NavLink>
    );
  };

  return (
    <nav
      className={cn("relative z-20 flex shrink-0 flex-col gap-0.5 border-r border-border bg-surface/80 px-3 py-3 backdrop-blur-md transition-[width] duration-200", collapsed ? "w-16" : "w-[216px]")}
      aria-label="Screens" data-testid="rail"
    >
      <div className={cn("flex items-center gap-2.5 px-1 pb-1", collapsed && "justify-center")}>
        <div className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-gradient-to-br from-brand to-[#5b3fe0] shadow-[0_0_16px_-4px_rgb(var(--brand)/0.8)]">
          <Logo className="size-5" />
        </div>
        {!collapsed && <span className="text-[16px] font-semibold tracking-tight">OptiSlot</span>}
      </div>
      {!collapsed && <div className="px-1 pb-3 text-[11px] text-muted-foreground">Allocate. Prove. Revise.</div>}
      {collapsed && <div className="h-2" />}

      {main.map(item)}

      <button
        type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={showMore}
        className={cn("mt-3 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground hover:text-text", collapsed && "hidden")}
      >
        More <ChevronDown className={cn("size-3 transition-transform", showMore && "rotate-180")} />
      </button>
      {collapsed && <div className="mx-2 my-2 h-px bg-border" />}
      {showMore && more.map(item)}

      <div className="mt-auto space-y-2 pt-3">
        <Status collapsed={collapsed} />
        <button
          type="button" onClick={() => toggle(!collapsed)} aria-label={collapsed ? "Expand the menu" : "Fold the menu"}
          className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-raised hover:text-text", collapsed && "justify-center px-0")}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-4" />Fold menu</>}
        </button>
      </div>
    </nav>
  );
}

/** Real status only: the verifier's last verdict and the engine that produced the run. */
function Status({ collapsed }: { collapsed: boolean }) {
  const { data: a } = useAllocation();
  const ok = a ? a.report.violations === 0 && a.report.verdict === "PASS" : null;
  const dot = ok == null ? "bg-muted-foreground/60" : ok ? "bg-ok shadow-[0_0_8px_rgb(var(--ok))]" : "bg-err shadow-[0_0_8px_rgb(var(--err))]";
  if (collapsed) return <div className="flex justify-center py-1" title={a ? `Verifier: ${a.report.verdict}` : "No run yet"}><span className={cn("size-2 rounded-full", dot)} /></div>;
  return (
    <div className="rounded-chip border border-border bg-raised/50 px-2.5 py-2 text-[11.5px]" data-testid="rail-status">
      <div className="flex items-center gap-2"><span className={cn("size-2 shrink-0 rounded-full", dot)} />{a ? (ok ? `Verified — 0 violations${a.kpis.allocated < a.kpis.signals ? ` · ${a.kpis.signals - a.kpis.allocated} unplaced` : ""}` : `${a.report.violations} violations`) : "No run yet"}</div>
      {a && <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground" title={a.certificate.run_id}>{a.certificate.engine_version} · run {a.run_id.replace(/^run-/, "").slice(0, 8)}</div>}
    </div>
  );
}
