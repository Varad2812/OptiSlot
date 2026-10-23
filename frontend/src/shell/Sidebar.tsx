import { motion } from "framer-motion";
import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { cn } from "@/lib/utils";

import { SCREENS } from "./routes";

/** 64px icon rail that widens to 220px on hover, overlaying the page (content never reflows). */
export function Sidebar() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  return (
    <div className="relative z-20 w-16 shrink-0">
      <motion.nav
        onHoverStart={() => setOpen(true)}
        onHoverEnd={() => setOpen(false)}
        animate={{ width: open ? 220 : 64 }}
        transition={{ type: "spring", stiffness: 380, damping: 36 }}
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col gap-0.5 overflow-hidden border-r border-border bg-surface/85 px-2 py-3 backdrop-blur-md",
          open && "shadow-[12px_0_40px_-12px_rgba(0,0,0,.45)]",
        )}
        aria-label="Screens"
      >
        {SCREENS.map((s, i) => {
          const active = s.path === "/" ? loc.pathname === "/" : loc.pathname.startsWith(s.path);
          const Icon = s.icon;
          return (
            <div key={s.path}>
              {i > 0 && SCREENS[i - 1].group !== s.group && <div className="mx-2 my-2 h-px bg-border" />}
              <NavLink
                to={s.path}
                className={cn(
                  "relative flex h-10 items-center gap-3 rounded-card px-3 text-[13px] transition-colors",
                  active ? "bg-brand/10 text-text" : "text-muted-foreground hover:bg-raised hover:text-text",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="side-active"
                    className="absolute left-0 top-2 h-6 w-[3px] rounded-full bg-brand shadow-[0_0_10px_rgb(var(--brand))]"
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                  />
                )}
                <Icon className={cn("size-[18px] shrink-0", active && "text-brand")} />
                <span className={cn("whitespace-nowrap transition-opacity duration-150", open ? "opacity-100" : "opacity-0")}>{s.title}</span>
              </NavLink>
            </div>
          );
        })}
      </motion.nav>
    </div>
  );
}
