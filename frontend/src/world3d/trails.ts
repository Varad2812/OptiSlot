import * as THREE from "three";

// LIGHT TRAILS (prototype, unchanged shader): tubes along curves, junction box → baseplates; a shader scrolls a
// glowing head along each tube. uT = seconds since the dive started, uD = this trail's start delay.
const VS = "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}";
const FS =
  "uniform float uT,uD,uA,uS;uniform vec3 uC;varying vec2 vUv;void main(){float on=smoothstep(uD,uD+.3,uT);float p=fract((uT-uD)*.4+uS);float d=p-vUv.x;float a=(d>0.&&d<.3)?pow(1.-d/.3,2.):0.;gl_FragColor=vec4(uC*(a*3.+.12),(a+.05)*uA*on);}";

export interface TrailTarget {
  x: number;
  y: number;
  z: number;
  /** The CIOC's z offset inside its cabinet (front +, rear −) — the curve swings in from that side. */
  lz: number;
  colour: THREE.Color;
  delay: number;
}

export interface Trails {
  group: THREE.Group;
  uT: { value: number };
  setAlpha(a: number): void;
  dispose(): void;
}

/** Deterministic jitter (the prototype used Math.random-like rnd(); a seeded one keeps runs reproducible). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildTrails(jb: THREE.Vector3, wallZ: number, targets: TrailTarget[]): Trails {
  const group = new THREE.Group();
  const uT = { value: 0 };
  const mats: THREE.ShaderMaterial[] = [];
  const rnd = rng(11);
  for (const t of targets) {
    const pts = [
      jb.clone(),
      new THREE.Vector3(jb.x + (t.x - jb.x) * 0.4, 6.2, wallZ + 3),
      new THREE.Vector3(t.x, 4.8, t.z - t.lz + t.lz * 1.4 - 0.4),
      new THREE.Vector3(t.x + (rnd() - 0.5) * 0.6, t.y + 0.6, t.z),
      new THREE.Vector3(t.x + (rnd() - 0.5) * 0.8, t.y + 0.12, t.z),
    ];
    const mt = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uT, uD: { value: t.delay }, uA: { value: 0 }, uS: { value: rnd() }, uC: { value: t.colour } },
    });
    mats.push(mt);
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.018, 4), mt);
    m.frustumCulled = false;
    group.add(m);
  }
  return {
    group,
    uT,
    setAlpha: (a) => mats.forEach((m) => (m.uniforms.uA.value = a)),
    dispose: () => {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}
