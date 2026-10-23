import { ActivityPanel, CertificatePanel, TqPanel } from "@/components/panels";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAllocation, useProject } from "@/api/hooks";
import { ComplianceTile, FillHeatTile, SparesTile, StabilityTile } from "@/mission/tiles";
import { PlantStrip } from "@/world/PlantStrip";

/**
 * Home (CLAUDE.md §10.5.1). The Scoreboard strip in the shell is its first tile; everything below is live data from the same
 * allocation, so the page is full from the first frame. Every tile links to the screen that owns it.
 */
export default function MissionControl() {
  const { data: a } = useAllocation();
  const { data: p } = useProject();
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
          <div className="col-span-12 xl:col-span-8"><PlantStrip height={250} /></div>
          <div className="col-span-12 flex flex-col gap-4 xl:col-span-4 [&>div]:flex-1 [&>div>section]:h-full">
            <div><CertificatePanel delay={0.04} to="/proof" /></div>
            <div><StabilityTile delay={0.08} /></div>
          </div>
          <div className="col-span-12 xl:col-span-7"><SparesTile delay={0.12} /></div>
          <div className="col-span-12 xl:col-span-5"><TqPanel delay={0.16} to="/tqs" /></div>
          <div className="col-span-12 xl:col-span-5"><ComplianceTile delay={0.2} /></div>
          <div className="col-span-12 xl:col-span-7"><FillHeatTile delay={0.24} /></div>
          <div className="col-span-12"><ActivityPanel delay={0.28} to="/proof" columns={2} /></div>
        </div>
      </div>
    </ScrollArea>
  );
}
