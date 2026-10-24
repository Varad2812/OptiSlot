import { Clapperboard, FlaskConical, Moon, Play, Search, ShieldCheck, Sparkles, Sun, Wind } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { dimsOf } from "@/api/derive";
import { useAllocate, useAllocation, useProject, useVerify } from "@/api/hooks";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { IO_COLOURS, ioKey } from "@/lib/io";
import { useUi } from "@/store/ui";
import { ALLOCATE_LANDING_ROUTE, cabinetOrder, flyToSlot } from "@/world/actions";

import { SCREENS } from "./routes";

/** ⌘K: every screen, every action, every cabinet, and find-a-tag (flies the camera to its slot). */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const { theme, toggleTheme, motion, setMotion, replayDive, goCabinet } = useUi();
  const nav = useNavigate();
  const { data: a } = useAllocation();
  const { data: p } = useProject();
  const allocate = useAllocate();
  const verify = useVerify();
  const [q, setQ] = useState("");

  const ql = q.trim().toLowerCase().replace(/\s+/g, "");
  const tags = useMemo(() => {
    if (!a || ql.length < 2) return [];
    const out = [];
    for (const s of a.slots) {
      if (s.tag === "-") continue;
      if (s.tag_key.toLowerCase().includes(ql) || s.cable.toLowerCase().includes(ql)) out.push(s);
      if (out.length >= 12) break;
    }
    return out;
  }, [a, ql]);

  const match = (label: string) => !ql || label.toLowerCase().replace(/\s+/g, "").includes(ql);
  const run = (fn: () => void) => {
    setOpen(false);
    setQ("");
    fn();
  };
  const cabinets = a ? cabinetOrder(a) : [];

  return (
    <CommandDialog shouldFilter={false} open={open} onOpenChange={(o) => (setOpen(o), o || setQ(""))}>
      <div className="glass">
        <CommandInput value={q} onValueChange={setQ} placeholder="Search screens, actions, cabinets, tags or cables…" />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>Nothing matches “{q}”.</CommandEmpty>
          {tags.length > 0 && (
            <CommandGroup heading="Tags">
              {tags.map((s) => (
                <CommandItem key={s.id} value={`tag ${s.id}`} onSelect={() => run(() => (nav(ALLOCATE_LANDING_ROUTE), flyToSlot(a!, s, dimsOf(a, p).ciocsPerSide)))}>
                  <span className="size-2 rounded-full" style={{ background: IO_COLOURS[ioKey(s)] }} />
                  <span className="font-mono">{s.tag}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{s.cabinet} · {s.baseplate} · ch {s.ch}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Actions">
            {match("Allocate") && (
              <CommandItem value="allocate" onSelect={() => run(() => allocate.mutate())}>
                <Play /> Allocate <Kbd>A</Kbd>
              </CommandItem>
            )}
            {match("Verify") && (
              <CommandItem value="verify" onSelect={() => run(() => verify.mutate())}>
                <ShieldCheck /> Verify <Kbd>V</Kbd>
              </CommandItem>
            )}
            {match("Replay Upload Dive") && (
              <CommandItem value="dive" onSelect={() => run(() => (nav(ALLOCATE_LANDING_ROUTE), replayDive()))}>
                <Sparkles /> Replay Upload Dive
              </CommandItem>
            )}
            {match("Inject Rev B") && (
              <CommandItem value="inject" onSelect={() => run(() => (useUi.getState().requestInject(), nav("/revisions")))}>
                <FlaskConical /> Inject Rev B
              </CommandItem>
            )}
            {match(`${theme === "dark" ? "Light" : "Dark"} theme`) && (
              <CommandItem value="theme" onSelect={() => run(toggleTheme)}>
                {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light" : "Dark"} theme
              </CommandItem>
            )}
            {match(`Motion ${motion === "cinematic" ? "calm" : "cinematic"}`) && (
              <CommandItem value="motion" onSelect={() => run(() => setMotion(motion === "cinematic" ? "calm" : "cinematic"))}>
                {motion === "cinematic" ? <Wind /> : <Clapperboard />} Motion: {motion === "cinematic" ? "Calm" : "Cinematic"}
              </CommandItem>
            )}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Screens">
            {SCREENS.filter((s) => match(s.title)).map((s) => (
              <CommandItem key={s.path} value={`screen ${s.title}`} onSelect={() => run(() => nav(s.path))}>
                <s.icon /> {s.title}
              </CommandItem>
            ))}
          </CommandGroup>
          {cabinets.some(match) && (
            <CommandGroup heading="Cabinets">
              {cabinets.map((c, i) =>
                match(c) ? (
                  <CommandItem key={c} value={`cab ${c}`} onSelect={() => run(() => (nav(ALLOCATE_LANDING_ROUTE), goCabinet(i)))}>
                    <Search /> <span className="font-mono">{c}</span>
                  </CommandItem>
                ) : null,
              )}
            </CommandGroup>
          )}
        </CommandList>
      </div>
    </CommandDialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="ml-auto rounded-[4px] border border-border bg-raised px-1.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}
