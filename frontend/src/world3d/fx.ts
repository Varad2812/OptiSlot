import * as THREE from "three";

// Motion-moment effects for the World3DEngine (§10.7 "Motion moments"): the verify scan beam, ripple rings, arc trails.
// Everything here is a pure function of a progress value set by the engine, so a moment looks the same played or seeked.

export const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOut3 = (u: number) => 1 - Math.pow(1 - u, 3);
/** Sub-progress of p inside [a, b], clamped. */
export const span = (p: number, a: number, b: number) => Math.min(1, Math.max(0, (p - a) / Math.max(1e-6, b - a)));

const BEAM_VS = "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}";
// a bright core line with a soft halo across u; fades out towards the top and bottom edges
const BEAM_FS =
  "uniform vec3 uC;uniform float uA;varying vec2 vUv;void main(){float d=abs(vUv.x-.5)*2.;float core=pow(max(0.,1.-d*7.),2.);float halo=pow(max(0.,1.-d),3.)*.2;float v=smoothstep(0.,.18,vUv.y)*smoothstep(1.,.82,vUv.y);float a=(core*1.9+halo)*v*uA;gl_FragColor=vec4(uC*a,a);}";

/** The verify scan beam: one vertical light curtain + one floor stripe per cabinet row, swept along x. */
export interface Beam {
  group: THREE.Group;
  set(x: number, alpha: number): void;
  dispose(): void;
}

export function buildBeam(rows: { z: number; depth: number }[], height: number, colour: number): Beam {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uC: { value: new THREE.Color(colour) }, uA: { value: 0 } },
  });
  const curtain = new THREE.PlaneGeometry(1.1, height);
  const stripe = new THREE.PlaneGeometry(0.9, 1).rotateX(-Math.PI / 2);
  for (const r of rows) {
    const f = new THREE.Mesh(stripe, mat);
    f.scale.z = r.depth + 2.4;
    f.position.set(0, 0.02, r.z);
    const parts = [f];
    for (const face of [1, -1]) {
      const c = new THREE.Mesh(curtain, mat);
      c.position.set(0, height / 2, r.z + face * (r.depth / 2 + 0.08)); // just proud of the cabinet faces (front and rear)
      parts.push(c);
    }
    for (const m of parts) (m.frustumCulled = false), (m.raycast = () => {}), group.add(m);
  }
  group.visible = false;
  return {
    group,
    set(x, alpha) {
      group.position.x = x;
      mat.uniforms.uA.value = alpha;
      group.visible = alpha > 0.002;
    },
    dispose() {
      curtain.dispose();
      stripe.dispose();
      mat.dispose();
    },
  };
}

/** Flat ring (in the XY plane, facing the cabinet face): the ripple around a failing / refused / changed CHARM. */
export function ringGeometry() {
  return new THREE.RingGeometry(0.86, 1, 48);
}

const TRAIL_FS =
  "uniform float uH,uA;uniform vec3 uC;varying vec2 vUv;void main(){float d=uH-vUv.x;float tail=d>=0.?pow(max(0.,1.-d/.55),1.6):0.;float head=d>=0.?smoothstep(.05,0.,d):0.;float a=(tail*.75+head*1.4)*uA;gl_FragColor=vec4(uC*a*1.6,a);}";

/** Arc trails for a move: one thin tube per flight; uH = head position along the tube (0..1), uA = overall alpha. */
export interface ArcTrails {
  group: THREE.Group;
  set(head: number[], alpha: number): void;
  dispose(): void;
}

export function buildArcTrails(curves: THREE.Curve<THREE.Vector3>[], colours: THREE.Color[]): ArcTrails {
  const group = new THREE.Group();
  const mats: THREE.ShaderMaterial[] = [];
  curves.forEach((cv, j) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: BEAM_VS, fragmentShader: TRAIL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uH: { value: 0 }, uA: { value: 0 }, uC: { value: colours[j] } },
    });
    mats.push(m);
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(cv, 48, 0.006, 5), m);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    group.add(mesh);
  });
  return {
    group,
    set(head, alpha) {
      mats.forEach((m, j) => {
        m.uniforms.uH.value = head[j] ?? 0;
        m.uniforms.uA.value = alpha;
      });
    },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}

/** The arc a moved CHARM flies: lifts out of the cabinet face, peaks over the midpoint, settles on the new slot. */
export class ArcCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private a: THREE.Vector3, private b: THREE.Vector3, private lift: number, private out: number) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()) {
    const s = Math.sin(Math.PI * t);
    return target.lerpVectors(this.a, this.b, t).add(new THREE.Vector3(0, s * this.lift, s * 0.18 * this.out));
  }
}
