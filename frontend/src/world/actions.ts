import type { NavigateFunction } from "react-router-dom";

import type { AllocationResult, Slot } from "@/api/hooks";
import { DIVE_KEY, isCalm } from "@/motion/shared";
import { useUi, type Level } from "@/store/ui";

/** Cabinet order used by the World: the engine's physical order. */
export function cabinetOrder(a: AllocationResult) {
  return a.cabinets.map((c) => c.name);
}

/** Point the Explorer camera at a slot (its cabinet, side and CIOC) and open the Inspector on it. */
export function flyToSlot(a: AllocationResult, slot: Slot, ciocsPerSide: number) {
  const idx = Math.max(0, cabinetOrder(a).indexOf(slot.cabinet));
  try {
    sessionStorage.setItem(DIVE_KEY, "1"); // a deliberate fly-to must not be pre-empted by the once-per-session Upload Dive
  } catch {
    /* storage can be blocked */
  }
  const st = useUi.getState();
  useUi.setState({
    cabIdx: idx,
    side: slot.cioc_local <= ciocsPerSide ? "F" : "R",
    level: "detail",
    focusCioc: slot.cioc_local,
  });
  st.inspect(slot.id);
}

/**
 * Mission Control → Explorer: aim the Explorer at a cabinet (optionally a CIOC) and open it with the Plant → cabinet camera dive.
 * The deliberate dive replaces the once-per-session Upload Dive.
 */
export function enterCabinet(nav: NavigateFunction, idx: number, opts: { side?: "F" | "R"; level?: Level; focusCioc?: number | null } = {}) {
  try {
    sessionStorage.setItem(DIVE_KEY, "1");
  } catch {
    /* storage can be blocked */
  }
  useUi.setState({
    cabIdx: idx,
    side: opts.side ?? "F",
    level: opts.level ?? "cabinet",
    focusCioc: opts.focusCioc ?? null,
    inspectorSlot: null,
    arriveFrom: isCalm() ? null : "plant",
  });
  nav("/explorer");
}
