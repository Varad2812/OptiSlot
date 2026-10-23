import { Route, Routes } from "react-router-dom";

import { AppShell } from "@/shell/AppShell";
import { SCREENS } from "@/shell/routes";

import Explorer from "./Explorer";
import Import from "./Import";
import Lab from "./Lab";
import MissionControl from "./MissionControl";
import Proof from "./Proof";
import TqCenter from "./TqCenter";
import Revisions from "./Revisions";
import ScreenPreview from "./ScreenPreview";

const ELEMENTS: Record<string, JSX.Element> = { "/": <MissionControl />, "/explorer": <Explorer />, "/lab": <Lab />, "/proof": <Proof />, "/revisions": <Revisions />, "/import": <Import />, "/tqs": <TqCenter /> };

// Route table = CLAUDE.md §10.2 sidebar (src/shell/routes.ts). scripts/shots.mjs captures the same paths.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {SCREENS.map((s) => (
          <Route key={s.path} path={s.path} element={ELEMENTS[s.path] ?? <ScreenPreview />} />
        ))}
        <Route path="*" element={<ScreenPreview />} />
      </Route>
    </Routes>
  );
}
