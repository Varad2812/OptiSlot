import { useUi } from "@/store/ui";

/**
 * GET against the real API. When the backend is unreachable (network error / 5xx) the matching
 * generated fixture is returned instead and the shell shows "Offline fixtures" (CLAUDE.md §10: never empty).
 */
export async function getJson<T>(path: string, fallback?: () => Promise<T> | T): Promise<T> {
  try {
    const res = await fetch(`/api${path}`);
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new ApiError(res.status, await detail(res));
    useUi.getState().setOffline(false);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError || !fallback) throw e;
    useUi.getState().setOffline(true);
    return await fallback();
  }
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await detail(res));
  useUi.getState().setOffline(false);
  return (await res.json()) as T;
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, await detail(res));
  useUi.getState().setOffline(false);
  return (await res.json()) as T;
}

export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, await detail(res));
  useUi.getState().setOffline(false);
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function detail(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
  } catch {
    return `HTTP ${res.status}`;
  }
}
