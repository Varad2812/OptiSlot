import { AnimatePresence, motion } from "framer-motion";
import { Bot, FileText, Loader2, Send, WifiOff, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useProjectId } from "@/api/hooks";
import { cn } from "@/lib/utils";
import { AssistError, ASSIST_TIMEOUT_MS, askAssistant, providerLabel, useAssistStatus, type AskResult } from "@/rules/assist";

import type { SignalRow } from "./api";
import { clauses } from "./Detail";

type State =
  | { k: "idle" }
  | { k: "loading"; q: string }
  | { k: "done"; q: string; res: AskResult }
  | { k: "local"; q: string; why: "timeout" | "offline" | "error" };

const SOURCE = {
  llm: "Phrased by the assistant from the facts below",
  facts: "Structured explanation — straight from the allocation",
  refused: "Not about this allocation",
} as const;

/** The facts the Workbench already holds for a signal: the offline answer when the assistant cannot be reached. */
function localFacts(r: SignalRow): string[] {
  const out = clauses(r.reason ?? "");
  const l = r.location, h = r.hardware;
  if (l) out.push(`Slot ${l.slot_id} — cabinet ${l.cabinet}, CIOC ${l.cioc}, baseplate ${l.baseplate}, channel ${l.ch}.`);
  if (h) out.push(`Hardware ${h.charm} (${h.charm_desc}) on terminal block ${h.tb}.`);
  if (r.rule_ids?.length) out.push(`Rules involved: ${r.rule_ids.join(", ")}.`);
  if (r.tq_ids?.length) out.push(`Open questions: ${r.tq_ids.join(", ")}.`);
  return out;
}

/** "Ask OptiSlot": a question about the selected signal, answered from facts the backend assembled — never an error toast. */
export function AskDrawer({ sig, open, onClose }: { sig: SignalRow; open: boolean; onClose: () => void }) {
  const pid = useProjectId();
  const status = useAssistStatus();
  const [q, setQ] = useState("");
  const [st, setSt] = useState<State>({ k: "idle" });
  const token = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const key = `${sig.row}/${sig.tag}`;

  // a different signal is a different conversation
  useEffect(() => {
    token.current++;
    setSt({ k: "idle" });
    setQ("");
  }, [key]);
  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 120);
  }, [open]);

  const suggestions = useMemo(
    () => [sig.location ? "Why is it in this slot?" : "Why is it not placed?", "What would I have to change to fix it?", "Which rules apply to it?"],
    [sig.location],
  );

  async function ask(text = q) {
    const t = text.trim();
    if (!t || st.k === "loading") return;
    const mine = ++token.current;
    setQ(t);
    setSt({ k: "loading", q: t });
    try {
      const res = await askAssistant(pid, t, sig.tag, sig.row);
      if (mine === token.current) setSt({ k: "done", q: t, res });
    } catch (e) {
      if (mine === token.current) setSt({ k: "local", q: t, why: e instanceof AssistError ? e.kind : "error" });
    }
  }

  const facts = st.k === "done" ? (st.res.facts ?? []) : st.k === "local" ? localFacts(sig) : [];
  return (
    <AnimatePresence>
      {open && (
        <motion.section
          initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="glass absolute inset-x-2 bottom-2 z-20 flex max-h-[72%] flex-col overflow-hidden rounded-card border border-brand/40 shadow-[0_-12px_40px_-12px_rgb(0_0_0/.5)]"
          aria-label="Ask OptiSlot" data-testid="ask-drawer"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
            <Bot className="size-4 text-brand" />
            <h3 className="text-[13px] font-semibold">Ask OptiSlot</h3>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={sig.tag}>{sig.tag}</span>
            <span className="ml-auto shrink-0 rounded-chip border border-border px-1.5 py-px text-[10.5px] text-muted-foreground" data-testid="ask-provider">{providerLabel(status.data)}</span>
            <button onClick={onClose} aria-label="Close" className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-raised hover:text-text"><X className="size-3.5" /></button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3 text-[12.5px]" aria-live="polite">
            {st.k === "idle" && (
              <>
                <p className="text-muted-foreground">Answers come only from this signal’s recorded reason, location, hardware and the rule set — nothing is invented, nothing is changed.</p>
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((s) => (
                    <button key={s} onClick={() => void ask(s)} className="rounded-chip border border-border bg-raised/40 px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-text">{s}</button>
                  ))}
                </div>
              </>
            )}
            {st.k === "loading" && (
              <div className="flex items-center gap-2 text-muted-foreground" role="status" data-testid="ask-loading">
                <Loader2 className="size-3.5 animate-spin text-live" />Reading the facts… {ASSIST_TIMEOUT_MS / 1000} s at most.
              </div>
            )}
            {(st.k === "done" || st.k === "local") && (
              <>
                <div className="rounded-chip bg-raised/60 px-2.5 py-1.5 text-muted-foreground">{st.q}</div>
                <div data-testid="ask-answer">
                  {st.k === "done" ? (
                    <p className="whitespace-pre-line leading-[1.5]">{st.res.answer}</p>
                  ) : (
                    <p className="flex items-start gap-2 leading-[1.5]">
                      <WifiOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span>{st.why === "timeout" ? `The assistant did not answer within ${ASSIST_TIMEOUT_MS / 1000} s` : "The assistant is not reachable"} — here is what the Workbench already knows about this signal.</span>
                    </p>
                  )}
                  <p className={cn("mt-1.5 text-[11px]", st.k === "done" && st.res.source === "refused" ? "text-warn" : "text-muted-foreground")}>
                    {st.k === "done" ? SOURCE[st.res.source] : "Structured explanation — straight from the allocation"}
                  </p>
                </div>
                {facts.length > 0 && (
                  <section data-testid="ask-facts">
                    <div className="label-caps mb-1 flex items-center gap-1.5"><FileText className="size-3" />Facts it came from</div>
                    <ul className="space-y-1">
                      {facts.map((f, i) => (
                        <li key={i} className="flex gap-2 rounded-md border border-border bg-raised/30 px-2 py-1 text-[12px] leading-snug"><span className="mt-[5px] size-1 shrink-0 rounded-full bg-brand" />{f}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>

          <form className="flex shrink-0 gap-2 border-t border-border p-2.5" onSubmit={(e) => (e.preventDefault(), void ask())}>
            <input
              ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this signal…" aria-label="Ask OptiSlot" maxLength={300}
              className="h-8 min-w-0 flex-1 rounded-chip border border-border bg-raised/60 px-2.5 text-[12.5px] outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40"
              data-testid="ask-input"
            />
            <button type="submit" disabled={!q.trim() || st.k === "loading"} aria-label="Ask" className="grid h-8 w-8 shrink-0 place-items-center rounded-chip bg-brand text-white transition-opacity hover:brightness-110 disabled:opacity-40">
              <Send className="size-3.5" />
            </button>
          </form>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
