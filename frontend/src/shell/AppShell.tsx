import { AnimatePresence, motion } from "framer-motion";
import { useLocation, useOutlet } from "react-router-dom";

import { DiveCurtain } from "@/motion/DiveCurtain";
import { pageVariants } from "@/motion/shared";

import { CommandPalette } from "./CommandPalette";
import { Inspector } from "./Inspector";
import { Scoreboard } from "./Scoreboard";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useGlobalHotkeys } from "./useHotkeys";

/** §10.2 shell — identical on every screen. */
export function AppShell() {
  useGlobalHotkeys();
  const loc = useLocation();
  const outlet = useOutlet();
  return (
    <div className="bg-world flex h-full flex-col">
      <TopBar />
      <Scoreboard />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={loc.pathname} className="h-full" variants={pageVariants} initial="initial" animate="animate" exit="exit">
              {outlet}
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
