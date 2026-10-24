import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import { useLocation, useOutlet } from "react-router-dom";

import { DiveCurtain } from "@/motion/DiveCurtain";
import { EASE, useCalm } from "@/motion/shared";

import { CommandPalette } from "./CommandPalette";
import { Inspector } from "./Inspector";
import { Scoreboard } from "./Scoreboard";
import { Sidebar } from "./Sidebar";
import { screenFor } from "./routes";
import { AllocationGate, ErrorBoundary } from "./states";
import { TopBar } from "./TopBar";
import { useGlobalHotkeys } from "./useHotkeys";
import { useMigrationNotice } from "./useMigrationNotice";
import { useRouteTitle } from "./useRouteTitle";

/** Page transition (reference): fade + 12 px slide-up, 0.45 s. Calm mode and reduced motion get a short fade only. */
function usePageVariants() {
  const calm = useCalm();
  return useMemo(
    () => ({
      initial: calm ? { opacity: 0 } : { opacity: 0, y: 12 },
      animate: { opacity: 1, y: 0, transition: { duration: calm ? 0.15 : 0.45, ease: EASE } },
      exit: { opacity: 0, transition: { duration: calm ? 0.08 : 0.12 } },
    }),
    [calm],
  );
}

/** §10.9 shell — identical on every screen: the rail on the left, the top bar and the scoreboard above the page. */
export function AppShell() {
  useGlobalHotkeys();
  useRouteTitle();
  useMigrationNotice();
  const loc = useLocation();
  const outlet = useOutlet();
  const variants = usePageVariants();
  return (
    <div className="bg-world flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <Scoreboard />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={loc.pathname} className="h-full" variants={variants} initial="initial" animate="animate" exit="exit">
              <ErrorBoundary inline resetKey={loc.pathname}>
                {screenFor(loc.pathname)?.standalone || !screenFor(loc.pathname) ? outlet : <AllocationGate>{outlet}</AllocationGate>}
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
          <Inspector />
        </main>
      </div>
      <CommandPalette />
      <DiveCurtain />
    </div>
  );
}
