import { motion } from "framer-motion";
import { Boxes, Download, FileSpreadsheet, FileStack, GitCompareArrows, MessageSquareWarning, ShieldCheck, type LucideIcon } from "lucide-react";

import { useAllocation, useExports, useProjectId, type ExportFile } from "@/api/hooks";
import { CertificatePanel } from "@/components/panels";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EASE, useCalm } from "@/motion/shared";

const META: Record<ExportFile["kind"], { icon: LucideIcon; title: string; blurb: string; unit: string }> = {
  allocation: { icon: FileSpreadsheet, title: "IO Allocation", blurb: "The 76-column IO Assignment written into a copy of the blank template — every slot of every cabinet.", unit: "rows" },
  rule_check: { icon: ShieldCheck, title: "Rule Check Report", blurb: "Every verifier check with pass / fail counts and the violating rows.", unit: "rows" },
  tq_register: { icon: MessageSquareWarning, title: "TQ Register", blurb: "Open and resolved technical queries with severity, issue, resolution and decision.", unit: "TQs" },
  revision_impact: { icon: GitCompareArrows, title: "Revision Impact", blurb: "Added, deleted, modified and moved signals — each move with its reason.", unit: "rows" },
  capacity_bom: { icon: Boxes, title: "Capacity & BOM", blurb: "Cabinets, CIOCs, baseplates, parts per CHARM / TB, fill, and spares per IO type and per cabinet.", unit: "rows" },
};

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : null);

/** Export (§10.5.10) — five real files, written end-to-end, plus the certificate they belong to. */
export default function Export() {
  const pid = useProjectId();
  const calm = useCalm();
  const { data: files } = useExports();
  const { data: a } = useAllocation();
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1280px] p-6" data-testid="export-page">
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-page">Export</h1>
            <p className="mt-1 text-muted-foreground">Five real files, written end-to-end by the tool — no hand-editing.</p>
          </div>
          <Button asChild className="gap-2" disabled={!files}>
            <a href={`/api/projects/${pid}/export/all.zip`} download data-testid="download-all"><FileStack className="size-4" />Download all (.zip)</a>
          </Button>
        </header>

        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 grid content-start gap-3 md:grid-cols-2 xl:col-span-8">
            {!files
              ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-36 w-full" />)
              : files.map((f, i) => {
                  const m = META[f.kind];
                  return (
                    <motion.a
                      key={f.kind}
                      href={`/api/projects/${pid}/export/${f.kind}`}
                      download={f.filename}
                      initial={calm ? { opacity: 0 } : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, delay: i * 0.05, ease: EASE }}
                      whileHover={{ y: -2 }}
                      className="card-surface group flex flex-col gap-3 p-4 transition-colors hover:border-brand/50"
                      data-testid={`export-${f.kind}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-chip bg-raised"><m.icon className="size-5 text-ok" /></div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold">{m.title}</div>
                          <div className="truncate font-mono text-[11.5px] text-muted-foreground">{f.filename}</div>
                        </div>
                        <Download className="size-4 text-muted-foreground transition-colors group-hover:text-brand" />
                      </div>
                      <p className="text-[12px] leading-snug text-muted-foreground">{m.blurb}</p>
                      <div className="mt-auto flex items-center justify-between text-[11.5px]">
                        <span className="tnum"><b className="text-[15px] font-semibold">{f.rows}</b> <span className="text-muted-foreground">{m.unit}</span></span>
                        {short(f.sha256) && <span className="font-mono text-muted-foreground" title={f.sha256 ?? ""}>sha {short(f.sha256)}</span>}
                      </div>
                    </motion.a>
                  );
                })}
          </div>
          <div className="col-span-12 flex flex-col gap-4 xl:col-span-4">
            <CertificatePanel delay={0.1} to="/proof" />
            {a && (
              <p className="px-1 text-[12px] leading-snug text-muted-foreground">
                The allocation file's hash is the <span className="text-text">Output</span> hash on the certificate. Upload the downloaded file to the Proof Center's “Verify any Excel” — a hand-edited copy fails with the exact row and check.
              </p>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
