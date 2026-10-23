import { animate, useMotionValue } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Dims } from "@/api/derive";
import { EASE, useCalm } from "@/motion/shared";
import { typing } from "@/shell/useHotkeys";
import { useUi } from "@/store/ui";

import { cabinetBounds, fit, type Insets } from "./geometry";
import { useCamera } from "./useCamera";

const GLIDE_MS = 700;
const GLIDE_DIP = 0.12;

/**
 * One camera + cabinet/side intent for a screen with a single cabinet in view (Try-out Lab, Revision Center):
 * ←/→ glide along the row, F flips front/rear (rotateY, or a fade in Calm), the cabinet is refitted on resize.
 * Several <CabinetWorld>s can share the returned camera, which keeps them in sync.
 */
export function useStage(n: number, dims: Dims, insets: Insets) {
  const cam = useCamera();
  const calm = useCalm();
  const ui = useUi();
  const idx = Math.min(Math.max(0, ui.cabIdx), Math.max(0, n - 1));
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const onSize = useCallback((w: number, h: number) => setVp((o) => (o.w === w && o.h === h ? o : { w, h })), []);
  const cabinetS = useMemo(() => (vp.w ? fit(cabinetBounds(0, dims), vp.w, vp.h, insets).s : 1), [vp.w, vp.h, dims, insets]);

  const opacity = useMotionValue(1);
  const rotateY = useMotionValue(0);
  const [shownSide, setShownSide] = useState(ui.side);

  // intent → camera
  const prev = useRef<{ idx: number; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!vp.w) return;
    const target = fit(cabinetBounds(idx, dims), vp.w, vp.h, insets);
    const pv = prev.current;
    prev.current = { idx, w: vp.w, h: vp.h };
    if (!pv || pv.w !== vp.w || pv.h !== vp.h || calm) return cam.set(target);
    if (pv.idx !== idx) void cam.tween(cam.get(), target, GLIDE_MS, vp.w, vp.h, GLIDE_DIP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, vp.w, vp.h, dims, calm]);

  // side → flip
  useEffect(() => {
    if (ui.side === shownSide) return;
    let cancelled = false;
    (async () => {
      if (calm) {
        await animate(opacity, 0, { duration: 0.12 });
        setShownSide(ui.side);
        animate(opacity, 1, { duration: 0.2 });
        return;
      }
      await animate(rotateY, 90, { duration: 0.22, ease: [0.4, 0, 1, 1] });
      if (cancelled) return;
      setShownSide(ui.side);
      rotateY.set(-90);
      await animate(rotateY, 0, { duration: 0.28, ease: EASE });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.side]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e) || e.metaKey || e.ctrlKey || e.altKey || useUi.getState().paletteOpen) return;
      const st = useUi.getState();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = Math.min(n - 1, Math.max(0, idx + (e.key === "ArrowRight" ? 1 : -1)));
        if (next !== idx) st.goCabinet(next);
      } else if (e.key.toLowerCase() === "f") st.setSide(st.side === "F" ? "R" : "F");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const goto = useCallback((i: number) => useUi.getState().goCabinet(i), []);
  return { cam, vp, onSize, cabinetS, idx, side: shownSide, opacity, rotateY, goto };
}
