import { useEffect, useMemo, useRef, useState } from "react";

import type { Dims, WorldModel } from "@/api/derive";
import { demoMode, registerDemo } from "@/motion/demoHooks";
import { isCalm } from "@/motion/shared";

import { world3dData } from "./data";
import { World3DEngine } from "./engine";
import { MINI_CABINETS } from "./miniRoomSize";


interface Props {
  model: WorldModel;
  dims: Dims;
  /** Cabinet outlined from outside (a ring or heat-map row under the pointer), model index. */
  hot: number | null;
  onHot: (cab: number | null) => void;
  onPick: (cab: number) => void;
  /** WebGL missing, or still under 30 fps with bloom off → the page shows its 2D strip instead. */
  onFail: () => void;
}

/**
 * Mission Control's live room: World3DEngine in its low-cost `mini` mode — slow side-to-side drift, no camera input, hover outlines a
 * cabinet, click hands the cabinet index to the page. Bloom goes first when the frame rate drops, the 2D strip second.
 */
export default function MiniRoom({ model, dims, hot, onHot, onPick, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const eng = useRef<World3DEngine | null>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef({ onHot, onPick, onFail });
  cb.current = { onHot, onPick, onFail };
  const shown = useMemo<WorldModel>(() => ({ ...model, cabinets: model.cabinets.slice(0, MINI_CABINETS) }), [model]);
  const data = useMemo(() => world3dData(shown, dims), [shown, dims]);

  useEffect(() => {
    if (!host.current) return;
    let e: World3DEngine;
    try {
      e = new World3DEngine(host.current, { calm: isCalm, mini: { onPick: (c) => cb.current.onPick(c) } });
    } catch {
      cb.current.onFail();
      return;
    }
    eng.current = e;
    const off = e.on("hover", (h) => cb.current.onHot(h && h.cab >= 0 ? h.cab : null));
    const ro = new ResizeObserver(() => e.resize());
    ro.observe(host.current);
    setReady(true);
    return () => {
      off();
      ro.disconnect();
      e.dispose();
      eng.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    if (ready) eng.current?.setData(data);
  }, [ready, data]);

  useEffect(() => {
    if (ready) eng.current?.hoverCabinet(hot);
  }, [ready, hot]);

  // FPS guard: bloom off after 3 s under 30 fps, the 2D strip after another 3 s. (Skipped under ?demo=1 and while the tab is hidden.)
  useEffect(() => {
    if (!ready || demoMode) return;
    let since = 0, stage = 0;
    const start = performance.now();
    const iv = window.setInterval(() => {
      const e = eng.current, now = performance.now();
      if (!e || document.hidden || now - start < 2500 || e.stats().fps >= 30) return void (since = 0);
      if (!since) return void (since = now);
      if (now - since < 3000) return;
      since = 0;
      if (stage++ === 0) e.setBloom(false);
      else (window.clearInterval(iv), cb.current.onFail());
    }, 500);
    return () => window.clearInterval(iv);
  }, [ready]);

  useEffect(() => {
    if (!demoMode || !ready) return;
    return registerDemo("miniroom", { stats: () => eng.current?.stats(), pick: (c: number) => cb.current.onPick(c), hover: (c: number | null) => eng.current?.hoverCabinet(c) });
  }, [ready]);

  return <div ref={host} className="absolute inset-0" data-testid="mini-room" />;
}
