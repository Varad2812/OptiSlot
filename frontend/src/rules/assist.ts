import { useQuery } from "@tanstack/react-query";

import { useProjectId, type S } from "@/api/hooks";
import { useUi } from "@/store/ui";

// Optional AI (docs/api_workbench.md §6): it drafts and explains, it never places and never saves. Every call here
// has an 8 s ceiling and fails into a state the UI can show — none of it ever raises a toast or blocks a page.
export type AssistStatus = S["AssistStatus"];
export type NlResult = S["NLRuleResult"];
export type RuleCandidate = S["RuleCandidate"];
export type AskResult = S["AssistAnswer"];

export const ASSIST_TIMEOUT_MS = 8000;

export type AssistFailure = "timeout" | "offline" | "error";
export class AssistError extends Error {
  constructor(public kind: AssistFailure, message: string) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, ms = ASSIST_TIMEOUT_MS): Promise<T> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`/api${path}`, {
      method, signal: ctl.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
      } catch {
        /* keep the status line */
      }
      throw new AssistError("error", msg);
    }
    useUi.getState().setOffline(false);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof AssistError) throw e;
    if ((e as Error)?.name === "AbortError") throw new AssistError("timeout", `No answer within ${ms / 1000} s`);
    throw new AssistError("offline", "The API is not reachable");
  } finally {
    window.clearTimeout(timer);
  }
}

export const draftRules = (pid: string, text: string) => call<NlResult>("POST", `/projects/${pid}/rules/nl`, { text });
export const askAssistant = (pid: string, question: string, tag?: string, row?: number) =>
  call<AskResult>("POST", `/projects/${pid}/assist/ask`, { question, tag: tag ?? null, row: row ?? null });

/** Which provider answers. Any failure reads as "none": the deterministic templates still work. */
export function useAssistStatus() {
  const pid = useProjectId();
  return useQuery({
    queryKey: ["assist-status", pid],
    queryFn: async (): Promise<AssistStatus & { reachable: boolean }> => {
      try {
        return { ...(await call<AssistStatus>("GET", "/assist/status", undefined, 4000)), reachable: true };
      } catch (e) {
        return { provider: "none", model: "", reachable: !(e instanceof AssistError && e.kind === "offline") };
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

const PROVIDER = { gemini: "Gemini", anthropic: "Claude" } as const;
export const providerLabel = (s?: Pick<AssistStatus, "provider" | "model"> | null) =>
  !s || s.provider === "none" ? "AI offline — using rule templates" : `${PROVIDER[s.provider]}${s.model ? ` · ${s.model}` : ""}`;
