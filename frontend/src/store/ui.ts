import { create } from "zustand";

export type Theme = "dark" | "light";
const KEY = "optislot-theme";

function initial(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage can be blocked; the theme still applies for this session */
  }
}

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: initial(),
  setTheme: (theme) => {
    apply(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));

apply(useUi.getState().theme);
