/**
 * Motion bus: the Workbench (and the Revision flow) announce what just happened so the 3D Room can play it.
 *   - another window with the Room open gets it live (BroadcastChannel) — the camera follows there;
 *   - in this window the Room is not mounted while the Workbench is. Every applied move is remembered in the move log
 *     until a Room has played it, so it flies in whenever the Room opens, however long ago it was applied;
 *   - a refused move is only worth shaking for a while (30 s), then it is stale.
 */
export interface LoggedMove {
  seq: number;     // order applied
  batch: number;   // moves applied together (a swap, a whole cable) fly together
  key: string;     // moveKey
  tag: string;
  from: string;
  to: string;
  at: number;
}
export type MotionEvent =
  | { kind: "move"; keys: string[]; tag: string; moves?: { tag: string; from: string; to: string }[]; at: number }
  | { kind: "refused"; slot: string; tag: string; at: number };

type Payload = MotionEvent extends infer E ? (E extends MotionEvent ? Omit<E, "at"> : never) : never;

/** Same key the Room uses for a sandbox move. */
export const moveKey = (m: { tag: string; from_slot?: string | null; to_slot?: string | null }) => `${m.tag}|${m.from_slot}|${m.to_slot}`;

const REFUSED_MAX_AGE = 30_000;
const subs = new Set<(e: MotionEvent) => void>();
let pending: MotionEvent | null = null;
let ch: BroadcastChannel | null = null;
try {
  ch = new BroadcastChannel("optislot-motion");
  ch.onmessage = (m: MessageEvent<MotionEvent>) => deliver(m.data);
} catch {
  ch = null; // no BroadcastChannel: same-window hand-off only
}

const LOG_CAP = 500;
let moveLog: LoggedMove[] = [];
let played = new Set<string>(); // keys the Room has animated
let seqNo = 0;
let batchNo = 0;

function record(e: Extract<MotionEvent, { kind: "move" }>) {
  const batch = ++batchNo;
  for (const m of e.moves ?? []) {
    const key = `${m.tag}|${m.from}|${m.to}`;
    played.delete(key); // the same move applied again after an undo plays again
    moveLog = moveLog.filter((x) => x.key !== key);
    moveLog.push({ seq: ++seqNo, batch, key, tag: m.tag, from: m.from, to: m.to, at: e.at });
  }
  if (moveLog.length > LOG_CAP) moveLog = moveLog.slice(-LOG_CAP);
}

function deliver(e: MotionEvent) {
  if (e.kind === "move") record(e);
  if (subs.size) subs.forEach((f) => f(e));
  else if (e.kind === "refused") pending = e;
}

/** Applied moves no Room has played yet, oldest first (`present` limits it to keys still in the sandbox / change set). */
export function unseenMoves(present?: Set<string>): LoggedMove[] {
  return moveLog.filter((m) => !played.has(m.key) && (!present || present.has(m.key)));
}

export function markPlayed(keys: Iterable<string>) {
  for (const k of keys) played.add(k);
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

/** The refusal that arrived while no Room was listening, if it is still fresh. One taker (a re-mount within 1 s — React's
 *  StrictMode double mount — gets the same one). */
export function takePending(): MotionEvent | null {
  if (!pending && taken && performance.now() - taken.t < 1000) return taken.e;
  const p = pending;
  pending = null;
  if (!p || Date.now() - p.at >= REFUSED_MAX_AGE) return null;
  taken = { e: p, t: performance.now() };
  return p;
}
