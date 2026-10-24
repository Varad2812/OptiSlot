import { Route, Routes } from "react-router-dom";

import { AppShell } from "@/shell/AppShell";
import { SCREENS } from "@/shell/routes";

import Allocate from "./Allocate";
import Explorer from "./Explorer";
import Export from "./Export";
import Grid from "./Grid";
import Hero from "./Hero";
import Import from "./Import";
import MissionControl from "./MissionControl";
import Proof from "./Proof";
import TqCenter from "./TqCenter";
import Revisions from "./Revisions";
import Room from "./Room";
import Rules from "./Rules";
import NotFound from "./NotFound";
import Workbench from "./Workbench";

const ELEMENTS: Record<string, JSX.Element> = { "/allocate": <Allocate />, "/mission": <MissionControl />, "/room": <Room />, "/explorer": <Explorer />, "/lab": <Workbench />, "/proof": <Proof />, "/revisions": <Revisions />, "/import": <Import />, "/rules": <Rules />, "/tqs": <TqCenter />, "/export": <Export />, "/grid": <Grid /> };

// Route table = CLAUDE.md §10.2 sidebar (src/shell/routes.ts). scripts/shots.mjs captures the same paths.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Hero />} />
      <Route element={<AppShell />}>
        {SCREENS.filter((s) => !s.bare).map((s) => (
          <Route key={s.path} path={s.path} element={ELEMENTS[s.path] ?? <NotFound />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
