import {
  Box, Boxes, Cpu, Download, FileUp, FlaskConical, GitCompareArrows, House, LayoutDashboard, MessageSquareWarning, ShieldCheck,
  SlidersHorizontal, Table2, type LucideIcon,
} from "lucide-react";

export interface Screen {
  path: string;
  title: string;
  icon: LucideIcon;
  /** "main" = the numbered story (reference_ui.html); "more" = the secondary group. */
  group: "main" | "more";
  blurb: string;
  /** Full-bleed page outside the app shell (the launch page). */
  bare?: boolean;
  /** Works without an allocation (Import, Rules); every other page waits for one. */
  standalone?: boolean;
}

// CLAUDE.md §10.9 nav order: Home, Import → Allocate → 3D Room → Workbench → Rules → Proof → Revisions → Export, then "More".
// scripts/shots.mjs captures the same paths.
export const SCREENS: Screen[] = [
  { path: "/", title: "Home", icon: House, group: "main", bare: true, blurb: "Allocate. Prove. Revise. — the launch page over the live marshalling room." },
  { path: "/import", title: "Import", icon: FileUp, group: "main", standalone: true, blurb: "Any IO MDB, zero code: columns auto-mapped, bad rows quarantined." },
  { path: "/allocate", title: "Allocate", icon: Cpu, group: "main", standalone: true, blurb: "Run the solver and see every phase and every cabinet fill." },
  { path: "/room", title: "3D Room", icon: Box, group: "main", blurb: "The marshalling room in 3D: dive Room → cabinet → CIOC → baseplate → CHARM, and see every change land." },
  { path: "/lab", title: "Workbench", icon: FlaskConical, group: "main", blurb: "Every signal, why it sits where it does — and a checked, undoable way to move it." },
  { path: "/rules", title: "Rules", icon: SlidersHorizontal, group: "main", standalone: true, blurb: "Rules are data — edit them live; every change is previewed, re-verified and versioned." },
  { path: "/proof", title: "Proof", icon: ShieldCheck, group: "main", blurb: "An independent verifier re-reads the output. A tampered copy fails." },
  { path: "/revisions", title: "Revisions", icon: GitCompareArrows, group: "main", blurb: "Rev B moves only what changed — and every move has a reason." },
  { path: "/export", title: "Export", icon: Download, group: "main", blurb: "Five real files, written end-to-end into the template." },
  { path: "/mission", title: "Mission Control", icon: LayoutDashboard, group: "more", blurb: "The whole project at a glance — every tile is live data." },
  { path: "/tqs", title: "TQ Center", icon: MessageSquareWarning, group: "more", blurb: "Every open question names the clash and offers a fix." },
  { path: "/grid", title: "Allocation Grid", icon: Table2, group: "more", blurb: "The 76-column IO Assignment, exactly as exported." },
  { path: "/explorer", title: "Cabinet Explorer", icon: Boxes, group: "more", blurb: "Walk the marshalling room: every slot of every cabinet, and why it is there." },
];

export const screenFor = (path: string) => SCREENS.find((s) => s.path === path);
