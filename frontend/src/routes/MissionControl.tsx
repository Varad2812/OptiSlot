import { useMemo, useState } from "react";

import { dimsOf, worldModel } from "@/api/derive";
import { useAllocation, useProject } from "@/api/hooks";
import { ActivityPanel } from "@/components/panels";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { BulletsCard, CertCard, HeatCard, MiniRoomCard, RingsCard, StabilityCard, TqCard } from "@/mission/cards";
import { SparesTile } from "@/mission/tiles";
import { hasWebGL } from "@/world3d/support";
import { PlantStrip } from "@/world/PlantStrip";

/**
 * Home (CLAUDE.md §10.5.1 / §10.10). The Scoreboard strip in the shell is its first row; everything below is live data from the same
 * allocation: the live 3D room, certificate, stability needle, fill rings, spare bullets, TQs + run history, the CIOC heat-map.
 * Every tile opens the screen that owns it; a cabinet (in the room, a ring or a heat-map row) opens the 3D Room flown to it.
 */
export default function MissionControl() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const dims = useMemo(() => dimsOf(a, p), [a, p]);
  const model = useMemo(() => (a ? worldModel(a, dims) : null), [a, dims]);
  const [hot, setHot] = useState<number | null>(null); // the cabinet under the pointer, shared by the room, the rings and the heat-map
  const [flat, setFlat] = useState(!hasWebGL()); // no WebGL / too slow → the 2D strip takes the room's place
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1680px] p-6" data-testid="mission-control">
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-page">Mission Control</h1>
            <p className="mt-1 text-muted-foreground">The whole project at a glance — every tile is live data and opens its screen.</p>
          </div>
          {a && (
            <div className="hidden items-center gap-2 text-[11.5px] text-muted-foreground md:flex">
              <span className="rounded-chip border border-border bg-raised px-2 py-0.5">{p?.name ?? a.project_id}</span>
              <span className="rounded-chip border border-border bg-raised px-2 py-0.5 font-mono">Rev {a.revision}</span>
              <span className="rounded-chip border border-border bg-raised px-2 py-0.5 font-mono" title="Run id — the same inputs reproduce the same hashes">{a.run_id}</span>
            </div>
          )}
        </header>
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 xl:col-span-7 [&>section]:h-full">
            {model && !flat ? (
              <MiniRoomCard model={model} dims={dims} hot={hot} setHot={setHot} onFail={() => setFlat(true)} delay={0.02} />
            ) : (
              <PlantStrip height={300} />
            )}
          </div>
          <div className="col-span-12 flex flex-col gap-4 xl:col-span-5 [&>div]:flex-1 [&>div>section]:h-full">
            <div><CertCard delay={0.06} /></div>
            <div><StabilityCard delay={0.1} /></div>
          </div>
          <div className="col-span-12 md:col-span-6 xl:col-span-4 [&>section]:h-full">{model ? <RingsCard model={model} hot={hot} setHot={setHot} delay={0.14} /> : <Skeleton className="h-[300px] w-full" />}</div>
          <div className="col-span-12 md:col-span-6 xl:col-span-4 [&>section]:h-full"><BulletsCard delay={0.18} /></div>
          <div className="col-span-12 xl:col-span-4 [&>section]:h-full"><TqCard delay={0.22} /></div>
          <div className="col-span-12">{model ? <HeatCard model={model} dims={dims} setHot={setHot} delay={0.26} /> : <Skeleton className="h-[260px] w-full" />}</div>
          <div className="col-span-12 xl:col-span-7"><SparesTile delay={0.3} /></div>
          <div className="col-span-12 xl:col-span-5"><ActivityPanel delay={0.34} to="/proof" limit={6} /></div>
        </div>
      </div>
    </ScrollArea>
  );
}
