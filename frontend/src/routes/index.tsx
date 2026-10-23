import { Route, Routes } from "react-router-dom";

import Kit from "./Kit";
import Placeholder from "./Placeholder";

// Route table = CLAUDE.md §10 screens. scripts/shots.mjs captures the same paths.
export const SCREENS = [
  { path: "/", title: "Mission Control" },
  { path: "/import", title: "Import & Mapping" },
  { path: "/rules", title: "Rules Studio" },
  { path: "/floor", title: "Cabinet Floor" },
  { path: "/grid", title: "Allocation Grid" },
  { path: "/tqs", title: "TQ Center" },
  { path: "/revisions", title: "Revision Diff" },
  { path: "/export", title: "Export & Proof" },
] as const;

export function AppRoutes() {
  return (
    <Routes>
      {SCREENS.map((s) => (
        <Route key={s.path} path={s.path} element={<Placeholder title={s.title} />} />
      ))}
      <Route path="/kit" element={<Kit />} />
      <Route path="*" element={<Placeholder title="Not found" />} />
    </Routes>
  );
}
