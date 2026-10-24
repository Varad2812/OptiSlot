import { AlertTriangle, ArrowDownToLine, CircleHelp, Loader2, Sparkles, WifiOff } from "lucide-react";
import { useRef, useState } from "react";

import { useProjectId } from "@/api/hooks";
import { cn } from "@/lib/utils";

import { AssistError, ASSIST_TIMEOUT_MS, draftRules, providerLabel, useAssistStatus, type NlResult, type RuleCandidate } from "./assist";

const EXAMPLES = [
  "no more than 8 AI per baseplate",
  "keep XYV outputs and group 320 on different CIOCs",
  "reserve 15% spares for DI",
];

type State =
  | { k: "idle" }
  | { k: "loading" }
  | { k: "done"; res: NlResult; text: string }
  | { k: "fail"; why: "timeout" | "offline" | "error"; message: string };

/**
 * "English → rule": a sentence in, rule candidates out. Each candidate is already validated by the backend and read back
 * in plain English; choosing one only loads it into the builder below, which previews it. Nothing here saves anything.
 */
export function NlBox({ onPick, picked }: { onPick: (c: RuleCandidate) => void; picked: RuleCandidate | null }) {
  const pid = useProjectId();
  const status = useAssistStatus();
  const [text, setText] = useState("");
  const [st, setSt] = useState<State>({ k: "idle" });
  const token = useRef(0);
  const loading = st.k === "loading";

  async function run(sentence = text) {
    const t = sentence.trim();
    if (!t || loading) return;
    const mine = ++token.current;
    setSt({ k: "loading" });
    try {
      const res = await draftRules(pid, t);
      if (mine === token.current) setSt({ k: "done", res, text: t });
    } catch (e) {
      if (mine !== token.current) return;
      const f = e instanceof AssistError ? e : new AssistError("error", (e as Error).message);
      setSt({ k: "fail", why: f.kind, message: f.message });
    }
  }

  const live = status.data && status.data.provider !== "none";
  return (
    <section className="card-surface p-4" data-testid="nl-box" aria-label="English to rule">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold"><Sparkles className="size-4 text-brand" />English → rule</h2>
        <span
          className={cn("inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-[11px]", live ? "border-live/40 text-text" : "border-border text-muted-foreground")}
          data-testid="nl-provider" title={live ? "A language model drafts; the backend validates every candidate" : "No AI provider: a deterministic phrase parser answers"}
        >
          <span className={cn("size-1.5 rounded-full", live ? "bg-live shadow-[0_0_6px_rgb(var(--live))]" : "bg-muted-foreground/60")} />
          {status.isLoading ? "Checking AI…" : providerLabel(status.data)}
        </span>
      </div>
      <p className="mt-0.5 text-[12px] text-muted-foreground">Describe a constraint in a sentence. You get validated drafts to review — the AI never saves a rule or places a signal.</p>

      <form className="mt-3 flex gap-2" onSubmit={(e) => (e.preventDefault(), void run())}>
        <input
          value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. keep AI and DI on different CIOCs" aria-label="Describe a rule in English" maxLength={400}
          className="h-9 min-w-0 flex-1 rounded-chip border border-border bg-raised/60 px-2.5 text-[12.5px] outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40"
          data-testid="nl-input"
        />
        <button
          type="submit" disabled={!text.trim() || loading} data-testid="nl-draft"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-chip border border-brand/50 bg-brand/15 px-3 text-[12.5px] font-medium transition-colors hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5 text-brand" />}Draft
        </button>
      </form>

      {st.k === "idle" && (
        <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Examples">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" onClick={() => (setText(x), void run(x))} className="rounded-chip border border-border bg-raised/40 px-2 py-1 text-left text-[11.5px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-text">
              {x}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground" role="status" data-testid="nl-loading">
          <Loader2 className="size-3.5 animate-spin text-live" />Drafting… gives up after {ASSIST_TIMEOUT_MS / 1000} s and the templates take over.
        </div>
      )}

      {st.k === "fail" && (
        <div className="mt-3 flex items-start gap-2.5 rounded-chip border border-dashed border-border px-3 py-2.5 text-[12.5px]" role="status" data-testid={`nl-${st.why}`}>
          {st.why === "offline" ? <WifiOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />}
          <div className="min-w-0">
            <div className="font-medium">
              {st.why === "timeout" ? `No answer within ${ASSIST_TIMEOUT_MS / 1000} s` : st.why === "offline" ? "The rule assistant is offline" : "The assistant could not draft that"}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {st.why === "offline" ? "The API is not reachable. " : st.why === "error" ? `${st.message}. ` : ""}Nothing was changed — use the templates below, or try again.
            </div>
            <button type="button" onClick={() => void run()} className="mt-1 text-[12px] text-brand hover:underline">Try again</button>
          </div>
        </div>
      )}

      {st.k === "done" && <Result res={st.res} text={st.text} picked={picked} onPick={onPick} />}
    </section>
  );
}

function Result({ res, text, picked, onPick }: { res: NlResult; text: string; picked: RuleCandidate | null; onPick: (c: RuleCandidate) => void }) {
  const cands = res.candidates ?? [];
  return (
    <div className="mt-3 space-y-2" aria-live="polite" data-testid="nl-result">
      {res.clarifying_question && (
        <div className="flex items-start gap-2.5 rounded-chip border border-warn/40 bg-warn/[0.07] px-3 py-2.5 text-[12.5px]" data-testid="nl-question">
          <CircleHelp className="mt-0.5 size-4 shrink-0 text-warn" />
          <div><div className="font-medium">One question first</div><div className="mt-0.5 text-muted-foreground">{res.clarifying_question}</div></div>
        </div>
      )}
      {cands.map((c, i) => {
        const on = picked === c;
        return (
          <article key={i} className={cn("rounded-chip border px-3 py-2.5", on ? "border-brand/60 bg-brand/[0.08]" : "border-border bg-raised/40")} data-testid="nl-candidate">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 text-[13px] font-medium leading-snug">{c.label || c.rule_type}</div>
              <span className="shrink-0 rounded-chip border border-border px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">{c.rule_type}</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-snug">{c.readback}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5" title="How sure the drafter is that this is what you meant">
                confidence
                <span className="h-1.5 w-14 overflow-hidden rounded-full bg-border"><span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(Math.max(0, Math.min(1, c.confidence)) * 100)}%` }} /></span>
                <span className="tnum text-text">{Math.round(c.confidence * 100)}%</span>
              </span>
              <span>{c.severity === "hard" ? "blocking" : "warning only"}</span>
              <button
                type="button" onClick={() => onPick(c)} data-testid="nl-use"
                className="ml-auto inline-flex items-center gap-1.5 rounded-chip border border-brand/50 px-2 py-1 text-[12px] font-medium text-text transition-colors hover:bg-brand/20"
              >
                <ArrowDownToLine className="size-3.5 text-brand" />{on ? "Loaded in the builder" : "Load into builder"}
              </button>
            </div>
            {(c.warnings ?? []).map((w, k) => (
              <p key={k} className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-warn"><AlertTriangle className="mt-px size-3 shrink-0" />{w}</p>
            ))}
          </article>
        );
      })}
      {(res.errors ?? []).map((er, i) => (
        <p key={i} className="rounded-chip border border-err/40 bg-err/10 px-2.5 py-1.5 text-[12px] text-err" role="alert" data-testid="nl-error">{er}</p>
      ))}
      {!cands.length && !res.clarifying_question && (
        <p className="rounded-chip border border-dashed border-border px-3 py-2.5 text-[12.5px] text-muted-foreground" data-testid="nl-empty">
          No rule could be drafted from “{text}”. Name the signals (an IO type like AI, an instrument type like XYV, a group, or a tag pattern) and the limit — or use a template below.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {res.source === "llm" ? `Drafted by ${res.provider}` : "Drafted by the rule-template parser"} · validated by the backend · nothing is saved until you press Add.
      </p>
    </div>
  );
}
