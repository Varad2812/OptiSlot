import { useEffect } from "react";

import { useAllocate, useVerify } from "@/api/hooks";
import { skipAllSequences } from "@/motion/sequence";
import { useUi } from "@/store/ui";

/** True when a key press belongs to a text field (or the palette), not to the app. */
export function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !!t.closest("[cmdk-root]"));
}

/** Global keys (§10.2): ⌘K palette, A allocate, V verify, / find tag, Esc closes the Inspector. Screen keys live in their screen. */
export function useGlobalHotkeys() {
  const allocate = useAllocate();
  const verify = useVerify();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
        return;
      }
      if (e.defaultPrevented || typing(e) || ui.paletteOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a" && !allocate.isPending) allocate.mutate();
      else if (k === "v" && !verify.isPending) verify.mutate();
      else if (k === "/") {
        e.preventDefault();
        ui.setPalette(true);
      }
    };
    // Esc skips any running motion sequence (verify scan, Rev B diff, Mission Control dive) before anything backs out a level
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useUi.getState().paletteOpen || !skipAllSequences()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onEsc, true);
    return () => (window.removeEventListener("keydown", onKey), window.removeEventListener("keydown", onEsc, true));
  }, [allocate, verify]);
}
