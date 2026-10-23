import { Construction } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import {
  ActivityPanel, CertificatePanel, ChecksPanel, ExportsPanel, ImportStatsPanel, MappingPanel, OptimiserPanel, RowsPreviewPanel,
  RulesPanel, RunsPanel, SpareCompliancePanel, SparesPanel, StatusPanel, TqPanel,
} from "@/components/panels";
import { ScrollArea } from "@/components/ui/scroll-area";
import { screenFor } from "@/shell/routes";
import { PlantStrip } from "@/world/PlantStrip";

/** Real-data previews for the screens later prompts build in full (U2–U4). Styled and full — never blank. */
const LAYOUTS: Record<string, () => ReactNode> = {
  "/": () => (
    <>
      <div className="col-span-12"><PlantStrip /></div>
      <div className="col-span-12 xl:col-span-7"><SparesPanel delay={0.04} /></div>
      <div className="col-span-12 xl:col-span-5"><CertificatePanel delay={0.08} /></div>
      <div className="col-span-12 xl:col-span-6"><TqPanel delay={0.12} /></div>
      <div className="col-span-12 xl:col-span-6"><ActivityPanel delay={0.16} /></div>
    </>
  ),
  "/lab": () => (
    <>
      <div className="col-span-12"><PlantStrip /></div>
      <div className="col-span-12 xl:col-span-5"><OptimiserPanel delay={0.04} /></div>
      <div className="col-span-12 xl:col-span-7"><SpareCompliancePanel delay={0.08} /></div>
    </>
  ),
  "/proof": () => (
    <>
      <div className="col-span-12 xl:col-span-5"><CertificatePanel /></div>
      <div className="col-span-12 xl:col-span-7"><RunsPanel delay={0.06} /></div>
      <div className="col-span-12"><ChecksPanel delay={0.1} /></div>
    </>
  ),
  "/revisions": () => (
    <>
      <div className="col-span-12"><PlantStrip /></div>
      <div className="col-span-12 xl:col-span-6"><ActivityPanel delay={0.04} /></div>
      <div className="col-span-12 xl:col-span-6"><StatusPanel delay={0.08} /></div>
    </>
  ),
  "/import": () => (
    <>
      <div className="col-span-12 xl:col-span-5"><ImportStatsPanel /></div>
      <div className="col-span-12 xl:col-span-7"><ActivityPanel delay={0.06} kinds={["import", "allocate"]} /></div>
      <div className="col-span-12"><MappingPanel delay={0.1} /></div>
    </>
  ),
  "/rules": () => (
    <div className="col-span-12"><RulesPanel /></div>
  ),
  "/tqs": () => (
    <>
      <div className="col-span-12 xl:col-span-8"><TqPanel limit={20} /></div>
      <div className="col-span-12 xl:col-span-4"><StatusPanel delay={0.06} /></div>
    </>
  ),
  "/grid": () => (
    <>
      <div className="col-span-12 xl:col-span-4"><StatusPanel /></div>
      <div className="col-span-12 xl:col-span-8"><SpareCompliancePanel delay={0.06} /></div>
      <div className="col-span-12"><RowsPreviewPanel delay={0.1} /></div>
    </>
  ),
  "/export": () => (
    <>
      <div className="col-span-12 xl:col-span-7"><ExportsPanel /></div>
      <div className="col-span-12 xl:col-span-5"><CertificatePanel delay={0.06} /></div>
    </>
  ),
};

export default function ScreenPreview() {
  const { pathname } = useLocation();
  const s = screenFor(pathname);
  const layout = LAYOUTS[pathname];
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1680px] p-6">
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-page">{s?.title ?? "Not found"}</h1>
            <p className="mt-1 text-muted-foreground">{s?.blurb ?? "This page doesn’t exist — pick a screen on the left."}</p>
          </div>
          {import.meta.env.DEV && s?.phase && (
            <span className="flex items-center gap-1.5 rounded-chip border border-dashed border-brand/50 px-2 py-1 text-[11px] text-brand">
              <Construction className="size-3.5" /> Full screen arrives in {s.phase}
            </span>
          )}
        </header>
        <div className="grid grid-cols-12 gap-4">{layout ? layout() : <div className="col-span-12"><PlantStrip /></div>}</div>
      </div>
    </ScrollArea>
  );
}
