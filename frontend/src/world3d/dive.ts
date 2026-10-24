import * as THREE from "three";

import type { Slot } from "@/api/hooks";
import { IO_COLOURS } from "@/lib/io";

import { KIND_KEYS, ST_ALARM, ST_FIELD, ST_WIRED } from "./data";
import { decode, zOf, type Layout } from "./layout";

/**
 * Location Rain Dive (CLAUDE.md §10.10), ported from legacy3d/reference_launch.html. The real slot ids of the allocation
 * (P30-DCM-32001-01/015/5/1), coloured by IO type, fall from above into the junction box and fly along its light trails into
 * their exact CHARM, cabinet by cabinet in allocation order; each landing lights its CHARM. The camera starts at the junction
 * box, pulls back across the room and settles on L0.
 *
 * Everything is a function of the dive clock t = p · dur (seconds), so the engine plays it on its own clock or freezes it with
 * seek(p). The rain itself is ONE instanced billboard mesh (a text atlas of up to LABELS_MAX codes) + ONE Points layer; all
 * motion is evaluated in the vertex shader. Big projects are sampled: at most RAIN_MAX flights, ≈ 600 particles on screen at
 * once; the CHARMs of the signals that were not sampled still light at their own landing time.
 */
export interface DiveKey {
  /** Progress at which the camera passes this pose. */
  at: number;
  pos: [number, number, number];
  target: [number, number, number];
}

export interface DiveScript {
  /** Seconds at cinematic speed. */
  dur: number;
  /** First and last landing (s): the signals land inside this window, cabinet by cabinet. */
  rain: [number, number];
  /** Flight time of one location code, min / max (s): fall into the junction box, then along the trail. */
  flight: [number, number];
  /** Camera poses before the landing; the engine appends the L0 pose at p = 1. */
  keys(L: Layout): DiveKey[];
  fov(p: number): number;
  /** Light-trail alpha (junction box → the baseplates that received cables). */
  trail(p: number): number;
  /** HUD line for dive time t. */
  stage(t: number): string;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const smooth = (u: number) => u * u * (3 - 2 * u);

export const RAIN: DiveScript = {
  dur: 7.6,
  rain: [1.0, 6.0],
  flight: [1.3, 1.8],
  keys(L) {
    const [jx, jy, jz] = L.jb;
    const s = L.room.scale, w = L.room.w, front = L.D / 2;
    const [hx, hy, hz] = L.home.pos;
    return [
      // over the front row, close on the junction box: the codes pour into it from above
      { at: 0, pos: [jx, jy + 0.4, front + 2.5], target: [jx, jy + 0.5, jz] },
      // pull back: the trails fan out from the box to the cabinets
      { at: 0.16, pos: [jx * 0.6, jy + 1.6, front + 8 * s], target: [jx * 0.4, jy - 1.6, jz + 2] },
      { at: 0.38, pos: [-0.45 * w, 3.6 + 2 * s, front + 13 * s], target: [-0.2 * w, 1.8, L.room.cz] }, // the first cabinets fill
      { at: 0.62, pos: [0.45 * w, 4 + 2 * s, front + 13 * s], target: [0.2 * w, 1.8, L.room.cz] }, // … then the last ones
      { at: 0.84, pos: [hx, hy * 1.12, hz * 1.12], target: L.home.target },
    ];
  },
  fov: (p) => 34 + 6 * smooth(span(p, 0, 0.3)), // a long lens on the box widens as the room comes into view
  trail: (p) => smooth(span(p, 0.03, 0.12)) * (1 - smooth(span(p, 0.82, 0.97))),
  stage: (t) => (t < RAIN.rain[0] ? "Routing through the junction box" : t < RAIN.rain[1] + 0.3 ? "Landing signals in their CHARMs" : "Settling on the room"),
};

/** Seconds of the landing flash on a CHARM. */
export const FLASH_S = 0.9;
const RAIN_MAX = 640;
const LABELS_MAX = 256;
const TAILS = [0.06, 0.14]; // droplets trailing each code, lag in seconds

/** Who lands when: live signals (Field + Cabinet Alarm) in allocation order; wired spares light with their cabinet. */
export interface RainPlan {
  /** Instance indices of the live signals, ordered by landing time, and that time (s). */
  idx: Int32Array;
  land: Float32Array;
  wired: Int32Array;
  wiredAt: Float32Array;
  /** Per cabinet: first and last landing (s). */
  cab: { a: number; b: number }[];
}

/** Deterministic jitter (same seed → the same dive every time, like the rest of the run). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planRain(L: Layout, status: Uint8Array, s: DiveScript): RainPlan {
  const per = L.K * L.B * L.M;
  const live: number[][] = Array.from({ length: L.n }, () => []);
  const wired: number[][] = Array.from({ length: L.n }, () => []);
  for (let i = 0; i < L.N; i++) {
    const st = status[i], c = (i / per) | 0;
    if (st === ST_FIELD || st === ST_ALARM) live[c].push(i); // instance order = cabinet → CIOC → baseplate → channel
    else if (st === ST_WIRED) wired[c].push(i);
  }
  // cabinet windows: staggered left → right (row by row), each overlapping the next a little
  const [T0, T1] = s.rain, step = (T1 - T0) / Math.max(1, L.n);
  const rnd = rng(7);
  const out: [number, number][] = [];
  const cab = live.map((list, c) => {
    const a = T0 + c * step, b = Math.min(T1, a + step * (L.n > 1 ? 1.5 : 1));
    list.forEach((i, j) => out.push([i, a + ((j + 0.15 + rnd() * 0.7) / Math.max(1, list.length)) * (b - a)]));
    return { a, b: list.length ? b : a };
  });
  out.sort((x, y) => x[1] - y[1]);
  const w = wired.flat();
  return {
    idx: Int32Array.from(out, (x) => x[0]),
    land: Float32Array.from(out, (x) => x[1]),
    wired: Int32Array.from(w),
    wiredAt: Float32Array.from(w, (i) => cab[(i / per) | 0].b + 0.2),
    cab,
  };
}

/** Signals landed by time t (binary search in the sorted landing times). */
export function landedBy(plan: RainPlan, t: number) {
  let lo = 0, hi = plan.land.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (plan.land[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Rain {
  group: THREE.Group;
  /** Dive clock (s) — every flight is positioned from it in the shader. */
  uT: { value: number };
  /** Pixels per world unit at distance 1 (point sizes). */
  uPx: { value: number };
  flights: number;
  labels: number;
  /** Particles on screen at dive time t (codes + droplets in flight) — the shader's own on/off test, on the CPU. */
  visible(t: number): number;
  dispose(): void;
}

const PATH = /* glsl */ `uniform vec3 uJ;
// every flight crosses the junction box: dim the codes around it so they do not pile up into a white knot
float boxDim(float u) { return 1. - .8 * exp(-pow((u - .44) / .14, 2.)); }
vec3 pathPos(float u, vec3 s, vec3 p1, vec3 p2, vec3 d, float sd) {
  const float KK = .38; vec3 p;
  if (u < KK) { float f = clamp(u / KK, 0., 1.); f = f * f; p = mix(s, uJ, f); }
  else {
    float g = clamp((u - KK) / (1. - KK), 0., 1.); g = mix(g, g * g * (3. - 2. * g), .55); float h = 1. - g;
    p = h * h * h * uJ + 3. * h * h * g * p1 + 3. * h * g * g * p2 + g * g * g * d;
  }
  p.x += sin(u * 18. + sd * 6.283) * .05 * (1. - u);
  return p;
}`;

/**
 * Build the rain for a plan: flights sampled evenly from the landing order, the first LABELS_MAX of them (evenly spread) carry their
 * slot id as a text billboard, every flight drags TAILS droplets. `charm(i)` = world position of CHARM i at the dive's spread.
 */
export function buildRain(L: Layout, plan: RainPlan, kind: Int8Array, slots: (Slot | null)[], jb: THREE.Vector3, charm: (i: number, out: THREE.Vector3) => THREE.Vector3, s: DiveScript): Rain {
  const all = plan.idx.length;
  const nF = Math.min(all, RAIN_MAX);
  const pick = Array.from({ length: nF }, (_, j) => Math.floor((j * all) / nF));
  const labelEvery = Math.max(1, nF / LABELS_MAX);
  const rnd = rng(11);
  const sc = Math.sqrt(L.room.scale);
  const A = new Float32Array(nF * 4), S = new Float32Array(nF * 3), P1 = new Float32Array(nF * 3), P2 = new Float32Array(nF * 3), D = new Float32Array(nF * 3), C = new Float32Array(nF * 3);
  const texts: string[] = [];
  const labelOf = new Int32Array(nF).fill(-1);
  const v = new THREE.Vector3(), col = new THREE.Color();
  pick.forEach((j, f) => {
    const i = plan.idx[j], { c, k } = decode(L, i);
    const dur = s.flight[0] + rnd() * (s.flight[1] - s.flight[0]);
    if (Math.floor(f / labelEvery) !== Math.floor((f - 1) / labelEvery)) (labelOf[f] = texts.length), texts.push(slots[i]?.id ?? ""); // first of each bucket
    A.set([plan.land[j] - dur, dur, labelOf[f], rnd()], f * 4);
    S.set([jb.x + (rnd() - 0.5) * 5 * sc, jb.y + 5 + rnd() * 4 * sc, jb.z + 0.4 + (rnd() - 0.5) * 0.8], f * 3);
    charm(i, v);
    D.set([v.x, v.y, v.z], f * 3);
    P1.set([jb.x + (v.x - jb.x) * 0.35, jb.y - 0.8, jb.z + 2.4], f * 3);
    P2.set([v.x, v.y + 2.4, L.cab[c].z + zOf(L, k) * 1.4 - 0.5], f * 3);
    const kk = kind[i];
    col.set(kk >= 0 ? IO_COLOURS[KIND_KEYS[kk]] : "#8C95A8");
    C.set([col.r, col.g, col.b], f * 3);
  });

  // text atlas: one cell per labelled code (mono, the app's bundled JetBrains Mono when it is loaded)
  const nL = Math.max(1, texts.length), COLS = nL > 64 ? 8 : 4, ROWS = Math.ceil(nL / COLS), CW = 384, CH = 48;
  const ac = document.createElement("canvas");
  ac.width = COLS * CW;
  ac.height = ROWS * CH;
  const g2 = ac.getContext("2d")!;
  g2.font = '500 25px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
  g2.textAlign = "center";
  g2.textBaseline = "middle";
  g2.fillStyle = "#fff";
  texts.forEach((t, n) => g2.fillText(t, (n % COLS) * CW + CW / 2, Math.floor(n / COLS) * CH + CH / 2 + 1));
  const atlas = new THREE.CanvasTexture(ac);
  atlas.generateMipmaps = false;
  atlas.minFilter = atlas.magFilter = THREE.LinearFilter;

  const uT = { value: 0 }, uPx = { value: 600 }, uJ = { value: jb.clone() };
  const group = new THREE.Group();

  // labels: one instanced quad per labelled flight (unlabelled ones skip the billboard: aA.z < 0 → clipped)
  const quad = new THREE.PlaneGeometry(1, 1);
  const rg = new THREE.InstancedBufferGeometry();
  rg.index = quad.index;
  rg.setAttribute("position", quad.getAttribute("position"));
  rg.setAttribute("uv", quad.getAttribute("uv"));
  rg.instanceCount = nF;
  const inst = (a: Float32Array, n: number) => new THREE.InstancedBufferAttribute(a, n);
  rg.setAttribute("aA", inst(A, 4));
  rg.setAttribute("aS", inst(S, 3));
  rg.setAttribute("aP1", inst(P1, 3));
  rg.setAttribute("aP2", inst(P2, 3));
  rg.setAttribute("aD", inst(D, 3));
  rg.setAttribute("aC", inst(C, 3));
  const lw = 3.4 * Math.pow(L.room.scale, 0.6);
  const labelMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT, uJ, uSz: { value: new THREE.Vector2(lw, lw / 8) }, uTex: { value: atlas } },
    vertexShader: `#define COLS ${COLS}.
#define ROWS ${ROWS}.
uniform float uT; uniform vec2 uSz;
attribute vec4 aA; attribute vec3 aS, aP1, aP2, aD, aC;
varying vec2 vUv; varying vec4 vCol;
${PATH}
void main() {
  float u = (uT - aA.x) / aA.y;
  float on = step(0., u) * step(u, 1.) * step(0., aA.z);
  vec3 p = pathPos(u, aS, aP1, aP2, aD, aA.w);
  float sc = mix(1., .55, smoothstep(.88, 1., u));
  vec4 mv = viewMatrix * vec4(p, 1.); mv.xy += position.xy * uSz * sc;
  gl_Position = on > .5 ? projectionMatrix * mv : vec4(2., 2., 2., 1.);
  vCol = vec4(aC, smoothstep(0., .08, u) * (1. - smoothstep(.93, 1., u)) * boxDim(u));
  float col = mod(aA.z, COLS), row = floor(aA.z / COLS);
  vUv = vec2((col + uv.x) / COLS, 1. - (row + 1. - uv.y) / ROWS);
}`,
    fragmentShader: `uniform sampler2D uTex; varying vec2 vUv; varying vec4 vCol;
void main() { float t = texture2D(uTex, vUv).a; gl_FragColor = vec4(vCol.rgb * 1.45, t * vCol.a * .9); }`,
  });
  const labels = new THREE.Mesh(rg, labelMat);

  // droplets: TAILS points per flight, each a little behind the code on the same path
  const nT = TAILS.length, nP = nF * nT;
  const tA = new Float32Array(nP * 4), tS = new Float32Array(nP * 3), t1 = new Float32Array(nP * 3), t2 = new Float32Array(nP * 3), tD = new Float32Array(nP * 3), tC = new Float32Array(nP * 3);
  for (let f = 0; f < nF; f++)
    for (let j = 0; j < nT; j++) {
      const o = f * nT + j;
      tA.set([A[f * 4], A[f * 4 + 1], TAILS[j] / A[f * 4 + 1], A[f * 4 + 3]], o * 4);
      for (const [dst, src] of [[tS, S], [t1, P1], [t2, P2], [tD, D], [tC, C]] as const) dst.set(src.subarray(f * 3, f * 3 + 3), o * 3);
    }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nP * 3), 3));
  const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n);
  pg.setAttribute("aA", attr(tA, 4));
  pg.setAttribute("aS", attr(tS, 3));
  pg.setAttribute("aP1", attr(t1, 3));
  pg.setAttribute("aP2", attr(t2, 3));
  pg.setAttribute("aD", attr(tD, 3));
  pg.setAttribute("aC", attr(tC, 3));
  const dropMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT, uJ, uPx, uSc: { value: sc } },
    vertexShader: `uniform float uT, uPx, uSc;
attribute vec4 aA; attribute vec3 aS, aP1, aP2, aD, aC;
varying vec4 vCol;
${PATH}
void main() {
  float u = (uT - aA.x) / aA.y - aA.z;
  float on = step(0., u) * step(u, 1.);
  vec3 p = pathPos(u, aS, aP1, aP2, aD, aA.w);
  vec4 mv = viewMatrix * vec4(p, 1.);
  gl_Position = on > .5 ? projectionMatrix * mv : vec4(2., 2., 2., 1.);
  gl_PointSize = uPx * .085 * uSc * (1. - aA.z * 2.2) / max(-mv.z, .1);
  vCol = vec4(aC, smoothstep(0., .06, u) * (1. - smoothstep(.95, 1., u)) * (1. - aA.z * 2.6) * boxDim(u));
}`,
    fragmentShader: `varying vec4 vCol;
void main() { float d = length(gl_PointCoord - .5); gl_FragColor = vec4(vCol.rgb * 1.8, smoothstep(.5, 0., d) * vCol.a); }`,
  });
  const drops = new THREE.Points(pg, dropMat);
  for (const o of [labels, drops]) (o.frustumCulled = false), (o.renderOrder = 5), (o.raycast = () => {}), group.add(o);
  return {
    group, uT, uPx, flights: nF, labels: texts.length,
    visible(t) {
      let n = 0;
      for (let f = 0; f < nF; f++) {
        const u = (t - A[f * 4]) / A[f * 4 + 1];
        if (A[f * 4 + 2] >= 0 && u >= 0 && u <= 1) n++;
        for (const lag of TAILS) if (u - lag / A[f * 4 + 1] >= 0 && u - lag / A[f * 4 + 1] <= 1) n++;
      }
      return n;
    },
    dispose() {
      group.removeFromParent();
      quad.dispose();
      rg.dispose();
      pg.dispose();
      labelMat.dispose();
      dropMat.dispose();
      atlas.dispose();
    },
  };
}
