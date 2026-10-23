import type { AllocationResult, Slot } from "@/api/hooks";
import { useUi } from "@/store/ui";

/** Cabinet order used by the World: the engine's physical order. */
export function cabinetOrder(a: AllocationResult) {
  return a.cabinets.map((c) => c.name);
}

/** Point the Explorer camera at a slot (its cabinet, side and CIOC) and open the Inspector on it. */
export function flyToSlot(a: AllocationResult, slot: Slot, ciocsPerSide: number) {
  const idx = Math.max(0, cabinetOrder(a).indexOf(slot.cabinet));
  const st = useUi.getState();
  useUi.setState({
    cabIdx: idx,
    side: slot.cioc_local <= ciocsPerSide ? "F" : "R",
    level: "detail",
    focusCioc: slot.cioc_local,
  });
  st.inspect(slot.id);
}
