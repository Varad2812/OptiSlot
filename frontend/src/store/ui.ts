import { create } from "zustand";

export type Theme = "dark" | "light";
export type Motion = "cinematic" | "calm";
export type Side = "F" | "R";
export type Level = "plant" | "cabinet" | "detail";

const THEME_KEY = "optislot-theme";
const MOTION_KEY = "optislot-motion";
const PROJECT_KEY = "optislot-project";
const VIEW_KEY = "optislot-view";
const RAIL_KEY = "optislot-rail";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked; the choice still applies for this session */
  }
}

function initialMotion(): Motion {
  const saved = read(MOTION_KEY);
  if (saved === "calm" || saved === "cinematic") return saved;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "calm" : "cinematic";
  } catch {
    return "cinematic";
  }
}

function initialProject(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("project");
    if (q) return q;
  } catch {
    /* ignore */
  }
  return read(PROJECT_KEY) || "demo";
}

/** `data-motion` on <html> lets CSS hold decorative loops still in Calm mode (index.css). */
function applyMotion(m: Motion) {
  document.documentElement.dataset.motion = m;
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  write(THEME_KEY, t);
}

export interface ExplorerFilters {
  io: string[];        // IoKey values; empty = all
  status: string[];    // Tag Status values; empty = all
  family: string[];    // A / B / -
  group: string | null;
  search: string;      // cable / tag substring
}

export const NO_FILTERS: ExplorerFilters = { io: [], status: [], family: [], group: null, search: "" };

interface UiState {
  theme: Theme;
  motion: Motion;
  projectId: string;
  offline: boolean;
  inspectorSlot: string | null;
  paletteOpen: boolean;
  // Cabinet Explorer camera intent (the World animates towards it)
  cabIdx: number;
  side: Side;
  level: Level;
  focusCioc: number | null; // cioc_local in view at detail level
  filters: ExplorerFilters;
  diveNonce: number;        // bump to replay the Upload Dive
  arriveFrom: "plant" | null; // one-shot: the Explorer opens with a Plant → cabinet camera dive (Mission Control click)
  injectPending: boolean;   // the top-bar "Inject Rev B" button asks the Revision Center to run the gauntlet
  view3d: boolean;          // Cabinet Explorer: the 3D Marshalling Room (default) or the 2.5D World
  railCollapsed: boolean;   // the left rail folded to icons (216 px → 64 px)
  pendingMdb: File | null;  // a file dropped / picked on the launch page, read by Import & Mapping when it mounts
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setMotion: (m: Motion) => void;
  setProject: (id: string) => void;
  setOffline: (v: boolean) => void;
  inspect: (slotId: string | null) => void;
  setPalette: (open: boolean) => void;
  goCabinet: (i: number) => void;
  setSide: (s: Side) => void;
  setLevel: (l: Level, focusCioc?: number | null) => void;
  setFilters: (f: Partial<ExplorerFilters>) => void;
  replayDive: () => void;
  setArrive: (a: "plant" | null) => void;
  requestInject: (v?: boolean) => void;
  setView3d: (v: boolean) => void;
  setPendingMdb: (f: File | null) => void;
  setRailCollapsed: (v: boolean) => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: read(THEME_KEY) === "light" ? "light" : "dark",
  motion: initialMotion(),
  projectId: initialProject(),
  offline: false,
  inspectorSlot: null,
  paletteOpen: false,
  cabIdx: 0,
  side: "F",
  level: "cabinet",
  focusCioc: null,
  filters: NO_FILTERS,
  diveNonce: 0,
  arriveFrom: null,
  injectPending: false,
  view3d: read(VIEW_KEY) !== "2d",
  pendingMdb: null,
  railCollapsed: read(RAIL_KEY) === "1",
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  setMotion: (motion) => {
    write(MOTION_KEY, motion);
    applyMotion(motion);
    set({ motion });
  },
  setProject: (projectId) => {
    write(PROJECT_KEY, projectId);
    set({ projectId, cabIdx: 0, side: "F", level: "cabinet", focusCioc: null, inspectorSlot: null, filters: NO_FILTERS });
  },
  setOffline: (offline) => get().offline !== offline && set({ offline }),
  inspect: (inspectorSlot) => set({ inspectorSlot }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  goCabinet: (cabIdx) => set({ cabIdx, level: get().level === "plant" ? "cabinet" : get().level, focusCioc: null }),
  setSide: (side) => set({ side, focusCioc: null }),
  setLevel: (level, focusCioc = null) => set({ level, focusCioc }),
  setFilters: (f) => set({ filters: { ...get().filters, ...f } }),
  replayDive: () => set({ diveNonce: get().diveNonce + 1 }),
  setArrive: (arriveFrom) => set({ arriveFrom }),
  requestInject: (v = true) => set({ injectPending: v }),
  setView3d: (view3d) => {
    write(VIEW_KEY, view3d ? "3d" : "2d");
    set({ view3d });
  },
  setPendingMdb: (pendingMdb) => set({ pendingMdb }),
  setRailCollapsed: (railCollapsed) => {
    write(RAIL_KEY, railCollapsed ? "1" : "0");
    set({ railCollapsed });
  },
}));

applyTheme(useUi.getState().theme);
applyMotion(useUi.getState().motion);
