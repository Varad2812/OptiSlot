import {
  Boxes, Download, FileUp, FlaskConical, GitCompareArrows, LayoutDashboard, MessageSquareWarning, ShieldCheck,
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
  { path: "/explorer", title: "Cabinet Explorer", icon: Boxes, group: "story", blurb: "Walk the marshalling room: every slot of every cabinet, and why it is there." },
  { path: "/lab", title: "Try-out Lab", icon: FlaskConical, group: "story", blurb: "Move slots, toggle rules and see the impact before you commit.", phase: "U3" },
  { path: "/proof", title: "Proof Center", icon: ShieldCheck, group: "story", blurb: "An independent verifier re-reads the output. A tampered copy fails." },
  { path: "/revisions", title: "Revision Center", icon: GitCompareArrows, group: "story", blurb: "Rev B moves only what changed — and every move has a reason.", phase: "U3" },
  { path: "/import", title: "Import & Mapping", icon: FileUp, group: "work", blurb: "Any IO MDB, zero code: columns auto-mapped, bad rows quarantined." },
  { path: "/rules", title: "Rules Studio", icon: SlidersHorizontal, group: "work", blurb: "Rules are data — edit them live or describe them in plain English.", phase: "U4" },
  { path: "/tqs", title: "TQ Center", icon: MessageSquareWarning, group: "work", blurb: "Every open question names the clash and offers a fix." },
  { path: "/grid", title: "Allocation Grid", icon: Table2, group: "work", blurb: "The 76-column IO Assignment, exactly as exported.", phase: "U4" },
  { path: "/export", title: "Export", icon: Download, group: "work", blurb: "Five real files, written end-to-end into the template." },
];

export const screenFor = (path: string) => SCREENS.find((s) => s.path === path);
