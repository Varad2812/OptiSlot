import {
  Box, Boxes, Download, FileUp, FlaskConical, GitCompareArrows, LayoutDashboard, MessageSquareWarning, ShieldCheck,
  SlidersHorizontal, Table2, type LucideIcon,
} from "lucide-react";

export interface Screen {
  path: string;
  title: string;
  icon: LucideIcon;
  group: "story" | "work";
  blurb: string;
  phase?: "U2" | "U3" | "U4"; // later prompt that builds the full screen (dev-only chip)
}

// CLAUDE.md §10.2 sidebar, in order. scripts/shots.mjs captures the same paths.
export const SCREENS: Screen[] = [
  { path: "/", title: "Mission Control", icon: LayoutDashboard, group: "story", blurb: "The whole project at a glance — every tile is live data." },
  { path: "/room", title: "3D Room", icon: Box, group: "story", blurb: "The marshalling room in 3D: dive Room → cabinet → CIOC → baseplate → CHARM, and see every change land." },
  { path: "/explorer", title: "Cabinet Explorer", icon: Boxes, group: "story", blurb: "Walk the marshalling room: every slot of every cabinet, and why it is there." },
  { path: "/lab", title: "Signal Workbench", icon: FlaskConical, group: "story", blurb: "Every signal, why it sits where it does — and a checked, undoable way to move it." },
  { path: "/proof", title: "Proof Center", icon: ShieldCheck, group: "story", blurb: "An independent verifier re-reads the output. A tampered copy fails." },
  { path: "/revisions", title: "Revision Center", icon: GitCompareArrows, group: "story", blurb: "Rev B moves only what changed — and every move has a reason.", phase: "U3" },
  { path: "/import", title: "Import & Mapping", icon: FileUp, group: "work", blurb: "Any IO MDB, zero code: columns auto-mapped, bad rows quarantined." },
  { path: "/rules", title: "Rules Studio", icon: SlidersHorizontal, group: "work", blurb: "Rules are data — edit them live; every change is previewed, re-verified and versioned." },
  { path: "/tqs", title: "TQ Center", icon: MessageSquareWarning, group: "work", blurb: "Every open question names the clash and offers a fix." },
  { path: "/grid", title: "Allocation Grid", icon: Table2, group: "work", blurb: "The 76-column IO Assignment, exactly as exported." },
  { path: "/export", title: "Export", icon: Download, group: "work", blurb: "Five real files, written end-to-end into the template." },
];

export const screenFor = (path: string) => SCREENS.find((s) => s.path === path);
