import { Route, Routes } from "react-router-dom";

import { AppShell } from "@/shell/AppShell";
import { SCREENS } from "@/shell/routes";

import Explorer from "./Explorer";
import ScreenPreview from "./ScreenPreview";

// Route table = CLAUDE.md §10.2 sidebar (src/shell/routes.ts). scripts/shots.mjs captures the same paths.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {SCREENS.map((s) => (
          <Route key={s.path} path={s.path} element={s.path === "/explorer" ? <Explorer /> : <ScreenPreview />} />
        ))}
        <Route path="*" element={<ScreenPreview />} />
      </Route>
    </Routes>
  );
}
