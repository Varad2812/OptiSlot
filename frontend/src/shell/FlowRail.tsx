import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { flowSteps } from "@/api/derive";
import { useAllocation, useProject } from "@/api/hooks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** ① Upload → ② Rules → ③ Allocate → ④ Verify → ⑤ Revise → ⑥ Export, driven by real project state. */
export function FlowRail() {
  const { data: p } = useProject();
  const { data: a } = useAllocation();
  const loc = useLocation();
  const nav = useNavigate();
  const steps = flowSteps(p, a);
  return (
    <nav className="flex items-center gap-1" aria-label="Flow">
      {steps.map((s, i) => {
        const current = loc.pathname === s.path;
        return (
          <div key={s.key} className="flex items-center gap-1">
            {i > 0 && (
              <span className={cn("h-px w-2 min-[1640px]:w-5", steps[i - 1].state === "done" ? "bg-ok/50" : "bg-border")} />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => nav(s.path)}
                  aria-label={s.label}
                  className={cn(
                    "relative flex h-8 items-center gap-1.5 rounded-full border px-2 pr-2.5 text-[12px] font-medium transition-colors min-[1640px]:gap-2 min-[1640px]:pr-3",
                    current ? "border-brand/60 bg-brand/15 text-text" : "border-transparent text-muted-foreground hover:bg-raised hover:text-text",
                  )}
                >
                  {current && (
                    <motion.span
                      layoutId="flow-glow"
                      className="absolute inset-0 rounded-full glow-brand"
                      transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    />
                  )}
                  <span
                    className={cn(
                      "relative grid size-[18px] place-items-center rounded-full text-[10px] font-semibold tnum",
                      s.state === "done" && "bg-ok/20 text-ok",
                      s.state === "warn" && "bg-err/20 text-err",
                      s.state === "todo" && "bg-raised text-muted-foreground ring-1 ring-border",
                    )}
                  >
                    {s.state === "done" ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="relative">{s.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{s.label} · {s.hint}</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </nav>
  );
}
