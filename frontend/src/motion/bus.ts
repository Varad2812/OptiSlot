/**
 * Motion bus: the Workbench (and the Revision flow) announce what just happened so the 3D Room can play it.
 *   - another window with the Room open gets it live (BroadcastChannel) — the camera follows there;
 *   - in this window the Room is not mounted while the Workbench is, so the last event waits (briefly) and plays when
 *     the Room opens ("Show in 3D" right after Apply).
 */
export type MotionEvent =
  | { kind: "move"; keys: string[]; tag: string; at: number }
  | { kind: "refused"; slot: string; tag: string; at: number };

type Payload = MotionEvent extends infer E ? (E extends MotionEvent ? Omit<E, "at"> : never) : never;

/** Same key the Room uses for a sandbox move. */
export const moveKey = (m: { tag: string; from_slot?: string | null; to_slot?: string | null }) => `${m.tag}|${m.from_slot}|${m.to_slot}`;

const MAX_AGE: Record<MotionEvent["kind"], number> = { move: 30_000, refused: 8_000 };
const subs = new Set<(e: MotionEvent) => void>();
let pending: MotionEvent | null = null;
let ch: BroadcastChannel | null = null;
try {
  ch = new BroadcastChannel("optislot-motion");
  ch.onmessage = (m: MessageEvent<MotionEvent>) => deliver(m.data);
} catch {
  ch = null; // no BroadcastChannel: same-window hand-off only
}

function deliver(e: MotionEvent) {
  if (subs.size) subs.forEach((f) => f(e));
  else pending = e;
}

export function publish(p: Payload) {
  const e = { ...p, at: Date.now() } as MotionEvent;
  deliver(e);
  try {
    ch?.postMessage(e);
  } catch {
    /* closed channel */
  }
}

export function subscribe(f: (e: MotionEvent) => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

let taken: { e: MotionEvent; t: number } | null = null;

/** The event that arrived while no Room was listening, if it is still fresh. One taker (a re-mount within 1 s — React's
 *  StrictMode double mount — gets the same one). */
export function takePending(): MotionEvent | null {
  if (!pending && taken && performance.now() - taken.t < 1000) return taken.e;
  const p = pending;
  pending = null;
  if (!p || Date.now() - p.at >= MAX_AGE[p.kind]) return null;
  taken = { e: p, t: performance.now() };
  return p;
}
