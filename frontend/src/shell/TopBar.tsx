import { Clapperboard, Command, FlaskConical, Moon, Sun, WifiOff, Wind } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useProject, useProjects } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSwitchRevision } from "@/revisions/useRevisionFlow";
import { useUi } from "@/store/ui";

import { FlowRail } from "./FlowRail";

export function Logo({ className }: { className?: string }) {
  // Three stacked slots, the top one lit — "a signal finds its slot".
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="5" rx="1.5" fill="rgb(var(--brand))" />
      <rect x="3" y="9.5" width="18" height="5" rx="1.5" fill="rgb(var(--brand) / 0.45)" />
      <rect x="3" y="16" width="18" height="5" rx="1.5" fill="none" stroke="rgb(var(--brand) / 0.6)" strokeWidth="1.2" />
      <circle cx="18" cy="5.5" r="1.1" fill="rgb(var(--live))" />
    </svg>
  );
}

export function TopBar() {
  const { theme, toggleTheme, motion, setMotion, projectId, setProject, offline, setPalette } = useUi();
  const nav = useNavigate();
  const { data: projects } = useProjects();
  const { data: project } = useProject();
  const revSwitch = useSwitchRevision();
  const list = projects?.length ? projects : project ? [project] : [];
  return (
    <header className="relative z-30 flex h-14 items-center gap-4 border-b border-border bg-surface/70 px-4 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-2">
          <Logo className="size-6" />
          <span className="text-[15px] font-semibold tracking-tight">OptiSlot</span>
        </div>
        <span className="h-5 w-px bg-border" />
        <Select value={projectId} onValueChange={setProject}>
          <SelectTrigger className="h-8 w-[165px] border-transparent bg-transparent px-2 text-[13px] hover:bg-raised" aria-label="Project">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            {list.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex shrink-0 items-center whitespace-nowrap rounded-chip border border-border bg-raised p-0.5" aria-label="Revision">
          {(project?.revisions ?? ["A"]).map((r) => (
            <button
              key={r}
              onClick={() => r !== project?.revision && void revSwitch.run(r)}
              disabled={revSwitch.busy}
              aria-pressed={r === project?.revision}
              title={r === project?.revision ? `Rev ${r} is active` : `Switch to Rev ${r} — the 3D Room plays what changed`}
              className={cn(
                "rounded-[4px] px-2 py-0.5 font-mono text-[11px] transition-colors",
                r === project?.revision ? "bg-brand/20 text-text" : "text-muted-foreground hover:text-text",
              )}
              data-testid={`rev-${r}`}
            >
              Rev {r}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-1 justify-center">
        <FlowRail />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {offline && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mr-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                <WifiOff className="size-3.5" /> Offline
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">API unreachable — showing the generated fixtures</TooltipContent>
          </Tooltip>
        )}
        <Button variant="outline" size="sm" className="h-8 gap-1.5 border-brand/40 text-[12px] text-text hover:border-brand" onClick={() => (useUi.getState().requestInject(), nav("/revisions"))} data-testid="topbar-inject">
          <FlaskConical className="size-3.5 text-brand" /> Inject Rev B
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={() => setPalette(true)}>
          <Command className="size-3.5" />
          <span className="font-mono text-[11px]">K</span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Toggle theme" onClick={toggleTheme}>
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{theme === "dark" ? "Light theme" : "Dark theme"}</TooltipContent>
        </Tooltip>
        <div className="flex items-center rounded-chip border border-border bg-raised p-0.5" role="radiogroup" aria-label="Motion">
          {(["cinematic", "calm"] as const).map((m) => (
            <button
              key={m}
              title={m}
              aria-label={m}
              role="radio"
              aria-checked={motion === m}
              onClick={() => setMotion(m)}
              className={cn(
                "flex h-7 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium capitalize transition-colors",
                motion === m ? "bg-surface text-text inner-hi" : "text-muted-foreground hover:text-text",
              )}
            >
              {m === "cinematic" ? <Clapperboard className="size-3.5" /> : <Wind className="size-3.5" />}
              <span className="hidden min-[1680px]:inline">{m}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
