import { toast } from "sonner";

/** sha256 of a dropped file (hex). Needs a secure context (localhost counts); null when unavailable, never a throw. */
export async function sha256File(file: File): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Copy blocked by the browser", { description: text });
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 16 chars … 6 chars: long enough to compare by eye, short enough for a 480 px column. */
export const middle = (h?: string | null, a = 16, b = 6) => (h ? (h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h) : "—");
