/**
 * World3DEngine — the Marshalling Room (CLAUDE.md §10.7), ported from frontend/legacy3d/3d_prototype.html.
 *
 * Same look and logic as the prototype: renderer + MSAA HalfFloat target + UnrealBloom, camera-controls
 * fitToBox/rotateTo (smoothTime 0.6), the fade registry T(), doors that swing open, CIOCs whose baseplates
 * spread apart ("explode"), one InstancedMesh for every CHARM, the cable bundle, and the Upload Dive trails.
 *
 * What the port changes (§10.7 items 1, 2, 3, 7):
 *   - real allocation data and Project-Settings counts (layout.ts / data.ts), no random values or fake readings;
 *   - scale: far cabinets are an instanced shell (steel, panels, glass, baseplates, pools: one draw call each) plus
 *     merged line segments; only 3 "rigs" (the prototype's per-cabinet meshes) exist, re-assigned to the focused
 *     cabinet and its neighbours; a fixed pool of 3 point lights moves with them; instance colours are recomputed
 *     only while something is changing;
 *   - everything comes from npm (no CDN), the environment is procedural (no HDR).
 *
 * Indices: cab = index into allocation.cabinets (0-based, like useUi.cabIdx); cioc/bp/ch in the public API are
 * 1-based like Slot (cioc = cioc_local). Internally k/b/m are 0-based, as in the prototype.
 */
import CameraControls from "camera-controls";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Slot } from "@/api/hooks";
import { IO_COLOURS, ioKey, type IoKey } from "@/lib/io";

import { KIND_KEYS, NONE, SPARE, ST_ALARM, ST_FIELD, ST_SPARE, ST_WIRED, type World3DData } from "./data";
import { bpY, chX, decode, frameH, idxOf, isRear, ixOf, stackY, zOf, type Layout } from "./layout";
import { DIVE, type DiveScript } from "./dive";
import { ArcCurve, buildArcTrails, buildBeam, easeInOut, easeOut3, ringGeometry, span, type ArcTrails, type Beam } from "./fx";
import { buildTrails, type Trails } from "./trails";

CameraControls.install({
  THREE: {
    Vector2: THREE.Vector2, Vector3: THREE.Vector3, Vector4: THREE.Vector4, Quaternion: THREE.Quaternion,
    Matrix4: THREE.Matrix4, Spherical: THREE.Spherical, Box3: THREE.Box3, Sphere: THREE.Sphere, Raycaster: THREE.Raycaster,
  },
});

const ACC = 0x7c5cff;
const BG = 0x0a0d13;
const IOC = KIND_KEYS.map((k) => new THREE.Color(IO_COLOURS[k]));
// Per-IO emissive gain: bright hues (DO yellow) would bloom far more than blue at the same factor, so every
// kind is normalised towards the same luminance — the prototype's glow, just even.
const IOGAIN = IOC.map((c) => Math.min(1.15, Math.max(0.55, Math.sqrt(0.3 / Math.max(0.05, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)))));
const HOVER = 0x22d3ee; // brand-2: focus rings only
const CHANGED = 0xffffff;
const RING = 0xc9bdff; // A/B family ring: a lighter violet than the CIOC frame so it reads as its own mark
const RIGS = 3;
const TRAILS_MAX = 48;
const OVERLAY_MAX = 512;
const BLOOM = 0.66;
const RIG_LIGHT = 1.8; // prototype 7: its point light left hot white spots on the glass and hinges
const MARKS_MAX = 96;
// motion-moment colours (§10.1): ok green for a verified CHARM, err red, warn amber, brand-2 cyan for live / new
const OK = new THREE.Color(0x34d399);
const ERR = new THREE.Color(0xf87171);
const WARN = new THREE.Color(0xfbbf24);
const LIVE = new THREE.Color(0x22d3ee);
const BRAND = new THREE.Color(0xa78bfa);
const DARK = new THREE.Color(0.09, 0.1035, 0.135); // a Spare Slot's protection cover (paint())

export type Level = 0 | 1 | 2 | 3 | 4;
/** Public address: cab 0-based, cioc/bp/ch 1-based (Slot fields), -1 = not applicable at this level. */
export interface Address {
  cab: number;
  cioc: number;
  bp: number;
  ch: number;
}
export interface Selection extends Address {
  level: Level;
  /** The face in view: F (front) or R (rear, after F / an orbit to a rear CIOC). */
  face: "F" | "R";
}
/** hover / select payload (§10.8): the address under the pointer (or selected) + where to anchor a DOM card. */
export interface WorldEvent extends Selection {
  slotId?: string;
  cabinet?: string;
  screen: { x: number; y: number };
}
interface EventMap {
  select: WorldEvent;
  hover: WorldEvent | null;
  level: Selection;
  /** A moment started / ended; `frame` fires once, after the moment's first frame is on screen (the Import curtain lifts then). */
  moment: { name: MomentName; phase: "start" | "frame" | "end" };
}
export interface EngineStats {
  firstFrameMs: number | null;
  fps: number;
  drawCalls: number;
  triangles: number;
  instances: number;
  cabinets: number;
}
export interface EngineOptions {
  /** Calm motion: cuts instead of staged camera flights, no dive choreography. Read on every call. */
  calm?: () => boolean;
}
/** The running motion moment (verify scan, tamper, move, refused move, Rev B diff, dive) — see `seek`. */
export type MomentName = "scan" | "tamper" | "move" | "refuse" | "revdiff" | "dive";
export interface MomentOptions {
  /** Start held at p = 0: the caller drives it with seek(p) from its own sequence (Proof / Revisions / Room). */
  drive?: boolean;
  /** Fly the camera to where the moment happens (default true). */
  follow?: boolean;
}
/** Rev B diff for playRevDiff (slot ids of the CURRENT allocation; `io` = the slot's look in the previous revision). */
export interface RevDiff3D {
  added: string[];
  removed: { id: string; io: IoKey }[];
  changed: { id: string; io: IoKey }[];
  moved: { from: string; to: string; io: IoKey }[];
}

interface Pose {
  p: THREE.Vector3;
  t: THREE.Vector3;
}
/** A seekable camera flight: start and end pose, interpolated in spherical coordinates around a moving target. */
interface Flight {
  a: Pose;
  b: Pose;
  hump: number;
}
interface Moment {
  name: MomentName;
  dur: number;
  p: number;
  held: boolean;
  shown: boolean;
  /** Put every non-colour piece of state at progress p (camera, fades, matrices, beams). Idempotent. */
  apply(p: number): void;
  /** Colour overrides after the base paint (only while the moment runs). */
  paint?(p: number): void;
  /** Leave the end state behind and release what the moment owns. Called exactly once. */
  finish(): void;
  resolve(): void;
  off: () => void;
}
interface FadeSnap {
  reg: Float32Array;
  far: number;
  door: number[];
  spread: number[][];
  charm: Float32Array;
  b: number;
  jb: number;
}

interface Sel {
  level: Level;
  c: number;
  k: number;
  b: number;
  m: number;
}
interface Reg {
  m: THREE.Material;
  base: number;
  rig: Rig;
  k: number;
  b: number;
  L: number;
  cur: number;
  t: number;
}
interface RigCioc {
  frame: THREE.LineSegments;
  vol: THREE.Mesh;
  ring: THREE.LineSegments;
  bps: THREE.Mesh[];
  label: CSS2DObject;
  labelOn: boolean;
  bpLabels: CSS2DObject[];
  s: number;
  t: number;
}
interface Rig {
  c: number;
  group: THREE.Group;
  dp: { piv: THREE.Group; s: number }[];
  door: { o: number; t: number };
  light: THREE.PointLight;
  iocs: RigCioc[];
}

const bx = (x: number, y: number, z: number, w: number, h: number, d: number) =>
  new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, y, z), new THREE.Vector3(w, h, d));
const nop = () => {};

function labelEl(cls: string, html: string) {
  const outer = document.createElement("div"); // CSS2DRenderer owns this element's transform
  const inner = document.createElement("div");
  inner.className = cls;
  inner.innerHTML = html;
  outer.appendChild(inner);
  return outer;
}
const LABEL =
  "w3d-in pointer-events-none select-none whitespace-nowrap rounded-full border border-[#3a3470] bg-[rgba(14,18,27,.68)] px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-[#ECEEF3]";
const TAG_LABEL =
  "w3d-in w3d-tag pointer-events-none select-none whitespace-nowrap font-mono text-[9.5px] leading-none tracking-[0.02em] text-[#C9CFDB]";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export class World3DEngine {
  private host: HTMLElement;
  private opts: EngineOptions;
  private renderer: THREE.WebGLRenderer;
  private css: CSS2DRenderer;
  private scene = new THREE.Scene();
  private cam: THREE.PerspectiveCamera;
  private rt: THREE.WebGLRenderTarget;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private ctrl: CameraControls;
  private pm: THREE.PMREMGenerator;
  private envTex: THREE.Texture;
  private clock = new THREE.Clock();
  private raf = 0;
  private el = 0;
  private lastInput = 0;
  private fovT = 40;
  private w = 1;
  private h = 1;
  private t0 = performance.now();
  private firstFrameMs: number | null = null;
  private fpsAvg = 60;
  private lastCalls = 0;
  private lastTris = 0;
  private listeners = new Map<keyof EventMap, Set<(e: never) => void>>();
  private readyRes: () => void = nop;
  /** Resolves after the first frame with data is on screen (moments queued before that wait for it). */
  readonly whenReady = new Promise<void>((r) => (this.readyRes = r));
  private disposed = false;

  // room (static, resized per layout)
  private floor: THREE.Mesh;
  private grid: THREE.GridHelper;
  private wall: THREE.Mesh;
  private jb: THREE.Mesh;
  private jbLabel: CSS2DObject;
  private jbA = 1;
  private jbT = 1;
  private jbLight: THREE.PointLight;
  private bundle = new THREE.Group();
  private bMats: THREE.MeshStandardMaterial[] = [];
  private bCur = 0;
  private bT = 0;

  // data-dependent
  private data: World3DData | null = null;
  private L: Layout | null = null;
  private dyn = new THREE.Group(); // everything rebuilt by setData
  private reg: Reg[] = [];
  private rigs: Rig[] = [];
  private cabs: { glow: number; gt: number }[] = [];
  private cabLabels: CSS2DObject[] = [];
  private cableLabels: CSS2DObject[] = [];
  private far!: {
    steel: THREE.InstancedMesh; panel: THREE.InstancedMesh; glass: THREE.InstancedMesh; bps: THREE.InstancedMesh;
    pools: THREE.InstancedMesh; pick: THREE.InstancedMesh; frames: THREE.LineSegments; edges: THREE.LineSegments;
    mats: { m: THREE.Material; base: number }[]; cur: number; t: number;
  };
  private charms!: THREE.InstancedMesh;
  private hatch!: THREE.InstancedMesh;
  // Working copies of the allocation arrays: Before | Now patches them (setOverlay) without touching the cached data.
  private kind = new Int8Array(0);
  private status = new Uint8Array(0);
  private slots: (Slot | null)[] = [];
  // overlays: changed-CHARM outlines, ghosts at the old slot, flyers for moves, the hover outline, L3 tags
  private outline!: THREE.InstancedMesh;
  private ghosts!: THREE.InstancedMesh;
  private flyers!: THREE.InstancedMesh;
  private outPos = new Int32Array(0);
  private ghostPos = new Int32Array(0);
  // motion moments (§10.7): one at a time, every piece of it a function of its progress p → seekable for ?demo=1
  private moment: Moment | null = null;
  private fade: FadeSnap | null = null; // set while a moment drives the fades (the tick's smoothing pauses)
  private cx = new Float32Array(0);     // instance → world x (the scan beam's position test)
  private beam: Beam | null = null;
  private marks!: THREE.InstancedMesh;  // coloured frames around CHARMs a moment points at (fail, refused, changed)
  private rings!: THREE.InstancedMesh;  // ripples around them
  private markIdx: number[] = [];       // instance index per mark (they follow the baseplate spread)
  private arcs: ArcTrails | null = null;
  private kept: { i: number; c: THREE.Color; a: number }[] | null = null;
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private v4 = new THREE.Vector3();
  private v5 = new THREE.Vector3();
  private s1 = new THREE.Spherical();
  private s2 = new THREE.Spherical();
  private s3 = new THREE.Spherical();
  private c1 = new THREE.Color();
  private hoverBox!: THREE.Mesh;
  private hoverGeo = new Map<string, THREE.BufferGeometry>();
  private hov: { c: number; k: number; b: number; m: number } | null = null;
  private chLabels: CSS2DObject[] = [];
  private face = 0; // L0/L1 viewing side: 0 front, 1 rear (F)
  private wsPos = new Int32Array(0); // idx → hatch instance, -1 if not a wired spare
  private wsIdx = new Int32Array(0); // hatch instance → idx
  private tgt = new Float32Array(0);
  private cur = new Float32Array(0);
  private dim = new Uint8Array(0);   // filter: 1 = does not match
  private pulseMask = new Uint8Array(0);
  private pulse0 = -1;
  private pulseDur = 0;
  private pulseCol = new THREE.Color();
  private colourDirty = true;
  private trails: Trails | null = null;
  private trailA = 0;
  private trailT = 0;
  private trailClock = 0;

  // selection
  private sel: Sel = { level: 0, c: -1, k: -1, b: -1, m: -1 };
  private navToken = 0;
  private diving = false;
  private pd: { x: number; y: number; t: number } | null = null;
  private lastHv = 0;
  private ray = new THREE.Raycaster();
  private nd = new THREE.Vector2();

  constructor(host: HTMLElement, opts: EngineOptions = {}) {
    this.host = host;
    this.opts = opts;
    this.w = Math.max(1, host.clientWidth);
    this.h = Math.max(1, host.clientHeight);

    // ===== RENDERER: WebGL + MSAA render target + bloom post-processing =====
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(this.w, this.h);
    this.renderer.info.autoReset = false;
    const cv = this.renderer.domElement;
    cv.style.display = "block";
    cv.style.touchAction = "none";
    host.appendChild(cv);
    this.css = new CSS2DRenderer();
    this.css.setSize(this.w, this.h);
    Object.assign(this.css.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    host.appendChild(this.css.domElement);

    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.FogExp2(BG, 0.014);
    this.cam = new THREE.PerspectiveCamera(40, this.w / this.h, 0.05, 200);
    this.rt = new THREE.WebGLRenderTarget(this.w, this.h, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, this.rt);
    this.composer.addPass(new RenderPass(this.scene, this.cam));
    // A touch under the prototype's (0.8, 0.7, 0.8): same glow on Field CHARMs, less haze around bright yellows.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.w, this.h), BLOOM, 0.6, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const ctrl = (this.ctrl = new CameraControls(this.cam, cv));
    ctrl.addEventListener("controlstart", () => (this.lastInput = this.el)); // idle drift resumes 4 s after the last input
    ctrl.smoothTime = 0.6;
    ctrl.draggingSmoothTime = 0.12;
    ctrl.minDistance = 0.35;
    ctrl.maxDistance = 60;
    ctrl.maxPolarAngle = 1.55;
    ctrl.mouseButtons.right = CameraControls.ACTION.TRUCK;
    ctrl.setLookAt(0, 7.5, 23, 0, 1.4, 0, false);

    // ===== ROOM: lights, image-based reflections, glossy floor, grid, back wall, junction box =====
    this.pm = new THREE.PMREMGenerator(this.renderer);
    this.envTex = this.pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.add(new THREE.HemisphereLight(0x8899cc, 0x10131a, 0.9));
    const dl = new THREE.DirectionalLight(0xbfc8ff, 1.2);
    dl.position.set(6, 12, 10);
    this.scene.add(dl);
    // satin floor: still catches the cabinets' glow, without mirror-sharp blobs under each light
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.std({ color: 0x090c12, roughness: 0.72, metalness: 0.28 }));
    (this.floor.material as THREE.MeshStandardMaterial).envMapIntensity = 0.08; // no grey sheen at grazing angles
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);
    this.grid = this.makeGrid(60);
    this.wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.std({ color: 0x0d1119, roughness: 0.9 }));
    this.scene.add(this.wall);
    // Junction box: a wall-mounted enclosure (steel body, accent edges, a gland plate the field cables leave from) with a
    // label — it is where the Upload Dive trails start, so it must read as equipment, not a floating slab.
    this.jb = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.9, 0.32),
      this.std({ color: 0x1a1f2b, emissive: ACC, emissiveIntensity: 0.04, metalness: 0.6, roughness: 0.45, transparent: true }),
    );
    const jbEdge = new THREE.LineSegments(new THREE.EdgesGeometry(this.jb.geometry), new THREE.LineBasicMaterial({ color: ACC, transparent: true, opacity: 0.7 }));
    jbEdge.raycast = nop;
    this.jb.add(jbEdge);
    const gland = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.26), this.std({ color: 0x2c3442, metalness: 0.6, roughness: 0.5, transparent: true }));
    gland.position.y = -0.48;
    this.jb.add(gland);
    // the conduit that carries the field cables down the wall into the floor trench: the box is mounted, not floating
    const conduit = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1, 0.12), this.std({ color: 0x232a37, metalness: 0.5, roughness: 0.6, transparent: true }));
    conduit.name = "conduit";
    this.jb.add(conduit);
    this.jbLabel = new CSS2DObject(labelEl(LABEL, "Junction box · field cables"));
    this.jbLabel.position.set(0, 0.72, 0);
    this.jb.add(this.jbLabel);
    this.scene.add(this.jb);
    this.jbLight = new THREE.PointLight(ACC, 0, 14);
    this.scene.add(this.jbLight);

    // ===== CABLE BUNDLE: one shared set of tubes, moved above whichever baseplate is selected =====
    for (let j = 0; j < 7; j++) {
      const x = (j - 3) * 0.15, ex = (j - 3) * 0.17;
      const cv3 = new THREE.CatmullRomCurve3(
        [[x * 0.3, 3.4, -0.1], [x * 0.5, 2.1, -0.28], [x * 0.9, 0.8, -0.24], [ex, 0.1, -0.17]].map((p) => new THREE.Vector3(...p)),
      );
      const mt = this.std({
        color: j % 3 == 0 ? 0x3a2f6b : 0x1c2029, roughness: 0.5, metalness: 0.3, transparent: true, opacity: 0,
        emissive: j % 3 == 0 ? ACC : 0, emissiveIntensity: 0.5,
      });
      this.bMats.push(mt);
      this.bundle.add(new THREE.Mesh(new THREE.TubeGeometry(cv3, 40, 0.03, 8), mt));
    }
    this.bundle.visible = false;
    this.scene.add(this.bundle);
    this.scene.add(this.dyn);

    // ===== INPUT =====
    cv.addEventListener("pointerdown", this.onDown);
    cv.addEventListener("pointerup", this.onUp);
    cv.addEventListener("pointermove", this.onMove);
    cv.addEventListener("pointerleave", this.onLeave);
    this.raf = requestAnimationFrame(this.tick);
  }

  // ───────────── public API ─────────────

  on<K extends keyof EventMap>(ev: K, cb: (e: EventMap[K]) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(cb as (e: never) => void);
    return () => set!.delete(cb as (e: never) => void);
  }

  get selection(): Selection {
    return this.pub(this.sel);
  }

  stats(): EngineStats {
    return {
      firstFrameMs: this.firstFrameMs,
      fps: Math.round(this.fpsAvg),
      drawCalls: this.lastCalls,
      triangles: this.lastTris,
      instances: this.L?.N ?? 0,
      cabinets: this.L?.n ?? 0,
    };
  }

  /** The slot selected at L4 (null above L4). */
  get selectedSlotId(): string | null {
    const s = this.sel;
    if (s.level < 4 || !this.L || !this.data) return null;
    return this.slots[idxOf(this.L, s.c, s.k, s.b, s.m)]?.id ?? null;
  }

  /** Feed a (new) allocation. Rebuilds the instanced world; keeps the selection when it still exists. */
  setData(data: World3DData) {
    if (this.data === data) return;
    if (this.data && sameWorld(this.data, data)) {
      // same slots in the same places (e.g. only the verifier report changed): keep the scene and any running moment
      this.data = data;
      for (let i = 0; i < data.slots.length; i++) this.slots[i] = data.slots[i];
      return;
    }
    const keep = this.data ? this.sel : null;
    this.data = data;
    this.endMoment(); // a moment points at instance indices of the old layout
    const L = (this.L = data.layout);
    this.clearDyn();
    this.kind = data.kind.slice();
    this.status = data.status.slice();
    this.slots = data.slots.slice();
    this.cx = new Float32Array(L.N);
    for (let i = 0; i < L.N; i++) {
      const { c, k, m } = decode(L, i);
      this.cx[i] = L.cab[c].x + ixOf(L, k) + chX(L, m);
    }
    this.hov = null;
    this.layoutRoom(L);
    this.buildCharms(L);
    this.buildOverlays(L);
    this.buildFar(L);
    this.buildRigs(L);
    for (let c = 0; c < L.n; c++) for (let k = 0; k < L.K; k++) this.layCharms(c, k, 0);
    this.colourDirty = true;
    this.buildCabLabels(data, L);
    this.cabs = Array.from({ length: L.n }, () => ({ glow: 0, gt: 0 }));
    this.trails = null;
    const s = keep && keep.c < L.n ? keep : { level: 0 as Level, c: -1, k: -1, b: -1, m: -1 };
    this.assignRigs(s.c >= 0 ? [s.c] : [0]);
    this.setSel(s, false);
  }

  /**
   * Fly to a level. Multi-level jumps are staged in real-life order — cabinet door opens → CIOC → baseplates
   * explode → CHARM — and going up reverses it (the door closes last). Calm mode cuts straight to the target.
   */
  async goTo(level: Level, a: Partial<Address> & { face?: "F" | "R" } = {}): Promise<void> {
    if (!this.L) return;
    if (a.face && level <= 1) this.face = a.face === "R" ? 1 : 0;
    const tgt = this.internal(level, a);
    if (!tgt) return;
    if (this.moment && !this.moment.held) this.endMoment(); // the user (or a page) took the camera: finish the moment now
    const token = ++this.navToken;
    if (this.opts.calm?.()) return void this.setSel(tgt, false);
    const steps = this.path(this.sel, tgt);
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const up = st.level < (i === 0 ? this.sel.level : steps[i - 1].level);
      this.setSel(st, true);
      if (i === steps.length - 1) break;
      await this.sleep(up ? 280 : [0, 620, 520, 420, 0][st.level]);
      if (token !== this.navToken || this.disposed) return;
    }
  }

  /** Up one level (Esc). */
  back() {
    if (this.sel.level > 0 && !this.diving) void this.goTo((this.sel.level - 1) as Level);
  }

  /** Fly to a slot (L4) by its allocation id. */
  async flyToSlot(id: string): Promise<boolean> {
    const i = this.data?.index.get(id);
    if (i == null || !this.L) return false;
    const { c, k, b, m } = decode(this.L, i);
    await this.goTo(4, { cab: c, cioc: k + 1, bp: b + 1, ch: m + 1 });
    return true;
  }

  /** Dim every CHARM whose slot does not match (null = no filter). */
  setFilter(fn: ((s: Slot) => boolean) | null) {
    if (!this.data) return;
    const { slots } = this;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      this.dim[i] = fn && s ? (fn(s) ? 0 : 1) : 0;
    }
    this.retarget();
  }

  /** Pulse slots ×3 in a colour (default err red). */
  pulse(ids: string[], colour = "#F87171", ms = 1300): Promise<void> {
    if (!this.data) return Promise.resolve();
    this.pulseMask.fill(0);
    for (const id of ids) {
      const i = this.data.index.get(id);
      if (i != null) this.pulseMask[i] = 1;
    }
    this.pulseCol.set(colour);
    this.pulse0 = this.el;
    this.pulseDur = ms / 1000;
    this.colourDirty = true;
    return this.sleep(ms);
  }

  /**
   * Before | Now (§10.8): draw a patched state on top of the allocation. `slots` replace the slots with the same id
   * (null = the plain allocation), `outline` frames the changed CHARMs, `ghosts` leave a translucent copy of the
   * listed slots (as they were in the allocation) where a moved CHARM used to be.
   */
  setOverlay(o: { slots?: Slot[] | null; outline?: string[]; ghosts?: string[] } = {}) {
    const d = this.data, L = this.L;
    if (!d || !L) return;
    this.kind.set(d.kind);
    this.status.set(d.status);
    for (let i = 0; i < L.N; i++) this.slots[i] = d.slots[i];
    for (const sl of o.slots ?? []) {
      const i = d.index.get(sl.id);
      if (i == null) continue;
      this.slots[i] = sl;
      const key = ioKey(sl);
      this.kind[i] = key === "spare" ? SPARE : KIND_KEYS.indexOf(key);
      this.status[i] = sl.status === "Field" ? ST_FIELD : sl.status === "Wired Spare" ? ST_WIRED : sl.status === "Cabinet Alarm" ? ST_ALARM : ST_SPARE;
    }
    const wiredChanged = this.status.some((v, i) => (v === ST_WIRED) !== (this.wsPos[i] >= 0));
    if (wiredChanged) this.buildHatch(L);
    const fill = (ids: string[] | undefined, pos: Int32Array, im: THREE.InstancedMesh, colour?: (i: number) => THREE.Color) => {
      pos.fill(-1);
      let n = 0;
      for (const id of ids ?? []) {
        const i = d.index.get(id);
        if (i == null || pos[i] >= 0 || n >= OVERLAY_MAX) continue;
        pos[i] = n;
        if (colour) im.setColorAt(n, colour(i));
        n++;
      }
      im.count = n;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    };
    fill(o.outline, this.outPos, this.outline);
    fill(o.ghosts, this.ghostPos, this.ghosts, (i) => {
      const k = d.kind[i];
      return k >= 0 ? IOC[k].clone().multiplyScalar(0.9 * IOGAIN[k]) : new THREE.Color(0x2a3242);
    });
    this.relayAll();
    this.colourDirty = true;
  }

  /** Previous / next sibling at the current level (←/→): cabinet, CIOC, baseplate or CHARM. */
  sibling(dir: 1 | -1) {
    const L = this.L, d = this.data;
    if (!L || !d || this.diving) return;
    const s = this.sel;
    if (s.level == 0) return void this.goTo(1, { cab: dir > 0 ? 0 : L.n - 1 });
    if (s.level == 1) {
      const c = s.c + dir;
      if (c >= 0 && c < L.n) void this.goTo(1, { cab: c });
      return;
    }
    if (s.level == 2) {
      for (let k = s.k + dir; k >= 0 && k < L.K; k += dir) if (d.cabinets[s.c].ciocs[k]) return void this.goTo(2, { cioc: k + 1 });
      return;
    }
    if (s.level == 3) {
      const b = s.b + dir;
      if (b >= 0 && b < L.B) void this.goTo(3, { bp: b + 1 });
      return;
    }
    for (let m = s.m + dir; m >= 0 && m < L.M; m += dir)
      if (this.kind[idxOf(L, s.c, s.k, s.b, m)] !== NONE) return void this.goTo(4, { ch: m + 1 });
  }

  /** F: turn to the other face. Room / cabinet: the camera orbits 180°; inside a CIOC it moves to the CIOC behind it. */
  flip() {
    const L = this.L, d = this.data;
    if (!L || !d || this.diving) return;
    const s = this.sel;
    if (s.level <= 1) {
      this.face ^= 1;
      this.lastInput = this.el;
      this.focus(!this.opts.calm?.());
      return this.emitLevel();
    }
    const opp = s.k < L.perSide ? s.k + L.perSide : s.k - L.perSide;
    if (opp >= 0 && opp < L.K && d.cabinets[s.c].ciocs[opp]) void this.goTo(s.level, { cioc: opp + 1 });
    else {
      this.face = isRear(L, s.k) ? 0 : 1;
      void this.goTo(1);
    }
  }

  /** Bloom on / off (the FPS fallback switches it off before giving up on 3D). */
  setBloom(on: boolean) {
    this.bloom.enabled = on;
  }

  /** Dolly the camera in (k > 0) or out (k < 0) by a fraction of the current distance (HUD zoom ±). */
  zoom(k: number) {
    this.lastInput = this.el;
    void this.ctrl.dolly(this.ctrl.distance * k, true);
  }

  // ───────────── motion moments (§10.7) ─────────────
  // One moment runs at a time. Each is a pure function of its progress p: the engine plays it on its own clock (any key or
  // click skips to the end), or a page drives it with seek(p) from the sequence that also ticks its HTML (Proof, Revisions,
  // Room). Calm mode turns flights into cuts and ripples / flights into fades.

  /** The running moment (Playwright waits for it before seeking), or null. */
  get momentName(): MomentName | null {
    return this.moment?.name ?? null;
  }

  /** Freeze the running moment at p ∈ [0, 1]; p = 1 ends it (its end state stays). */
  seek(p: number) {
    const m = this.moment;
    if (!m) return;
    m.held = true;
    m.p = Math.min(1, Math.max(0, p));
    m.apply(m.p);
    this.colourDirty = true;
    if (m.p >= 1) this.endMoment();
  }

  /** Jump the running moment to its end state. */
  skipMoment() {
    this.endMoment();
  }

  /**
   * Verify scan: a cyan light curtain sweeps the room left → right; every CHARM it crosses flashes green — red where the
   * verifier failed it — and keeps a faint tint behind the beam until the certificate stamps. Windows match the Proof
   * sequence (beam 0.04–0.62, stamp from 0.64), so Proof drives it with seek(p) and the beam and the check ticks are one motion.
   */
  playVerifyScan(o: MomentOptions & { fails?: string[]; seconds?: number } = {}): Promise<void> {
    const L = this.L, d = this.data;
    if (!L || !d) return Promise.resolve();
    this.prep();
    const calm = !!this.opts.calm?.();
    const fail = new Uint8Array(L.N);
    for (const id of o.fails ?? []) {
      const i = d.index.get(id);
      if (i != null) fail[i] = 1;
    }
    const beam = this.ensureBeam(L);
    let x0 = Infinity, x1 = -Infinity;
    for (const c of L.cab) (x0 = Math.min(x0, c.x)), (x1 = Math.max(x1, c.x));
    x0 -= L.W / 2 + 1;
    x1 += L.W / 2 + 1;
    const room: Sel = { level: 0, c: -1, k: -1, b: -1, m: -1 };
    const fl = o.follow !== false && this.sel.level !== 0 ? this.flightOrCut(room, 0.1, calm) : null;
    let bx = x0, on = 0, trail = 0, wash = 0, P = 0;
    const { kind, cx } = this;
    return this.begin("scan", calm ? 0.6 : (o.seconds ?? 2.2), !!o.drive, {
      apply: (p) => {
        P = p;
        if (fl) this.fly(fl, easeInOut(span(p, 0, 0.1)));
        bx = x0 + (x1 - x0) * span(p, 0.04, 0.62);
        on = span(p, 0.02, 0.07) * (1 - span(p, 0.6, 0.66));
        trail = 1 - span(p, 0.64, 0.92);
        wash = Math.sin(Math.PI * span(p, 0.04, 0.7));
        beam.set(bx, calm ? 0 : on);
      },
      paint: () => {
        for (let i = 0; i < L.N; i++) {
          if (kind[i] === NONE) continue;
          const f = fail[i];
          let amt: number, gain: number;
          if (calm) (amt = wash * (f ? 0.8 : 0.3)), (gain = f ? 2 : 1.6);
          else {
            const dd = (cx[i] - bx) / 0.5, hit = on * Math.exp(-dd * dd);
            const behind = P >= 0.62 || cx[i] < bx ? trail * span(P, 0.04, 0.06) : 0;
            amt = Math.min(1, hit * 0.95 + behind * (f ? 0.8 : 0.22));
            gain = (f ? 2.2 : 1.5) + hit * 1.6;
          }
          if (amt > 0.004) this.mixCol(i, f ? ERR : OK, amt, gain);
        }
      },
      finish: () => beam.set(0, 0),
    });
  }

  /**
   * Tamper caught: the camera flies to the first failing slot; every failing CHARM flashes red ×3 inside a red frame while
   * rings ripple out. The frames stay after the moment (cleared by the next one).
   */
  playTamper(ids: string[], o: MomentOptions = {}): Promise<void> {
    const L = this.L, d = this.data;
    const idx = ids.map((id) => d?.index.get(id)).filter((i): i is number => i != null).slice(0, MARKS_MAX);
    if (!L || !d || !idx.length) return Promise.resolve();
    this.prep();
    const calm = !!this.opts.calm?.();
    const { c, k, b, m } = decode(L, idx[0]);
    const fl = o.follow !== false ? this.flightOrCut({ level: 4, c, k, b, m }, 0.18, calm) : null;
    const F0 = fl && !calm ? 0.46 : 0;
    let u = 0, fa = 0;
    return this.begin("tamper", calm ? 0.7 : fl ? 3.4 : 2, !!o.drive, {
      apply: (p) => {
        if (fl) this.fly(fl, easeInOut(span(p, 0, 0.48)));
        u = span(p, F0, 1);
        fa = span(p, F0, F0 + 0.08);
        idx.forEach((i, j) => {
          if (calm) return this.mark(j, i, ERR, 1.5 * fa);
          const q = Math.min(2.999, u * 3), lo = q % 1, q2 = (q + 0.5) % 1;
          this.mark(j, i, ERR, 1.6 * fa, 0.08 + 0.3 * easeOut3(lo), u < 1 ? Math.pow(1 - lo, 1.5) * fa * 1.6 : 0, 0.08 + 0.3 * easeOut3(q2), u > 0.17 && u < 0.83 ? Math.pow(1 - q2, 1.5) * 1.1 : 0);
        });
        this.marks.count = idx.length;
        this.rings.count = idx.length * 2;
      },
      paint: () => {
        const pulse = calm ? fa : 0.5 - 0.5 * Math.cos(u * Math.PI * 6);
        for (const i of idx) this.mixCol(i, ERR, Math.max(0.4 * fa, pulse * fa), 2.4);
      },
      finish: () => this.keepMarks(idx.map((i) => ({ i, c: ERR, a: 2.2 }))),
    });
  }

  /**
   * Workbench move (§10.7 motion 4, §10.8): the camera frames both ends (follow), each CHARM lifts off its old slot and flies
   * an arc with a light trail behind it (pairs of a cable fly together), the old slot keeps a ghost of it, the new slot
   * lights up as it lands. The slots themselves already hold the new state (Before | Now overlay) — the moment only draws.
   */
  animateMove(from: string[], to: string[], o: MomentOptions = {}): Promise<void> {
    const L = this.L, d = this.data;
    if (!L || !d) return Promise.resolve();
    const pairs: [number, number][] = [];
    for (let j = 0; j < Math.min(from.length, to.length, OVERLAY_MAX); j++) {
      const a = d.index.get(from[j]), b = d.index.get(to[j]);
      if (a != null && b != null && a !== b) pairs.push([a, b]);
    }
    if (!pairs.length) return Promise.resolve();
    this.prep();
    const calm = !!this.opts.calm?.();
    let fl: Flight | null = null;
    if (o.follow !== false) {
      // frame both ends: the baseplate / CIOC / cabinet they share, else the destination's cabinet
      const A = decode(L, pairs[0][0]), B = decode(L, pairs[0][1]);
      const lv: Level = A.c !== B.c ? 1 : A.k !== B.k ? 1 : A.b !== B.b ? 2 : 3;
      const tgt: Sel = { level: lv, c: B.c, k: lv >= 2 ? B.k : -1, b: lv >= 3 ? B.b : -1, m: -1 };
      const s = this.sel;
      const inView = s.level === lv && s.c === tgt.c && s.k === tgt.k && s.b === tgt.b;
      if (lv === 1) this.face = isRear(L, B.k) ? 1 : 0;
      if (!inView) fl = this.flightOrCut(tgt, 0.08, calm);
    }
    const fx = this.flightsFx(pairs, fl && !calm ? 0.3 : 0.04, 0.84, calm);
    return this.begin("move", calm ? 0.6 : fl ? 3 : 2.2, !!o.drive, {
      apply: (p) => {
        if (fl) this.fly(fl, easeInOut(span(p, 0, 0.3)));
        fx.apply(p);
      },
      paint: (p) => fx.paint(p),
      finish: () => fx.finish(),
    });
  }

  /** Arc flights a → b inside [T0, T1] (shared by moves and the Rev B diff): flyers, trails, ghost at a, glow at b. */
  private flightsFx(pairs: [number, number][], T0: number, T1: number, calm: boolean) {
    const L = this.L!, d = this.data!, n = pairs.length;
    const stg = n > 1 ? Math.min(0.03, ((T1 - T0) * 0.35) / (n - 1)) : 0;
    const len = T1 - T0 - stg * (n - 1);
    const win = pairs.map((_, j) => [T0 + j * stg, T0 + j * stg + len] as const);
    const kOf = (a: number, b: number) => (this.kind[b] >= 0 ? this.kind[b] : d.kind[a]);
    const look = pairs.map(([a, b]) => {
      const k = kOf(a, b);
      return k >= 0 ? IOC[k].clone().multiplyScalar(1.5 * IOGAIN[k]) : DARK.clone();
    });
    let curves: ArcCurve[] | null = null;
    const fa = this.flyers;
    pairs.forEach(([a, b], j) => fa.setColorAt(j, look[j].clone().multiplyScalar(1.1 + (kOf(a, b) >= 0 ? 0 : 3))));
    fa.instanceColor!.needsUpdate = true;
    const P = new THREE.Vector3();
    const us = new Array<number>(n).fill(0);
    return {
      apply: (p: number) => {
        pairs.forEach((_, j) => (us[j] = span(p, win[j][0], win[j][1])));
        if (calm) return;
        // built once the camera has landed: the baseplate spread (and so the CHARM positions) is final by then
        if (!curves && p >= T0) {
          curves = pairs.map(([a, b]) => {
            const p0 = this.charmPos(a), p1 = this.charmPos(b), dist = p0.distanceTo(p1);
            return new ArcCurve(p0, p1, Math.min(1.2, 0.16 + dist * 0.25), isRear(L, decode(L, b).k) ? -1 : 1);
          });
          this.arcs?.dispose();
          this.arcs = buildArcTrails(curves, look.map((c) => c.clone().lerp(LIVE, 0.35)));
          this.dyn.add(this.arcs.group);
        }
        if (!curves) return;
        const arr = fa.instanceMatrix.array as Float32Array;
        let shown = 0;
        curves.forEach((cv, j) => {
          const u = us[j], live = p >= win[j][0] - 0.01 && u < 1, e = easeInOut(u);
          cv.getPoint(e, P);
          writeT(arr, j, P.x, P.y, P.z, live);
          if (live) for (const o of [0, 5, 10]) arr[j * 16 + o] = 1 + 0.9 * Math.sin(Math.PI * e); // swells mid-air: readable at cabinet scale
          if (live) shown++;
        });
        fa.count = n;
        fa.instanceMatrix.needsUpdate = true;
        if (!shown && p >= T1) fa.count = 0;
        this.arcs?.set(us.map(easeInOut), span(p, T0, T0 + 0.04) * (1 - span(p, T1, Math.min(1, T1 + 0.14))));
      },
      paint: (p: number) => {
        pairs.forEach(([a, b], j) => {
          const u = us[j];
          // the old slot: the signal still sits there until it lifts off, then a ghost of it stays
          if (calm) this.mixCol(a, look[j], 0.3 * (1 - span(p, 0.6, 1)), 1);
          else if (u <= 0) this.setCol(a, look[j]);
          else this.mixCol(a, look[j], 0.3, 0.8);
          // the new slot: empty until the CHARM lands, then a cyan flare that settles into its own colour
          const land = win[j][1];
          if (!calm && u < 1) this.setCol(b, DARK);
          else {
            const g = calm ? 0.6 * Math.sin(Math.PI * span(p, 0, 1)) : Math.exp(-(p - land) / 0.07);
            this.mixCol(b, LIVE, 0.75 * g, 2.6);
          }
        });
      },
      finish: () => {
        fa.count = 0;
        if (this.arcs) {
          this.dyn.remove(this.arcs.group);
          this.arcs.dispose();
          this.arcs = null;
        }
      },
    };
  }

  /**
   * Refused move: the camera flies to the target baseplate; the target slot shakes left-right inside a red frame and a red
   * ring, then settles. Nothing changed, so nothing stays behind.
   */
  playRefuse(slotId: string, o: MomentOptions = {}): Promise<void> {
    const L = this.L, i = this.data?.index.get(slotId);
    if (!L || i == null) return Promise.resolve();
    this.prep();
    const calm = !!this.opts.calm?.();
    const a = decode(L, i), s = this.sel;
    const inView = s.c === a.c && s.k === a.k && s.b === a.b && s.level >= 3;
    const fl = o.follow !== false && !inView ? this.flightOrCut({ level: 3, c: a.c, k: a.k, b: a.b, m: -1 }, 0.1, calm) : null;
    const S0 = fl && !calm ? 0.4 : 0.04;
    let env = 0;
    return this.begin("refuse", calm ? 0.6 : fl ? 2.4 : 1.4, !!o.drive, {
      apply: (p) => {
        if (fl) this.fly(fl, easeInOut(span(p, 0, 0.4)));
        const u = span(p, S0, S0 + 0.42);
        env = span(p, S0, S0 + 0.05) * (1 - span(p, 0.86, 1));
        this.nudge(i, calm || u >= 1 ? 0 : Math.sin(u * Math.PI * 10) * 0.024 * Math.pow(1 - u, 1.2));
        const r = span(p, S0, S0 + 0.3);
        this.mark(0, i, ERR, 1.6 * env, 0.08 + 0.28 * easeOut3(r), calm ? 0 : (1 - r) * 1.4 * env);
        this.marks.count = 1;
        this.rings.count = 2;
      },
      paint: () => this.mixCol(i, ERR, 0.65 * env, 2.2),
      finish: () => {
        this.nudge(i, 0);
        this.clearMarks();
      },
    });
  }

  /**
   * Rev B diff (§10.7 motion 5): unchanged CHARMs dim; removed ones flare red and dissolve into their new look; changed
   * ones pulse amber twice and flip to the new hardware; new ones fade in cyan; moved ones fly an arc from the old slot.
   * The changed slots keep a frame in their kind's colour at the end. Revision Center / Room drive it with seek(p).
   */
  playRevDiff(diff: RevDiff3D, o: MomentOptions = {}): Promise<void> {
    const L = this.L, d = this.data;
    if (!L || !d) return Promise.resolve();
    this.prep();
    const calm = !!this.opts.calm?.();
    const at = (id: string) => d.index.get(id);
    const items: { i: number; kind: "added" | "removed" | "changed"; old: THREE.Color; w: [number, number] }[] = [];
    const mask = new Uint8Array(L.N);
    const W = { removed: [0.1, 0.4], changed: [0.3, 0.6], added: [0.45, 0.75] } as const;
    const push = (id: string, kind: "added" | "removed" | "changed", io: IoKey) => {
      const i = at(id);
      if (i == null || mask[i]) return;
      mask[i] = 1;
      items.push({ i, kind, old: this.lookOf(io), w: [...W[kind]] });
    };
    diff.removed.forEach((r) => push(r.id, "removed", r.io));
    diff.changed.forEach((r) => push(r.id, "changed", r.io));
    diff.added.forEach((id) => push(id, "added", "spare"));
    const pairs: [number, number][] = [];
    for (const mv of diff.moved) {
      const a = at(mv.from), b = at(mv.to);
      if (a == null || b == null || a === b) continue;
      mask[a] = mask[b] = 1;
      pairs.push([a, b]);
    }
    const flights = pairs.length ? this.flightsFx(pairs, 0.52, 0.92, calm) : null;
    // camera: the one cabinet that changed (its busier face), else the whole room
    let fl: Flight | null = null;
    if (o.follow !== false) {
      const all = [...items.map((x) => x.i), ...pairs.flat()];
      const cabs = new Set(all.map((i) => decode(L, i).c));
      const tgt: Sel = cabs.size === 1 ? { level: 1, c: [...cabs][0], k: -1, b: -1, m: -1 } : { level: 0, c: -1, k: -1, b: -1, m: -1 };
      if (cabs.size === 1) {
        const rear = all.filter((i) => isRear(L, decode(L, i).k)).length;
        this.face = rear * 2 > all.length ? 1 : 0;
      }
      const s = this.sel;
      if (all.length && (s.level !== tgt.level || s.c !== tgt.c)) fl = this.flightOrCut(tgt, 0.1, calm);
      else if (all.length && tgt.level <= 1) this.focus(!calm);
    }
    const marks = [
      ...items.map((x) => ({ i: x.i, c: x.kind === "added" ? LIVE : x.kind === "removed" ? ERR : WARN, w: x.w })),
      ...pairs.map(([, b]) => ({ i: b, c: BRAND, w: [0.52, 0.92] as [number, number] })),
    ].slice(0, MARKS_MAX);
    let dim = 1, P = 0;
    const { kind } = this;
    return this.begin("revdiff", calm ? 0.8 : 3.4, !!o.drive, {
      apply: (p) => {
        P = p;
        if (fl) this.fly(fl, easeInOut(span(p, 0, 0.1)));
        dim = 1 - 0.7 * span(p, 0.02, 0.1) * (1 - span(p, 0.92, 1));
        flights?.apply(p);
        marks.forEach((x, j) => {
          const a = span(p, x.w[0], x.w[0] + 0.06), r = span(p, x.w[1] - 0.04, x.w[1] + 0.12);
          this.mark(j, x.i, x.c, 1.1 * a, 0.08 + 0.26 * easeOut3(r), calm || r <= 0 || r >= 1 ? 0 : (1 - r) * 1.3);
        });
        this.marks.count = marks.length;
        this.rings.count = marks.length * 2;
      },
      paint: () => {
        if (dim < 0.999) for (let i = 0; i < L.N; i++) if (kind[i] !== NONE && !mask[i]) this.scaleCol(i, dim);
        for (const x of items) {
          const u = span(P, x.w[0], x.w[1]);
          if (x.kind === "removed") {
            const q1 = span(u, 0, 0.45), q2 = span(u, 0.45, 1);
            const shimmer = q2 > 0 && q2 < 1 ? 0.65 + 0.35 * Math.sin(u * 46 + x.i) : 1;
            this.blendCol(x.i, x.old, 1 - q2, ERR, q1 * (1 - q2) * 0.9, 2.4, shimmer);
          } else if (x.kind === "changed") {
            const pulse = 0.5 - 0.5 * Math.cos(u * Math.PI * 4);
            this.blendCol(x.i, x.old, u < 0.5 ? 1 : 0, WARN, pulse * 0.85, 2.3);
          } else {
            const q1 = span(u, 0, 0.5), q2 = span(u, 0.5, 1);
            this.blendCol(x.i, DARK, 1 - q1, LIVE, q1 * (1 - q2), 2.6);
          }
        }
        flights?.paint(P);
      },
      finish: () => {
        flights?.finish();
        this.keepMarks(marks.map((x) => ({ i: x.i, c: x.c, a: 0.9 })));
      },
    });
  }

  playTour(): Promise<void> {
    return Promise.resolve(); // §10.7 motion 6 — not built yet
  }

  /**
   * Upload Dive: a DiveScript (keyframes + effect curves, see dive.ts) played as a seekable moment. Fly in (the wide FOV
   * settles), cabinets light up left → right, trails stream from the junction box to the baseplates that received cables
   * (allocation order), the camera sweeps the row, pushes through and lands at L1 of the first cabinet. Any key or click skips.
   */
  async playDive(script: DiveScript = DIVE): Promise<void> {
    const L = this.L;
    if (!L || this.diving) return;
    this.prep();
    this.diving = true;
    const calm = !!this.opts.calm?.();
    const room: Sel = { level: 0, c: -1, k: -1, b: -1, m: -1 };
    const land: Sel = { level: 1, c: 0, k: -1, b: -1, m: -1 };
    this.face = 0;
    this.setSel(room, false, false);
    const trails = calm ? null : this.ensureTrails();
    // the spline: the script's poses + the landing pose (probed, not flown to)
    const keys = script.keys(L);
    const end = this.probe(land);
    const at = [...keys.map((k) => k.at), 1];
    const pos = new THREE.CatmullRomCurve3([...keys.map((k) => new THREE.Vector3(...k.pos)), end.p], false, "centripetal");
    const tgt = new THREE.CatmullRomCurve3([...keys.map((k) => new THREE.Vector3(...k.target)), end.t], false, "centripetal");
    const P = new THREE.Vector3(), T = new THREE.Vector3();
    let landed = false;
    if (trails) trails.group.visible = true;
    await this.begin("dive", calm ? 0.35 : script.dur, false, {
      apply: (p) => {
        if (calm) {
          if (!landed) (landed = true), this.setSel(land, false);
          return;
        }
        // time → spline parameter: piecewise linear through the keys, eased out on the last segment
        let j = 0;
        while (j < at.length - 2 && p >= at[j + 1]) j++;
        let lo = span(p, at[j], at[j + 1]);
        if (j === at.length - 2) lo = Math.sin((lo * Math.PI) / 2);
        const u = (j + lo) / (at.length - 1);
        pos.getPoint(u, P);
        tgt.getPoint(u, T);
        this.ctrl.setLookAt(P.x, P.y, P.z, T.x, T.y, T.z, false);
        this.cam.fov = this.fovT = script.fov(p);
        this.cam.updateProjectionMatrix();
        if (p >= script.land && !landed) {
          landed = true;
          this.assignRigs([0]);
          this.setSel(land, false, false);
          this.captureFades();
        } else if (p < script.land && landed) {
          landed = false; // seeking back before the landing
          this.fade = null;
          this.setSel(room, false, false);
        }
        if (landed) this.driveFades(easeInOut(span(p, script.land, 1)));
        this.trailA = this.trailT = script.trail(p);
        this.trailClock = script.clock(p);
        this.cabs.forEach((cb, c) => (cb.glow = cb.gt = script.glow(p, c, L.n)));
      },
      finish: () => {
        this.diving = false;
        this.cam.fov = this.fovT = 40;
        this.cam.updateProjectionMatrix();
        this.trailA = this.trailT = 0;
        if (this.trails) this.trails.group.visible = false;
        this.cabs.forEach((cb) => (cb.glow = cb.gt = 0));
        if (!landed || this.sel.level !== 1) this.setSel(land, false);
        else this.retarget(); // labels hidden while diving come back
      },
      skipKeys: true,
    });
  }

  get isDiving() {
    return this.diving;
  }

  skipDive() {
    if (this.moment?.name === "dive") this.endMoment();
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.css.setSize(w, h);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.endMoment();
    const cv = this.renderer.domElement;
    cv.removeEventListener("pointerdown", this.onDown);
    cv.removeEventListener("pointerup", this.onUp);
    cv.removeEventListener("pointermove", this.onMove);
    cv.removeEventListener("pointerleave", this.onLeave);
    this.ctrl.dispose();
    this.clearDyn();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
    this.envTex.dispose();
    this.pm.dispose();
    this.rt.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    cv.remove();
    this.css.domElement.remove();
    this.listeners.clear();
  }

  // ───────────── build ─────────────

  private std(p: THREE.MeshStandardMaterialParameters) {
    const m = new THREE.MeshStandardMaterial(p);
    m.envMapIntensity = 0.35; // IBL strength: keeps the room dark but gives steel a sheen
    return m;
  }

  private makeGrid(size: number) {
    const g = new THREE.GridHelper(size, size, ACC, 0x1b2231);
    g.position.y = 0.003;
    const mat = g.material as THREE.Material;
    mat.transparent = true;
    mat.opacity = 0.55;
    this.scene.add(g);
    return g;
  }

  private layoutRoom(L: Layout) {
    const r = L.room;
    this.floor.scale.set(r.floor, r.floor, 1);
    this.floor.position.set(0, 0, r.cz);
    if (this.grid.userData.size !== r.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = this.makeGrid(r.grid);
      this.grid.userData.size = r.grid;
    }
    this.grid.position.z = r.cz;
    this.wall.scale.set(Math.max(60, r.w * 2.5), 20, 1);
    this.wall.position.set(0, 10, r.wallZ);
    this.jb.position.set(...L.jb);
    const conduit = this.jb.getObjectByName("conduit")!;
    conduit.scale.y = L.jb[1] - 0.5;
    conduit.position.set(0, -0.5 - (L.jb[1] - 0.5) / 2, -0.06);
    this.jbLight.position.set(L.jb[0], L.jb[1], L.jb[2] + 0.6);
    (this.scene.fog as THREE.FogExp2).density = r.fog;
    this.cam.far = 200 * r.scale;
    this.cam.updateProjectionMatrix();
    this.ctrl.maxDistance = 60 * r.scale;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, L.n > 24 ? 1.5 : 2));
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.w, this.h);
  }

  private clearDyn() {
    this.dyn.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
        (x as THREE.MeshBasicMaterial).map?.dispose();
        x.dispose();
      });
      if (o instanceof CSS2DObject) o.element.remove();
    });
    this.dyn.clear();
    this.trails?.dispose();
    this.trails = null;
    this.beam?.dispose();
    this.beam = null;
    this.arcs?.dispose();
    this.arcs = null;
    this.reg = [];
    this.rigs = [];
    this.cabLabels = [];
    this.cableLabels = [];
    this.chLabels = [];
  }

  /** CHARMS: every module in ONE InstancedMesh (+ one hatched mesh for wired spares); colour carries IO type + fade. */
  private buildCharms(L: Layout) {
    const geo = new THREE.BoxGeometry(L.charm.w, L.charm.h, L.charm.d);
    this.charms = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false }), L.N);
    this.charms.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(L.N * 3), 3);
    this.charms.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.charms.frustumCulled = false;
    this.dyn.add(this.charms);
    this.tgt = new Float32Array(L.N).fill(1);
    this.cur = new Float32Array(L.N).fill(1);
    this.dim = new Uint8Array(L.N);
    this.pulseMask = new Uint8Array(L.N);
    this.outPos = new Int32Array(L.N).fill(-1);
    this.ghostPos = new Int32Array(L.N).fill(-1);
    this.buildHatch(L);
  }

  /** The wired-spare mesh is sized to the current wired spares; rebuilt when Before | Now changes which slots are wired. */
  private buildHatch(L: Layout) {
    if (this.hatch) {
      this.dyn.remove(this.hatch);
      this.hatch.dispose();
      (this.hatch.material as THREE.MeshBasicMaterial).map?.dispose();
      (this.hatch.material as THREE.Material).dispose();
    }
    this.wsPos = new Int32Array(L.N).fill(-1);
    const ws: number[] = [];
    for (let i = 0; i < L.N; i++) if (this.status[i] === ST_WIRED) (this.wsPos[i] = ws.length), ws.push(i);
    this.wsIdx = Int32Array.from(ws);
    const n = Math.max(1, ws.length);
    this.hatch = new THREE.InstancedMesh(this.charms.geometry, new THREE.MeshBasicMaterial({ toneMapped: false, map: hatchTexture() }), n);
    this.hatch.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.hatch.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.hatch.frustumCulled = false;
    if (!ws.length) this.hatch.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0));
    this.dyn.add(this.hatch);
  }

  /** Outline frames (changed CHARMs), ghosts (where a moved CHARM was), flyers (animateMove), the hover box, L3 tags. */
  private buildOverlays(L: Layout) {
    const { w, h, d } = L.charm;
    this.outline = new THREE.InstancedMesh(frameGeometry(w + 0.014, h + 0.014, d + 0.014, 0.0055), new THREE.MeshBasicMaterial({ color: CHANGED, toneMapped: false, transparent: true, opacity: 0.95 }), OVERLAY_MAX);
    this.ghosts = new THREE.InstancedMesh(this.charms.geometry, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.28, depthWrite: false }), OVERLAY_MAX);
    this.ghosts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(OVERLAY_MAX * 3), 3);
    this.flyers = new THREE.InstancedMesh(this.charms.geometry, new THREE.MeshBasicMaterial({ toneMapped: false }), OVERLAY_MAX);
    this.flyers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(OVERLAY_MAX * 3), 3);
    this.marks = new THREE.InstancedMesh(frameGeometry(w + 0.03, h + 0.03, d + 0.03, 0.009), new THREE.MeshBasicMaterial({ toneMapped: false }), MARKS_MAX);
    this.marks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MARKS_MAX * 3), 3);
    this.rings = new THREE.InstancedMesh(
      ringGeometry(),
      new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }),
      MARKS_MAX * 2,
    );
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MARKS_MAX * 2 * 3), 3);
    this.markIdx = [];
    for (const im of [this.outline, this.ghosts, this.flyers, this.marks, this.rings]) {
      im.count = 0;
      im.frustumCulled = false;
      im.raycast = nop;
      this.dyn.add(im);
    }
    this.hoverGeo.forEach((g) => g.dispose());
    this.hoverGeo.clear();
    this.hoverBox = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ color: HOVER, toneMapped: false, transparent: true, opacity: 0.9, depthTest: false }));
    this.hoverBox.renderOrder = 10;
    this.hoverBox.visible = false;
    this.hoverBox.raycast = nop;
    this.dyn.add(this.hoverBox);
    this.chLabels = Array.from({ length: L.M }, () => {
      const lb = new CSS2DObject(labelEl(TAG_LABEL, ""));
      lb.visible = false;
      this.dyn.add(lb);
      return lb;
    });
  }

  /** World position of CHARM i at its CIOC's current spread (rigged cabinets explode; the rest are packed). */
  private charmPos(i: number, out = new THREE.Vector3()) {
    const L = this.L!, { c, k, b, m } = decode(L, i), cab = L.cab[c];
    const s = this.rigs.find((r) => r.c === c)?.iocs[k].s ?? 0;
    return out.set(cab.x + ixOf(L, k) + chX(L, m), bpY(L, s, b) + 0.13, cab.z + zOf(L, k));
  }

  /** Write the CHARM matrices of one CIOC for spread s (prototype updIoc's inner loop). Translation-only matrices. */
  private layCharms(c: number, k: number, s: number) {
    const L = this.L!;
    const cab = L.cab[c];
    const x0 = cab.x + ixOf(L, k), z = cab.z + zOf(L, k);
    const ma = this.charms.instanceMatrix.array as Float32Array;
    const ha = this.hatch.instanceMatrix.array as Float32Array;
    const oa = this.outline.instanceMatrix.array as Float32Array;
    const ga = this.ghosts.instanceMatrix.array as Float32Array;
    let ov = false;
    for (let b = 0; b < L.B; b++) {
      const y = bpY(L, s, b) + 0.13;
      for (let m = 0; m < L.M; m++) {
        const i = idxOf(L, c, k, b, m);
        const kind = this.kind[i];
        const wp = this.wsPos[i];
        const x = x0 + chX(L, m);
        writeT(ma, i, x, y, z, kind !== NONE && wp < 0);
        if (wp >= 0) writeT(ha, wp, x, y, z, true);
        if (this.outPos[i] >= 0) (writeT(oa, this.outPos[i], x, y, z, true), (ov = true));
        // the ghost floats just proud of the cabinet face, so it never z-fights the (now spare) CHARM under it
        if (this.ghostPos[i] >= 0) (writeT(ga, this.ghostPos[i], x, y, z + (isRear(L, k) ? -1 : 1) * L.charm.d * 0.55, true), (ov = true));
      }
    }
    this.charms.instanceMatrix.needsUpdate = true;
    this.hatch.instanceMatrix.needsUpdate = true;
    if (ov) this.outline.instanceMatrix.needsUpdate = this.ghosts.instanceMatrix.needsUpdate = true;
  }

  /** Re-lay every CHARM at its CIOC's current spread (after Before | Now changed kinds, outlines or ghosts). */
  private relayAll() {
    const L = this.L!;
    for (let c = 0; c < L.n; c++) {
      const rig = this.rigs.find((r) => r.c === c);
      for (let k = 0; k < L.K; k++) this.layCharms(c, k, rig ? rig.iocs[k].s : 0);
    }
  }

  /** Far cabinets: an instanced shell (one draw call per part) + merged frame/door edges. */
  private buildFar(L: Layout) {
    const hw = L.W / 2 - 0.05, hd = L.D / 2;
    const box = (w: number, h: number, dd: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, dd).translate(x, y, z);
    const steelParts: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) steelParts.push(box(0.1, 3.3, 0.1, sx * hw, 1.65, sz * hd));
    for (const sz of [-1, 1]) steelParts.push(box(L.W, 0.08, 0.08, 0, 3.3, sz * hd));
    for (const sx of [-1, 1]) steelParts.push(box(0.08, 0.08, L.D, sx * hw, 3.3, 0));
    steelParts.push(box(L.W, 0.1, L.D + 0.1, 0, 0.05, 0));
    const panelParts = [-1, 1].map((sx) => box(0.03, 3.2, L.D, sx * hw, 1.6, 0));
    const leafW = hw - 0.04;
    const glassParts: THREE.BufferGeometry[] = [];
    for (const face of [1, -1]) for (const side of [-1, 1]) glassParts.push(box(leafW, 3.2, 0.03, side * hw - (side * leafW) / 2, 1.65, face * hd));
    const mk = (parts: THREE.BufferGeometry[], mat: THREE.Material, count: number) => {
      const g = mergeGeometries(parts)!;
      parts.forEach((p) => p.dispose());
      const im = new THREE.InstancedMesh(g, mat, count);
      im.frustumCulled = false;
      this.dyn.add(im);
      return im;
    };
    const steelMat = this.std({ color: 0x4d5666, metalness: 0.7, roughness: 0.45, transparent: true });
    const panelMat = this.std({ color: 0x232a37, metalness: 0.5, roughness: 0.6, transparent: true });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x9fb4d0, roughness: 0.36, specularIntensity: 0.1, depthWrite: false, transparent: true, opacity: 0.16 });
    glassMat.envMapIntensity = 0.35;
    const bpMat = this.std({ color: 0x2c3442, metalness: 0.6, roughness: 0.5, transparent: true });
    const steel = mk(steelParts, steelMat, L.n);
    const panel = mk(panelParts, panelMat, L.n);
    const glass = mk(glassParts, glassMat, L.n);
    const bps = new THREE.InstancedMesh(new THREE.BoxGeometry(L.bpW, 0.12, 0.3), bpMat, L.n * L.K * L.B);
    bps.frustumCulled = false;
    this.dyn.add(bps);
    // soft accent light pool drawn on the floor under each cabinet
    const poolGeo = new THREE.PlaneGeometry(6.5 * (L.W / 3.1), 4.2).rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(poolGeo, poolMaterial(), L.n);
    pools.frustumCulled = false;
    this.dyn.add(pools);
    const pick = new THREE.InstancedMesh(new THREE.BoxGeometry(L.W, L.H, L.D), new THREE.MeshBasicMaterial(), L.n);
    pick.visible = false; // raycast-only (Raycaster ignores visibility, as the prototype's pick volumes rely on)
    this.dyn.add(pick);
    const m4 = new THREE.Matrix4();
    for (let c = 0; c < L.n; c++) {
      const p = L.cab[c];
      m4.makeTranslation(p.x, 0, p.z);
      steel.setMatrixAt(c, m4);
      panel.setMatrixAt(c, m4);
      glass.setMatrixAt(c, m4);
      m4.makeTranslation(p.x, 0.012, p.z);
      pools.setMatrixAt(c, m4);
      m4.makeTranslation(p.x, L.H / 2, p.z);
      pick.setMatrixAt(c, m4);
    }
    pick.computeBoundingSphere();
    const frames = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: ACC, transparent: true, opacity: 0.4 }));
    const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: ACC, transparent: true, opacity: 0.85 }));
    frames.raycast = edges.raycast = nop;
    frames.frustumCulled = edges.frustumCulled = false;
    this.dyn.add(frames, edges);
    this.far = {
      steel, panel, glass, bps, pools, pick, frames, edges, cur: 1, t: 1,
      mats: [
        { m: steelMat, base: 1 }, { m: panelMat, base: 1 }, { m: glassMat, base: 0.16 }, { m: bpMat, base: 1 },
        { m: frames.material as THREE.Material, base: 0.4 }, { m: edges.material as THREE.Material, base: 0.85 },
      ],
    };
  }

  /** Show every cabinet in the far shell except the ones a rig is drawing; rebuild the merged edges to match. */
  private syncFar() {
    const L = this.L!, d = this.data!, f = this.far;
    const rigged = new Set(this.rigs.map((r) => r.c));
    const m4 = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const framePts: number[] = [], edgePts: number[] = [];
    const frameE = edgePositions(new THREE.BoxGeometry(1.42, frameH(L, 0), 0.5));
    const hw = L.W / 2 - 0.05, hd = L.D / 2, leafW = hw - 0.04;
    const leafE = edgePositions(new THREE.BoxGeometry(leafW, 3.2, 0.03));
    for (let c = 0; c < L.n; c++) {
      const p = L.cab[c], hide = rigged.has(c);
      m4.makeTranslation(p.x, 0, p.z);
      for (const im of [f.steel, f.panel, f.glass]) im.setMatrixAt(c, hide ? zero : m4);
      for (let k = 0; k < L.K; k++) {
        const has = !!d.cabinets[c].ciocs[k];
        const x = p.x + ixOf(L, k), z = p.z + zOf(L, k);
        for (let b = 0; b < L.B; b++) f.bps.setMatrixAt((c * L.K + k) * L.B + b, hide || !has ? zero : m4.makeTranslation(x, bpY(L, 0, b), z));
        if (!hide && has) pushShifted(framePts, frameE, x, stackY(L, 0), z);
      }
      if (!hide) for (const face of [1, -1]) for (const side of [-1, 1]) pushShifted(edgePts, leafE, p.x + side * hw - (side * leafW) / 2, 1.65, p.z + face * hd);
    }
    for (const im of [f.steel, f.panel, f.glass, f.bps]) im.instanceMatrix.needsUpdate = true;
    f.frames.geometry.dispose();
    f.frames.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(framePts, 3));
    f.edges.geometry.dispose();
    f.edges.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(edgePts, 3));
  }

  /** The prototype's per-cabinet meshes, built RIGS times and re-assigned to the cabinets in focus. */
  private buildRigs(L: Layout) {
    const hw = L.W / 2 - 0.05, hd = L.D / 2;
    for (let r = 0; r < RIGS; r++) {
      const g = new THREE.Group();
      g.visible = false;
      this.dyn.add(g);
      const rig: Rig = { c: -1, group: g, dp: [], door: { o: 0, t: 0 }, light: new THREE.PointLight(0xaabbff, RIG_LIGHT, 9), iocs: [] };
      const reg1 = <M extends THREE.Material>(m: M, base: number, k: number, b: number, lv: number): M => {
        m.transparent = true;
        m.opacity = base;
        this.reg.push({ m, base, rig, k, b, L: lv, cur: 1, t: 1 });
        return m;
      };
      const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
        const o = new THREE.Mesh(geo, reg1(m, 1, -1, -1, 1));
        o.position.set(x, y, z);
        g.add(o);
        return o;
      };
      const steel = () => this.std({ color: 0x4d5666, metalness: 0.7, roughness: 0.45 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(0.1, 3.3, 0.1), steel(), sx * hw, 1.65, sz * hd);
      for (const sz of [-1, 1]) add(new THREE.BoxGeometry(L.W, 0.08, 0.08), steel(), 0, 3.3, sz * hd);
      for (const sx of [-1, 1]) {
        add(new THREE.BoxGeometry(0.08, 0.08, L.D), steel(), sx * hw, 3.3, 0);
        add(new THREE.BoxGeometry(0.03, 3.2, L.D), this.std({ color: 0x232a37, metalness: 0.5, roughness: 0.6 }), sx * hw, 1.6, 0);
      }
      // plinth: darker than the frame steel — lit from the rig light straight above, it read as a white slab
      add(new THREE.BoxGeometry(L.W, 0.1, L.D + 0.1), this.std({ color: 0x262c37, metalness: 0.6, roughness: 0.6 }), 0, 0.05, 0);
      const leafW = hw - 0.04;
      for (const face of [1, -1])
        for (const side of [-1, 1]) {
          const piv = new THREE.Group();
          piv.position.set(side * hw, 1.65, face * hd);
          g.add(piv);
          const glassM = new THREE.MeshPhysicalMaterial({ color: 0x9fb4d0, roughness: 0.36, specularIntensity: 0.1, depthWrite: false });
          glassM.envMapIntensity = 0.35;
          const gl = new THREE.Mesh(new THREE.BoxGeometry(leafW, 3.2, 0.03), reg1(glassM, 0.16, -1, -1, 1));
          gl.position.x = (-side * leafW) / 2;
          gl.raycast = nop;
          piv.add(gl);
          const ed = new THREE.LineSegments(new THREE.EdgesGeometry(gl.geometry), reg1(new THREE.LineBasicMaterial({ color: ACC }), 0.85, -1, -1, 1));
          ed.raycast = nop;
          gl.add(ed);
          rig.dp.push({ piv, s: face * side });
        }
      rig.light.intensity = 0;
      this.dyn.add(rig.light); // always in the scene: the light count never changes, so shaders never recompile
      for (let k = 0; k < L.K; k++) {
        const ix = ixOf(L, k), z = zOf(L, k);
        const frame = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1.42, 1, 0.5)),
          reg1(new THREE.LineBasicMaterial({ color: ACC }), 0.4, k, -1, 2),
        );
        frame.raycast = nop;
        g.add(frame);
        const vol = new THREE.Mesh(new THREE.BoxGeometry(1.42, 1, 0.5), new THREE.MeshBasicMaterial());
        vol.visible = false;
        vol.userData = { k };
        g.add(vol);
        // A/B family: a ring on the CIOC's outer face — solid = A, dashed = B (§10.1). WebGL lines are 1 px, so the
        // "2 px" ring is two concentric outlines.
        const pts: THREE.Vector3[] = [];
        for (const [hx, hy] of [[0.79, 0.5], [0.805, 0.508]])
          for (const [a, b] of [[[-1, -1], [1, -1]], [[1, -1], [1, 1]], [[1, 1], [-1, 1]], [[-1, 1], [-1, -1]]])
            pts.push(new THREE.Vector3(a[0] * hx, a[1] * hy, 0), new THREE.Vector3(b[0] * hx, b[1] * hy, 0));
        const rect = new THREE.BufferGeometry().setFromPoints(pts);
        const ring = new THREE.LineSegments(rect, reg1(new THREE.LineBasicMaterial({ color: RING }), 0.95, k, -1, 2));
        ring.raycast = nop;
        ring.position.set(ix, 0, z + (isRear(L, k) ? -0.27 : 0.27));
        g.add(ring);
        const bps: THREE.Mesh[] = [];
        const bpLabels: CSS2DObject[] = [];
        for (let b = 0; b < L.B; b++) {
          const bp = new THREE.Mesh(
            new THREE.BoxGeometry(L.bpW, 0.12, 0.3),
            reg1(this.std({ color: 0x2c3442, metalness: 0.6, roughness: 0.5 }), 1, k, b, 3),
          );
          bp.userData = { k, b };
          g.add(bp);
          bps.push(bp);
          const lb = new CSS2DObject(labelEl(LABEL + " font-mono normal-case tracking-[0.04em]", ""));
          lb.position.set(ix + (L.bpW / 2 + 0.42) * (isRear(L, k) ? -1 : 1), bpY(L, 1, b), z);
          lb.visible = false;
          g.add(lb);
          bpLabels.push(lb);
        }
        const label = new CSS2DObject(labelEl(LABEL, ""));
        label.position.set(ix, stackY(L, 0) + frameH(L, 0) / 2 + 0.25, z);
        label.visible = false;
        g.add(label);
        rig.iocs.push({ frame, vol, ring, bps, label, labelOn: false, bpLabels, s: 0, t: 0 });
      }
      this.rigs.push(rig);
    }
  }

  private buildCabLabels(d: World3DData, L: Layout) {
    this.cabLabels = d.cabinets.map((cab, c) => {
      const lb = new CSS2DObject(labelEl(LABEL + " font-mono normal-case tracking-[0.06em]", esc(cab.name)));
      lb.position.set(L.cab[c].x, 3.9, L.cab[c].z);
      this.dyn.add(lb);
      return lb;
    });
  }

  /** Point the rigs at the wanted cabinets (priority order), keeping a rig that already draws one. Neighbours fill the rest. */
  private assignRigs(want: number[]) {
    const L = this.L!;
    const list: number[] = [];
    const pushC = (c: number) => c >= 0 && c < L.n && !list.includes(c) && list.push(c);
    want.forEach(pushC);
    if (want[0] != null) [want[0] - 1, want[0] + 1].forEach(pushC);
    const chosen = list.slice(0, RIGS);
    const free = this.rigs.filter((r) => !chosen.includes(r.c));
    let changed = false;
    for (const c of chosen) {
      if (this.rigs.some((r) => r.c === c)) continue;
      const rig = free.shift();
      if (!rig) break;
      if (rig.c >= 0) for (let k = 0; k < L.K; k++) this.layCharms(rig.c, k, 0);
      this.bindRig(rig, c);
      changed = true;
    }
    for (const r of free) {
      if (r.c < 0 || chosen.includes(r.c)) continue;
      for (let k = 0; k < L.K; k++) this.layCharms(r.c, k, 0);
      r.c = -1;
      r.group.visible = false;
      r.light.intensity = 0;
      changed = true;
    }
    if (changed || !this.far.edges.geometry.getAttribute("position")) this.syncFar();
  }

  private bindRig(rig: Rig, c: number) {
    const L = this.L!, d = this.data!, cab = d.cabinets[c];
    rig.c = c;
    rig.group.position.set(L.cab[c].x, 0, L.cab[c].z);
    rig.light.position.set(L.cab[c].x, 2.2, L.cab[c].z);
    rig.group.visible = true;
    rig.door.o = rig.door.t = 0;
    for (let k = 0; k < L.K; k++) {
      const o = rig.iocs[k], ci = cab.ciocs[k];
      o.s = o.t = 0;
      for (const obj of [o.frame, o.ring, ...o.bps]) obj.visible = !!ci;
      const ring = o.ring;
      const fam = ci?.family ?? "-";
      ring.visible = !!ci && fam !== "-";
      const dashed = fam === "B";
      const old = ring.material as THREE.Material;
      if (dashed !== old instanceof THREE.LineDashedMaterial) {
        const nm = dashed ? new THREE.LineDashedMaterial({ color: RING, dashSize: 0.07, gapSize: 0.05 }) : new THREE.LineBasicMaterial({ color: RING });
        nm.transparent = true;
        const r = this.reg.find((x) => x.m === old);
        if (r) r.m = nm;
        ring.material = nm;
        old.dispose();
        if (dashed) ring.computeLineDistances();
      }
      if (ci) {
        const fill = Math.round((100 * (ci.used + ci.wired_spares)) / Math.max(1, ci.capacity));
        (o.label.element.firstChild as HTMLElement).innerHTML =
          `<span class="font-mono normal-case tracking-[0.04em]">${esc(ci.name)}</span>` +
          (fam !== "-" ? ` <span class="ml-1 rounded-sm bg-[#7C5CFF]/25 px-1 text-[9.5px] text-[#C9BDFF]">${fam}</span>` : "") +
          `<span class="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-white/10"><span class="block h-full rounded-full bg-[#7C5CFF]" style="width:${fill}%"></span></span>`;
        ci.baseplates.forEach((bp, b) => {
          if (b < L.B) (o.bpLabels[b].element.firstChild as HTMLElement).textContent = bp.name + (bp.reserved ? (bp.reserved === "future" ? " · future" : " · alarm") : "");
        });
      }
      this.updIoc(rig, k);
    }
  }

  /** Re-lay-out one rig CIOC: baseplate heights follow its spread s; frame, ring, pick volume and CHARMs follow. */
  private updIoc(rig: Rig, k: number) {
    const L = this.L!, o = rig.iocs[k], ix = ixOf(L, k), z = zOf(L, k);
    for (let b = 0; b < L.B; b++) o.bps[b].position.set(ix, bpY(L, o.s, b), z);
    const fy = stackY(L, o.s), fh = frameH(L, o.s);
    o.frame.position.set(ix, fy, z);
    o.vol.position.set(ix, fy, z);
    o.frame.scale.y = o.vol.scale.y = fh;
    o.ring.position.y = fy;
    o.ring.scale.y = fh + 0.08;
    o.label.position.y = fy + fh / 2 + 0.25;
    if (rig.c >= 0 && this.data!.cabinets[rig.c].ciocs[k]) this.layCharms(rig.c, k, o.s);
  }

  private ensureTrails(): Trails {
    if (this.trails) return this.trails;
    const L = this.L!, d = this.data!;
    const all = d.trailTargets;
    const step = Math.max(1, all.length / TRAILS_MAX);
    const picked = [];
    for (let i = 0; i < all.length && picked.length < TRAILS_MAX; i += step) picked.push(all[Math.floor(i)]);
    const acc = new THREE.Color(ACC);
    const targets = picked.map((t, i) => ({
      x: L.cab[t.c].x + ixOf(L, t.k),
      y: bpY(L, 0, t.b),
      z: L.cab[t.c].z + zOf(L, t.k),
      lz: zOf(L, t.k),
      colour: new THREE.Color(IO_COLOURS[t.io]).lerp(acc, 0.4),
      delay: 0.2 + (2.6 * i) / Math.max(1, picked.length),
    }));
    const jb = new THREE.Vector3(L.jb[0], L.jb[1], L.jb[2] + 0.3);
    this.trails = buildTrails(jb, L.room.wallZ, targets);
    this.trails.group.visible = false;
    this.dyn.add(this.trails.group);
    return this.trails;
  }

  // ───────────── moment plumbing ─────────────

  private begin(
    name: MomentName, dur: number, held: boolean,
    parts: { apply(p: number): void; paint?(p: number): void; finish?(): void; skipKeys?: boolean },
  ): Promise<void> {
    this.endMoment();
    return new Promise<void>((resolve) => {
      const cv = this.renderer.domElement;
      const skip = (e: Event) => {
        if (this.moment !== m || m.held) return;
        if (parts.skipKeys) (e.preventDefault(), e.stopPropagation());
        else if (e instanceof KeyboardEvent && (e.metaKey || e.ctrlKey || e.altKey)) return;
        this.endMoment();
      };
      window.addEventListener("keydown", skip, true);
      cv.addEventListener("pointerdown", skip);
      const m: Moment = {
        name, dur: Math.max(0.05, dur), p: 0, held, shown: false, apply: parts.apply, paint: parts.paint, finish: parts.finish ?? nop, resolve,
        off: () => (window.removeEventListener("keydown", skip, true), cv.removeEventListener("pointerdown", skip)),
      };
      this.moment = m;
      this.lastInput = this.el;
      m.apply(0);
      this.colourDirty = true;
      this.emit("moment", { name, phase: "start" });
    });
  }

  /** End the running moment: its end state (p = 1) stays, what it owns is released, its promise resolves. */
  private endMoment() {
    const m = this.moment;
    if (!m) return;
    this.moment = null;
    m.off();
    m.p = 1;
    m.apply(1);
    this.fade = null;
    m.finish();
    this.colourDirty = true;
    this.emit("moment", { name: m.name, phase: "end" });
    m.resolve();
  }

  /** Ready a new moment: the previous one ends first (its selection and fades must not land on top of the new flight). */
  private prep() {
    this.navToken++; // a staged goTo still on its way must not land on top of the moment
    this.endMoment();
    this.clearMarks();
  }

  /** Calm: cut to s now (no flight). Otherwise a seekable flight from the current camera to s; the targets switch to s now. */
  private flightOrCut(s: Sel, hump: number, calm: boolean): Flight | null {
    if (calm) return void this.setSel(s, false), null;
    const a = this.pose(false);
    const b = this.probe(s);
    this.setSel(s, false, false);
    this.captureFades();
    return { a, b, hump };
  }

  private pose(end: boolean): Pose {
    return { p: this.ctrl.getPosition(new THREE.Vector3(), end), t: this.ctrl.getTarget(new THREE.Vector3(), end) };
  }

  /** Where focus() would put the camera for s — computed, not flown: the camera is put straight back. */
  private probe(s: Sel): Pose {
    const keep = this.sel, face = this.face, a = this.pose(false);
    this.sel = { ...s };
    if (s.level >= 2) this.face = isRear(this.L!, s.k) ? 1 : 0;
    this.focus(false);
    const b = this.pose(true);
    this.sel = keep;
    this.face = face;
    this.ctrl.setLookAt(a.p.x, a.p.y, a.p.z, a.t.x, a.t.y, a.t.z, false);
    return b;
  }

  /** Camera + fades at flight progress e: spherical around a target that leads (so the subject stays in frame), radius log-lerped with a hump. */
  private fly(f: Flight, e: number) {
    const sa = this.s1.setFromVector3(this.v1.subVectors(f.a.p, f.a.t));
    const sb = this.s2.setFromVector3(this.v2.subVectors(f.b.p, f.b.t));
    const dth = ((((sb.theta - sa.theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    // turn while still far out (an orbit to a rear CIOC must not cut through the cabinet), then dive in
    const ea = 1 - Math.pow(1 - e, 2.5), er = Math.pow(e, 1.4);
    const r = Math.pow(sa.radius, 1 - er) * Math.pow(sb.radius, er) * (1 + f.hump * Math.sin(Math.PI * e));
    const t = this.v3.lerpVectors(f.a.t, f.b.t, 1 - (1 - e) * (1 - e));
    const p = this.v4.setFromSpherical(this.s3.set(r, sa.phi + (sb.phi - sa.phi) * ea, sa.theta + dth * ea)).add(t);
    this.ctrl.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
    this.driveFades(e);
    if (e >= 1) this.fade = null; // landed: the tick's smoothing owns the fades again
  }

  /** Snapshot every smoothed value (fades, doors, spreads, CHARM alphas) — a flight interpolates them from here to their targets. */
  private captureFades() {
    this.fade = {
      reg: Float32Array.from(this.reg, (r) => r.cur),
      far: this.far.cur,
      door: this.rigs.map((r) => r.door.o),
      spread: this.rigs.map((r) => r.iocs.map((o) => o.s)),
      charm: this.cur.slice(),
      b: this.bCur,
      jb: this.jbA,
    };
  }

  private driveFades(e: number) {
    const f = this.fade;
    if (!f) return;
    const lerp = (a: number, b: number) => a + (b - a) * e;
    this.reg.forEach((r, j) => (r.cur = lerp(f.reg[j], r.t)));
    this.far.cur = lerp(f.far, this.far.t);
    this.rigs.forEach((rig, j) => {
      rig.door.o = lerp(f.door[j], rig.door.t);
      rig.iocs.forEach((o, k) => {
        const s = lerp(f.spread[j][k], o.t);
        if (Math.abs(s - o.s) > 1e-5) (o.s = s), this.updIoc(rig, k);
      });
    });
    const { cur, tgt } = this;
    for (let i = 0; i < cur.length; i++) cur[i] = f.charm[i] + (tgt[i] - f.charm[i]) * e;
    this.bCur = f.b + (this.bT - f.b) * Math.pow(e, 4); // the cable bundle hangs right in front of the lens until the very end
    this.jbA = lerp(f.jb, this.jbT);
    if (this.hov) this.placeHover();
  }

  /** The colour slot of CHARM i (the hatched mesh for wired spares). */
  private colRef(i: number): [Float32Array, number] {
    const wp = this.wsPos[i];
    return wp >= 0 ? [this.hatch.instanceColor!.array as Float32Array, wp * 3] : [this.charms.instanceColor!.array as Float32Array, i * 3];
  }

  /** Paint override: mix CHARM i towards c × gain by amt. Respects the CHARM's fade. */
  private mixCol(i: number, c: THREE.Color, amt: number, gain = 1) {
    const [a, j] = this.colRef(i), f = this.cur[i] * gain;
    a[j] += (c.r * f - a[j]) * amt;
    a[j + 1] += (c.g * f - a[j + 1]) * amt;
    a[j + 2] += (c.b * f - a[j + 2]) * amt;
  }
  private setCol(i: number, c: THREE.Color) {
    this.mixCol(i, c, 1);
  }
  private scaleCol(i: number, k: number) {
    const [a, j] = this.colRef(i);
    a[j] *= k;
    a[j + 1] *= k;
    a[j + 2] *= k;
  }
  /** Base → old look (weight wOld) → towards hot × gain (weight wHot), then × alpha (a dissolve shimmer). */
  private blendCol(i: number, old: THREE.Color, wOld: number, hot: THREE.Color, wHot: number, gain: number, alpha = 1) {
    this.mixCol(i, old, wOld);
    this.mixCol(i, hot, wHot, gain);
    if (alpha !== 1) this.scaleCol(i, alpha);
  }

  /** The look of a CHARM of this IO kind (a Field CHARM's painted colour; spare = the dark cover). */
  private lookOf(io: IoKey): THREE.Color {
    const k = KIND_KEYS.indexOf(io);
    return k >= 0 ? IOC[k].clone().multiplyScalar(1.5 * IOGAIN[k]) : DARK.clone();
  }

  /** Mark j: a frame around CHARM i (brightness a) + two ripple rings (radius, brightness). Additive: 0 = invisible. */
  private mark(j: number, i: number, c: THREE.Color, a: number, r1 = 0, a1 = 0, r2 = 0, a2 = 0) {
    if (j >= MARKS_MAX) return;
    const L = this.L!, p = this.charmPos(i, this.v5);
    writeT(this.marks.instanceMatrix.array as Float32Array, j, p.x, p.y, p.z, a > 0.002);
    this.marks.setColorAt(j, this.c1.copy(c).multiplyScalar(a));
    const z = p.z + (isRear(L, decode(L, i).k) ? -1 : 1) * (L.charm.d / 2 + 0.014);
    const ra = this.rings.instanceMatrix.array as Float32Array;
    writeS(ra, j * 2, p.x, p.y, z, r1, a1 > 0.002);
    writeS(ra, j * 2 + 1, p.x, p.y, z, r2, a2 > 0.002);
    this.rings.setColorAt(j * 2, this.c1.copy(c).multiplyScalar(a1));
    this.rings.setColorAt(j * 2 + 1, this.c1.copy(c).multiplyScalar(a2));
    this.markIdx[j] = i;
    this.marks.instanceMatrix.needsUpdate = this.rings.instanceMatrix.needsUpdate = true;
    this.marks.instanceColor!.needsUpdate = this.rings.instanceColor!.needsUpdate = true;
  }

  /** Frames that outlive their moment (failing slots, Rev B changes); they follow the baseplate spread until cleared. */
  private keepMarks(list: { i: number; c: THREE.Color; a: number }[]) {
    this.kept = list.slice(0, MARKS_MAX);
    this.layKept();
  }
  private layKept() {
    const k = this.kept;
    if (!k) return;
    k.forEach((x, j) => this.mark(j, x.i, x.c, x.a));
    this.marks.count = k.length;
    this.rings.count = 0;
  }
  private clearMarks() {
    this.kept = null;
    if (this.marks) this.marks.count = this.rings.count = 0;
  }

  /** Shake offset for one CHARM (refused move). dx = 0 puts it back. */
  private nudge(i: number, dx: number) {
    const p = this.charmPos(i, this.v5), wp = this.wsPos[i], im = wp >= 0 ? this.hatch : this.charms;
    writeT(im.instanceMatrix.array as Float32Array, wp >= 0 ? wp : i, p.x + dx, p.y, p.z, this.kind[i] !== NONE);
    im.instanceMatrix.needsUpdate = true;
  }

  private ensureBeam(L: Layout): Beam {
    if (this.beam) return this.beam;
    const rows = [...new Set(L.cab.map((c) => c.z))];
    this.beam = buildBeam(rows.map((z) => ({ z, depth: L.D })), L.H + 0.6, HOVER);
    this.dyn.add(this.beam.group);
    return this.beam;
  }

  // ───────────── selection & fade ─────────────

  /** Target opacity (0..1) of an object at depth L (1 cabinet, 2 CIOC, 3 baseplate, 4 CHARM) — the prototype's T(). */
  private T(c: number, k: number, b: number, m: number, L: number) {
    const { level, c: sc, k: sk, b: sb, m: sm } = this.sel;
    if (level == 0) return 1;
    if (c !== sc) return 0.07;
    if (L == 1) return level > 1 ? 0.12 : 1;
    if (level < 2) return 1;
    if (k !== sk) return 0.08;
    if (L == 2) return level > 2 ? 0.15 : 1;
    if (level < 3) return 1;
    if (b !== sb) return L == 4 ? 0.045 : 0.1; // neighbouring baseplates' CHARMs recede further than their steel
    if (L == 3) return level > 3 ? 0.15 : 1;
    if (level < 4) return 1;
    return m !== sm ? 0.25 : 1;
  }

  /** Push new fade / door / spread / bundle / label targets after the selection changed. */
  private retarget() {
    const Lo = this.L;
    if (!Lo) return;
    const { level, c: sc, k: sk, b: sb } = this.sel;
    for (const r of this.reg) r.t = r.rig.c < 0 ? 0 : this.T(r.rig.c, r.k, r.b, 0, r.L);
    this.far.t = level == 0 ? 1 : 0.07;
    for (let i = 0; i < Lo.N; i++) {
      const { c, k, b, m } = decode(Lo, i);
      this.tgt[i] = this.T(c, k, b, m, 4) * (this.dim[i] ? 0.12 : 1);
    }
    for (const rig of this.rigs) {
      rig.door.t = level >= 1 && rig.c === sc ? 1 : 0;
      rig.iocs.forEach((o, k) => {
        o.t = level >= 2 && rig.c === sc && k === sk ? 1 : 0;
        o.labelOn = level == 1 && rig.c === sc && o.frame.visible;
        o.label.visible = o.labelOn;
        o.bpLabels.forEach((lb) => (lb.visible = level == 2 && rig.c === sc && k === sk && o.frame.visible));
      });
    }
    this.cabLabels.forEach((lb) => (lb.visible = level == 0 && !this.diving && Lo.rows <= 1));
    this.jbT = level == 0 || this.diving ? 1 : 0;
    this.jbLabel.visible = level == 0 && !this.diving;
    // L3: every CHARM's tag hangs below it (focused level only)
    this.chLabels.forEach((lb, m) => {
      const i = level == 3 ? idxOf(Lo, sc, sk, sb, m) : -1;
      if (i < 0 || this.kind[i] === NONE) return void (lb.visible = false);
      const sl = this.slots[i], el = lb.element.firstChild as HTMLElement;
      const spare = !sl || sl.status === "Spare Slot";
      el.textContent = spare ? "spare" : sl.tag;
      el.classList.toggle("spare", spare);
      const cab = Lo.cab[sc];
      lb.position.set(cab.x + ixOf(Lo, sk) + chX(Lo, m), bpY(Lo, 1, sb) + 0.13 - Lo.charm.h / 2 - 0.014, cab.z + zOf(Lo, sk) + Lo.charm.d / 2);
      lb.visible = true;
    });
    this.bT = level >= 3 ? 1 : 0;
    for (const lb of this.cableLabels) (lb.element.remove(), lb.removeFromParent());
    this.cableLabels = [];
    if (level >= 3) {
      const cab = Lo.cab[sc], x = cab.x + ixOf(Lo, sk), z = cab.z + zOf(Lo, sk), y = bpY(Lo, 1, sb);
      this.bundle.position.set(x, y, z);
      this.bundle.rotation.y = isRear(Lo, sk) ? Math.PI : 0;
      this.bundle.visible = true;
      for (const run of this.data!.cabinets[sc].runs[sk][sb]) {
        const lb = new CSS2DObject(
          labelEl(LABEL + " font-mono normal-case tracking-[0.04em]", `${esc(run.cable)} · ch ${run.chFrom}${run.chTo > run.chFrom ? `–${run.chTo}` : ""}`),
        );
        lb.position.set(x + (chX(Lo, run.chFrom - 1) + chX(Lo, run.chTo - 1)) / 2, y + 0.42, z);
        lb.visible = level == 3;
        this.dyn.add(lb);
        this.cableLabels.push(lb);
      }
    }
    this.colourDirty = true;
  }

  /** `camera: false` = only the targets (fades, doors, spread, rigs) — a moment's flight moves the camera itself. */
  private setSel(s: Sel, transition: boolean, camera = true) {
    const prevC = this.sel.c;
    this.lastInput = this.el;
    this.sel = { ...s };
    if (s.level >= 2 && this.L) this.face = isRear(this.L, s.k) ? 1 : 0;
    this.setHover(null);
    if (s.c >= 0) this.assignRigs(prevC >= 0 && prevC !== s.c ? [s.c, prevC] : [s.c]);
    this.retarget();
    if (camera) this.focus(transition && !this.opts.calm?.());
    this.emitLevel();
    this.emit("select", { ...this.pub(s), ...this.extra(s), screen: this.screenOf(s) });
  }

  /** Fly the camera to the current selection (fitToBox + rotate to front or rear). */
  private focus(t: boolean) {
    const L = this.L!, ctrl = this.ctrl, { level, c: sc, k: sk, b: sb, m: sm } = this.sel;
    const turn = (az: number) => az + Math.PI * 2 * Math.round((ctrl.azimuthAngle - az) / (Math.PI * 2));
    if (level == 0) {
      const r = L.room, az = turn(this.face * Math.PI);
      if (L.rows <= 1) {
        // Frame the row itself (cabinets + their name plates), so the cabinets fill the view instead of a far-off pose.
        void ctrl.rotateTo(az, 1.24, t);
        void ctrl.fitToBox(bx(0, 2.05, r.cz, r.w + 0.5, 4.3, L.D), t, { paddingLeft: 0.35, paddingRight: 0.35, paddingTop: 0.55, paddingBottom: 0.2 });
        return;
      }
      // Several rows: look down the room from higher up so every row stays readable.
      void ctrl.rotateTo(az, 0.95, t);
      void ctrl.fitToBox(bx(0, 1.65, r.cz, r.w + 1, 3.3, r.d + 1), t, { paddingLeft: 0.4, paddingRight: 0.4, paddingTop: 0.4, paddingBottom: 0.4 });
      return;
    }
    const cab = L.cab[sc];
    let box: THREE.Box3, az = 0, pol = 1.4, pad = 0.25, padT = -1;
    if (level == 1) {
      box = bx(cab.x, 1.7, cab.z, L.W + 0.3, 3.6, 2);
      az = this.face * Math.PI + 0.35;
      pol = 1.3;
    } else {
      const ix = ixOf(L, sk), x = cab.x + ix, z = cab.z + zOf(L, sk);
      az = (isRear(L, sk) ? Math.PI : 0) + (ix < -1e-6 ? 0.12 : ix > 1e-6 ? -0.12 : 0);
      if (level == 2) {
        box = bx(x, stackY(L, 1), z, 1.5, frameH(L, 1), 0.6);
        pol = 1.45;
        padT = 0.6; // the HUD sits over the top edge; baseplate 1 must clear it
      } else if (level == 3) {
        // the 12 CHARMs centred with margin: cable label above, the tags hanging below
        box = bx(x, bpY(L, 1, sb) + 0.17, z, L.bpW + 0.22, 0.92, 0.36);
        pad = 0.2;
        pol = 1.48;
      }
      else {
        box = bx(x + chX(L, sm), bpY(L, 1, sb) + 0.13, z, 0.12, 0.17, 0.22);
        pad = 0.9;
        pol = 1.35;
      }
    }
    void ctrl.rotateTo(turn(az), pol, t);
    void ctrl.fitToBox(box, t, { paddingLeft: pad, paddingRight: pad, paddingTop: padT >= 0 ? padT : pad, paddingBottom: pad });
  }

  /** Staged path between two selections: up to the common ancestor (sibling cabinets hop at cabinet level), then down one level at a time. */
  private path(a: Sel, b: Sel): Sel[] {
    const keys: ("c" | "k" | "b" | "m")[] = ["c", "k", "b", "m"];
    let d = 0;
    while (d < Math.min(a.level, b.level) && a[keys[d]] === b[keys[d]]) d++;
    const prefix = (s: Sel, l: number): Sel => ({ level: l as Level, c: l >= 1 ? s.c : -1, k: l >= 2 ? s.k : -1, b: l >= 3 ? s.b : -1, m: l >= 4 ? s.m : -1 });
    const floor = d === 0 && a.level >= 1 && b.level >= 1 ? 1 : d;
    const out: Sel[] = [];
    for (let l = a.level - 1; l >= Math.max(floor, d); l--) if (l < a.level) out.push(prefix(a, l));
    if (floor === 1 && d === 0) out.push(prefix(b, 1));
    for (let l = Math.max(floor, d) + 1; l <= b.level; l++) out.push(prefix(b, l));
    if (!out.length) out.push(prefix(b, b.level));
    return out;
  }

  private internal(level: Level, a: Partial<Address>): Sel | null {
    const L = this.L!, d = this.data!, cur = this.sel;
    const c = level >= 1 ? (a.cab ?? cur.c) : -1;
    const k = level >= 2 ? (a.cioc != null ? a.cioc - 1 : cur.k) : -1;
    const b = level >= 3 ? (a.bp != null ? a.bp - 1 : cur.b) : -1;
    const m = level >= 4 ? (a.ch != null ? a.ch - 1 : cur.m) : -1;
    if (level >= 1 && (c < 0 || c >= L.n)) return null;
    if (level >= 2 && (k < 0 || k >= L.K || !d.cabinets[c].ciocs[k])) return null;
    if (level >= 3 && (b < 0 || b >= L.B)) return null;
    if (level >= 4 && (m < 0 || m >= L.M)) return null;
    return { level, c, k, b, m };
  }

  private pub(s: Sel): Selection {
    return { level: s.level, cab: s.c, cioc: s.k >= 0 ? s.k + 1 : -1, bp: s.b >= 0 ? s.b + 1 : -1, ch: s.m >= 0 ? s.m + 1 : -1, face: this.face ? "R" : "F" };
  }

  private extra(s: Sel) {
    const d = this.data!;
    const cabinet = s.c >= 0 ? d.cabinets[s.c]?.name : undefined;
    const slot = s.level >= 4 ? this.slots[idxOf(this.L!, s.c, s.k, s.b, s.m)] : null;
    return { cabinet, slotId: slot?.id };
  }

  private screenOf(s: Sel) {
    const L = this.L!;
    if (s.level == 0 || s.c < 0) return { x: this.w / 2, y: this.h / 2 };
    const cab = L.cab[s.c];
    const v = new THREE.Vector3(cab.x, 2, cab.z);
    if (s.level >= 2) v.set(cab.x + ixOf(L, s.k), s.level >= 3 ? bpY(L, 1, s.b) : stackY(L, 1), cab.z + zOf(L, s.k));
    if (s.level >= 4) v.x += chX(L, s.m);
    v.project(this.cam);
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h };
  }

  private emit<K extends keyof EventMap>(ev: K, e: EventMap[K]) {
    this.listeners.get(ev)?.forEach((cb) => (cb as (x: EventMap[K]) => void)(e));
  }
  private emitLevel() {
    this.emit("level", this.pub(this.sel));
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => window.setTimeout(r, ms));
  }

  // ───────────── input ─────────────

  /** Raycast under the pointer; returns the deepest-allowed hit on the current selection path (prototype hitAt). */
  private hitAt(cx: number, cy: number): { c: number; k: number; b: number; m: number } | null {
    const L = this.L;
    if (!L || !this.data) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.nd.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.nd, this.cam);
    const { level, c: sc, k: sk, b: sb } = this.sel;
    const rig = this.rigs.find((x) => x.c === sc);
    let objs: THREE.Object3D[];
    if (level == 0 || !rig) objs = [this.far.pick];
    else if (level == 1) objs = rig.iocs.filter((o) => o.frame.visible).map((o) => o.vol);
    else if (level == 2) objs = rig.iocs[sk].bps;
    else objs = [this.charms, this.hatch];
    for (const h of this.ray.intersectObjects(objs, false)) {
      if (h.object === this.far.pick) return { c: h.instanceId!, k: -1, b: -1, m: -1 };
      if (h.object === this.charms || h.object === this.hatch) {
        const i = h.object === this.hatch ? this.wsIdx[h.instanceId!] : h.instanceId!;
        const p = decode(L, i);
        if (p.c !== sc || p.k !== sk || p.b !== sb || this.kind[i] === NONE) continue;
        return p;
      }
      const u = h.object.userData as { k: number; b?: number };
      return { c: sc, k: u.k, b: u.b ?? -1, m: -1 };
    }
    // L3/L4: the gaps between CHARMs still pick the nearest channel on the open baseplate (forgiving clicks).
    if (level >= 3) {
      const cab = L.cab[sc], x0 = cab.x + ixOf(L, sk), z = cab.z + zOf(L, sk), y = bpY(L, 1, sb) + 0.13;
      const p = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
      if (p && Math.abs(p.y - y) < L.charm.h && Math.abs(p.x - x0) < L.bpW / 2) {
        const m = Math.min(L.M - 1, Math.max(0, Math.round((p.x - x0) / L.charm.pitch + (L.M - 1) / 2)));
        if (this.kind[idxOf(L, sc, sk, sb, m)] !== NONE) return { c: sc, k: sk, b: sb, m };
      }
    }
    // Outside the current cabinet: another cabinet opens instead (the prototype ignored it).
    if (level >= 1) {
      const h = this.ray.intersectObject(this.far.pick, false)[0];
      if (h && h.instanceId !== sc) return { c: h.instanceId!, k: -1, b: -1, m: -1 };
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    this.pd = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onUp = (e: PointerEvent) => {
    const pd = this.pd;
    this.pd = null;
    if (!pd || this.diving) return;
    if (Math.hypot(e.clientX - pd.x, e.clientY - pd.y) > 5 || performance.now() - pd.t > 500) return;
    const h = this.hitAt(e.clientX, e.clientY);
    if (!h) return;
    const { level } = this.sel;
    if (h.k < 0) void this.goTo(1, { cab: h.c });
    else if (level == 1) void this.goTo(2, { cab: h.c, cioc: h.k + 1 });
    else if (level == 2) void this.goTo(3, { cab: h.c, cioc: h.k + 1, bp: h.b + 1 });
    else void this.goTo(4, { cab: h.c, cioc: h.k + 1, bp: h.b + 1, ch: h.m + 1 });
  };

  // hover: pointer cursor + an event describing what a click would open (the React hover card renders it)
  private onMove = (e: PointerEvent) => {
    const n = performance.now();
    if (n - this.lastHv < 90 || e.buttons) return;
    this.lastHv = n;
    const h = this.diving ? null : this.hitAt(e.clientX, e.clientY);
    const cv = this.renderer.domElement;
    cv.style.cursor = h ? "pointer" : "default";
    this.setHover(h);
    if (!h) return this.emit("hover", null);
    const r = cv.getBoundingClientRect();
    const level = (h.m >= 0 ? 4 : h.b >= 0 ? 3 : h.k >= 0 ? 2 : 1) as Level;
    const s: Sel = { level, ...h };
    this.emit("hover", { ...this.pub(s), ...this.extra(s), screen: { x: e.clientX - r.left, y: e.clientY - r.top } });
  };

  private onLeave = () => {
    this.setHover(null);
    this.emit("hover", null);
  };

  /** Hover highlight: a cyan outline around whatever a click would open (cabinet, CIOC, baseplate or CHARM). */
  private setHover(h: { c: number; k: number; b: number; m: number } | null) {
    this.hov = h;
    if (this.hoverBox) this.hoverBox.visible = !!h;
    if (h) this.placeHover();
  }

  private placeHover() {
    const L = this.L, h = this.hov;
    if (!L || !h) return;
    const cab = L.cab[h.c], hb = this.hoverBox;
    const s = this.rigs.find((r) => r.c === h.c)?.iocs[Math.max(0, h.k)]?.s ?? 0;
    // [w, h, d, bar thickness] per level; the frame is real geometry (WebGL lines are 1 px — too faint for a focus ring)
    let dims: [number, number, number, number];
    if (h.k < 0) {
      hb.position.set(cab.x, L.H / 2 + 0.02, cab.z);
      dims = [L.W + 0.08, L.H + 0.08, L.D + 0.08, 0.03];
    } else if (h.b < 0) {
      hb.position.set(cab.x + ixOf(L, h.k), stackY(L, s), cab.z + zOf(L, h.k));
      dims = [1.48, frameH(L, s) + 0.06, 0.56, 0.016];
    } else if (h.m < 0) {
      hb.position.set(cab.x + ixOf(L, h.k), bpY(L, s, h.b) + 0.05, cab.z + zOf(L, h.k));
      dims = [L.bpW + 0.05, 0.34, 0.36, 0.01];
    } else {
      this.charmPos(idxOf(L, h.c, h.k, h.b, h.m), hb.position);
      dims = [L.charm.w + 0.02, L.charm.h + 0.02, L.charm.d + 0.02, 0.007];
    }
    const key = dims.map((v) => v.toFixed(3)).join("x");
    let g = this.hoverGeo.get(key);
    if (!g) {
      if (this.hoverGeo.size > 24) (this.hoverGeo.forEach((x) => x !== hb.geometry && x.dispose()), this.hoverGeo.clear());
      this.hoverGeo.set(key, (g = frameGeometry(...dims)));
    }
    hb.geometry = g;
  }

  // ───────────── render loop ─────────────

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const raw = this.clock.getDelta();
    if (raw > 0) this.fpsAvg += (1 / raw - this.fpsAvg) * 0.05;
    const dt = Math.min(raw, 0.05);
    this.el += dt;
    const el = this.el;
    const k = 1 - Math.exp(-dt * 5);
    const kf = this.fade ? 0 : k; // a moment's flight drives the fades itself
    const L = this.L;
    const cam = this.cam;
    const mo = this.moment;
    if (mo) {
      this.lastInput = el; // no idle drift under a moment
      if (!mo.held) {
        mo.p = Math.min(1, mo.p + dt / mo.dur);
        mo.apply(mo.p);
      }
    }
    if (this.sel.level == 0 && !this.diving && el - this.lastInput > 4) this.ctrl.rotate(dt * 0.07, 0, true); // idle drift
    if (Math.abs(this.fovT - cam.fov) > 0.01) {
      cam.fov += (this.fovT - cam.fov) * Math.min(1, dt * 1.3);
      cam.updateProjectionMatrix();
    }
    this.ctrl.update(dt);
    for (const r of this.reg) {
      r.cur += (r.t - r.cur) * kf;
      r.m.opacity = r.base * r.cur;
    }
    if (L && this.data) {
      const f = this.far;
      f.cur += (f.t - f.cur) * kf;
      for (const x of f.mats) x.m.opacity = x.base * f.cur;
      let spreading = false;
      for (const rig of this.rigs) {
        if (rig.c < 0) continue;
        const d = rig.door;
        d.o += (d.t - d.o) * kf * 0.6;
        const e = d.o * d.o * (3 - 2 * d.o);
        for (const p of rig.dp) p.piv.rotation.y = p.s * e * 1.9;
        rig.light.intensity = RIG_LIGHT + (this.cabs[rig.c]?.glow ?? 0) * 18;
        const front = cam.position.z > L.cab[rig.c].z; // CIOC labels only on the face the camera sees
        rig.iocs.forEach((o, kk) => {
          o.label.visible = o.labelOn && isRear(L, kk) !== front;
          if (kf && Math.abs(o.t - o.s) > 0.001) {
            o.s += (o.t - o.s) * kf * 0.8;
            this.updIoc(rig, kk);
            spreading = true;
          }
        });
      }
      let glowMoving = false, gsum = 0;
      for (const cb of this.cabs) {
        const g0 = cb.glow;
        cb.glow += (cb.gt - cb.glow) * Math.min(1, dt * 3);
        if (Math.abs(cb.glow - g0) > 1e-4) glowMoving = true;
        gsum += cb.glow;
      }
      const g = gsum / Math.max(1, this.cabs.length);
      this.bloom.strength = BLOOM + g * 0.45;
      const jbm = this.jb.material as THREE.MeshStandardMaterial;
      jbm.emissiveIntensity = 0.04 + g * 1.6;
      this.jbLight.intensity = g * 22;
      // the junction box belongs to the room view and the dive; inside a cabinet it would hang behind the CHARMs
      this.jbA += (this.jbT - this.jbA) * kf;
      this.jb.visible = this.jbA > 0.01;
      jbm.opacity = this.jbA;
      this.jb.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (mm && mm !== jbm) mm.opacity = this.jbA * (o instanceof THREE.LineSegments ? 0.7 : 1);
      });
      this.trailA += (this.trailT - this.trailA) * Math.min(1, dt * 2.5);
      if (this.trails) {
        this.trails.setAlpha(this.trailA);
        this.trails.uT.value = this.trailClock;
      }
      if (spreading) {
        if (this.hov) this.placeHover();
        if (this.kept && !mo) this.layKept();
      }
      const pulsing = this.pulse0 >= 0 && el - this.pulse0 < this.pulseDur;
      if (this.pulse0 >= 0 && !pulsing) (this.pulse0 = -1), (this.colourDirty = true);
      if (this.colourDirty || glowMoving || pulsing || mo) this.paint(kf, pulsing);
    }
    this.bCur += (this.bT - this.bCur) * kf;
    for (const m of this.bMats) m.opacity = this.bCur;
    if (this.bCur < 0.01 && this.bT == 0) this.bundle.visible = false;

    this.renderer.info.reset();
    this.composer.render();
    this.lastCalls = this.renderer.info.render.calls;
    this.lastTris = this.renderer.info.render.triangles;
    this.css.render(this.scene, cam);
    if (this.firstFrameMs == null && this.data) (this.firstFrameMs = Math.round(performance.now() - this.t0)), this.readyRes();
    if (mo && this.moment === mo) {
      if (!mo.shown) (mo.shown = true), this.emit("moment", { name: mo.name, phase: "frame" });
      if (!mo.held && mo.p >= 1) this.endMoment();
    }
  };

  /** Recompute instance colours (only called while something is changing). Converged → the dirty flag clears. */
  private paint(k: number, pulsing: boolean) {
    const L = this.L!;
    const ca = this.charms.instanceColor!.array as Float32Array;
    const ha = this.hatch.instanceColor!.array as Float32Array;
    const { tgt, cur } = this;
    const sel = this.sel.level == 4 ? idxOf(L, this.sel.c, this.sel.k, this.sel.b, this.sel.m) : -1;
    const per = L.K * L.B * L.M;
    const pp = pulsing ? 0.5 - 0.5 * Math.cos(((this.el - this.pulse0) / this.pulseDur) * Math.PI * 6) : 0;
    const pc = this.pulseCol;
    let moving = false;
    for (let i = 0; i < L.N; i++) {
      const kind = this.kind[i];
      if (kind === NONE) continue;
      const dv = tgt[i] - cur[i];
      if (dv > 0.002 || dv < -0.002) moving = true;
      const a = (cur[i] += dv * k);
      let r: number, g: number, b: number;
      const wp = this.wsPos[i];
      if (kind === SPARE) {
        const v = 0.09 * a;
        (r = v), (g = v * 1.15), (b = v * 1.5);
      } else {
        const cc = IOC[kind], glow = this.cabs[(i / per) | 0].glow;
        // Field / alarm glow above the bloom threshold; wired spares stay dim (below it) — the hatch shows they are spare.
        const f = (wp >= 0 ? 0.45 + glow * 0.6 : 1.5 + glow * 1.3 + (i === sel ? 1.2 : 0)) * a * IOGAIN[kind];
        (r = cc.r * f), (g = cc.g * f), (b = cc.b * f);
      }
      if (pp > 0 && this.pulseMask[i]) {
        const q = pp * 2.2;
        r = r * (1 - pp) + pc.r * q;
        g = g * (1 - pp) + pc.g * q;
        b = b * (1 - pp) + pc.b * q;
      }
      const arr = wp >= 0 ? ha : ca, j = (wp >= 0 ? wp : i) * 3;
      arr[j] = r;
      arr[j + 1] = g;
      arr[j + 2] = b;
    }
    this.moment?.paint?.(this.moment.p);
    this.charms.instanceColor!.needsUpdate = true;
    this.hatch.instanceColor!.needsUpdate = true;
    this.colourDirty = moving;
  }
}

// ───────────── helpers ─────────────

/** Write a translation-only matrix (or a zero-scale one when hidden) straight into an instanceMatrix array. */
function writeT(a: Float32Array, i: number, x: number, y: number, z: number, show: boolean) {
  const o = i * 16, s = show ? 1 : 0;
  a[o] = s; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = s; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = s; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}

/** Same grid, same CHARM in every slot (kind, status, id) — a new allocation object that would rebuild nothing. */
function sameWorld(a: World3DData, b: World3DData) {
  const x = a.layout, y = b.layout;
  if (x.n !== y.n || x.K !== y.K || x.B !== y.B || x.M !== y.M || a.cabinets.length !== b.cabinets.length) return false;
  if (a.cabinets.some((c, i) => c.name !== b.cabinets[i].name)) return false;
  for (let i = 0; i < x.N; i++) if (a.kind[i] !== b.kind[i] || a.status[i] !== b.status[i] || a.slots[i]?.id !== b.slots[i]?.id) return false;
  return true;
}

/** Translation + uniform XY scale (a ring of radius s) — or zero-scale when hidden. */
function writeS(a: Float32Array, i: number, x: number, y: number, z: number, s: number, show: boolean) {
  writeT(a, i, x, y, z, show);
  if (show) (a[i * 16] = s), (a[i * 16 + 5] = s);
}

/** A box outline made of 12 thin bars (instanceable, unlike LineSegments) — the changed-CHARM frame. */
function frameGeometry(w: number, h: number, d: number, t: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) parts.push(new THREE.BoxGeometry(w + t, t, t).translate(0, (sy * h) / 2, (sz * d) / 2));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(new THREE.BoxGeometry(t, h + t, t).translate((sx * w) / 2, 0, (sz * d) / 2));
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(new THREE.BoxGeometry(t, t, d + t).translate((sx * w) / 2, (sy * h) / 2, 0));
  const g = mergeGeometries(parts)!;
  parts.forEach((x) => x.dispose());
  return g;
}

function edgePositions(g: THREE.BufferGeometry) {
  const e = new THREE.EdgesGeometry(g);
  const arr = Array.from(e.getAttribute("position").array as Float32Array);
  e.dispose();
  g.dispose();
  return arr;
}

function pushShifted(out: number[], src: number[], x: number, y: number, z: number) {
  for (let i = 0; i < src.length; i += 3) out.push(src[i] + x, src[i + 1] + y, src[i + 2] + z);
}

/** 45° stripes for wired spares (CLAUDE.md §10.1 hatch), multiplied by the instance colour. */
function hatchTexture() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 32;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#4a4a4a";
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = "#ffffff";
  g.lineWidth = 6;
  for (let o = -32; o <= 64; o += 16) {
    g.beginPath();
    g.moveTo(o, 32);
    g.lineTo(o + 32, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function poolMaterial() {
  const cx = document.createElement("canvas");
  cx.width = cx.height = 128;
  const g2 = cx.getContext("2d")!, gr = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(124,92,255,.55)");
  gr.addColorStop(1, "rgba(124,92,255,0)");
  g2.fillStyle = gr;
  g2.fillRect(0, 0, 128, 128);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cx), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
}
