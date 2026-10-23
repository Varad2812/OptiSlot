import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject } from "@/api/hooks";
import { Panel } from "@/components/panels";
import { Skeleton } from "@/components/ui/skeleton";
import { useUi } from "@/store/ui";

import { CabinetWorld } from "./CabinetWorld";
import { cabinetBounds, fit, plantRect } from "./geometry";
import { useCamera } from "./useCamera";

/** The mini World at Plant level (Mission Control & previews). Click a cabinet → the Explorer dives into it. */
export function PlantStrip({ height = 230 }: { height?: number }) {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const nav = useNavigate();
  const side = useUi((s) => s.side);
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => (a ? worldModel(a, dims) : null), [a, dims]);
  const cam = useCamera();
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const onSize = useCallback((w: number, h: number) => setVp({ w, h }), []);
  const n = model?.cabinets.length ?? 0;
  useEffect(() => {
    if (vp.w && n) cam.set(fit(plantRect(n, dims), vp.w, vp.h, { top: 16, right: 16, bottom: 8, left: 16 }));
  }, [vp.w, vp.h, n, dims, cam]);
  const cabinetS = vp.w && n ? fit(cabinetBounds(0, dims), vp.w, vp.h, { top: 0, right: 0, bottom: 0, left: 0 }).s * 4 : 1;
  return (
    <Panel title="Marshalling room" aside={<span className="text-[11px] text-muted-foreground">{n} cabinets · click one to dive in</span>}>
      <div style={{ height: `clamp(${height}px, 30vh, ${Math.round(height * 1.5)}px)` }} className="overflow-hidden rounded-chip">
        {!model ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <CabinetWorld
            model={model}
            dims={dims}
            cam={cam}
            side={side}
            activeIdx={-5}
            cabinetS={cabinetS}
            interactive={false}
            onSize={onSize}
            onCabinet={(i) => {
              useUi.setState({ cabIdx: i, level: "cabinet", focusCioc: null });
              nav("/explorer");
            }}
          />
        )}
      </div>
    </Panel>
  );
}
