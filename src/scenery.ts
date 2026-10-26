import * as THREE from 'three';
import type { Dust } from './dust';
import type { Fx } from './fx';
import type { Wreckage } from './wreckage';
import { terrainHeight } from './terrain';
import { mulberry32 } from './util';

/**
 * The military roadside to the bunker: chain-link fences, warning signs, concrete roadblocks, sandbag walls, tank traps,
 * guardhouses (laid up of loose blocks) and a barrier gate. All of it is set dressing you can wreck: a bullet fells a fence or a sign, a shell
 * or a few seconds of walking through brings down a concrete barrier or a guardhouse, and the pieces fly.
 */

/** the materials every piece shares: chunks being unloaded must not dispose them (see World) */
const shared = <T extends THREE.Material>(m: T): T => { m.userData.shared = true; return m; };

const CONCRETE = shared(new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.95 }));
const CONCRETE_DARK = shared(new THREE.MeshStandardMaterial({ color: 0x6f6c66, roughness: 0.95 }));
const KHAKI = shared(new THREE.MeshStandardMaterial({ color: 0x9a8f6a, roughness: 0.9 }));
const BRICKS = [0x9a8f6a, 0x8f8460, 0xa59a74].map((c) => shared(new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 })));
const ROOF = shared(new THREE.MeshStandardMaterial({ color: 0x4d5240, roughness: 0.85 }));
const STEEL = shared(new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.55, metalness: 0.6 }));
const POST = shared(new THREE.MeshStandardMaterial({ color: 0x3f4a2e, roughness: 0.7, metalness: 0.4 }));       // olive drab
const SANDBAG = shared(new THREE.MeshStandardMaterial({ color: 0xa8956a, roughness: 1 }));
const GLASS = shared(new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.3, metalness: 0.4 }));
const LAMP = shared(new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffc860, emissiveIntensity: 1.5 }));
const SANDBAG_DARK = shared(new THREE.MeshStandardMaterial({ color: 0x8c7b55, roughness: 1 }));

/** a canvas drawn once into a texture */
function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

/** the signs only use shapes that read the same in a mirror: a triangle, a bar, a circle, a cross */
const SIGNS = [
  // yellow warning triangle with a bang
  (g: CanvasRenderingContext2D, s: number) => {
    g.fillStyle = '#e8c21a'; g.beginPath(); g.moveTo(s / 2, s * 0.06); g.lineTo(s * 0.95, s * 0.9); g.lineTo(s * 0.05, s * 0.9); g.closePath(); g.fill();
    g.lineWidth = s * 0.05; g.strokeStyle = '#a01818'; g.stroke();
    g.fillStyle = '#111'; g.fillRect(s * 0.46, s * 0.34, s * 0.08, s * 0.28); g.beginPath(); g.arc(s / 2, s * 0.73, s * 0.05, 0, Math.PI * 2); g.fill();
  },
  // red "no entry" disc with a white bar
  (g: CanvasRenderingContext2D, s: number) => {
    g.fillStyle = '#c21818'; g.beginPath(); g.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f2f2f2'; g.fillRect(s * 0.2, s * 0.43, s * 0.6, s * 0.14);
  },
  // red and white crossed board: restricted
  (g: CanvasRenderingContext2D, s: number) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(s * 0.04, s * 0.04, s * 0.92, s * 0.92);
    g.strokeStyle = '#c21818'; g.lineWidth = s * 0.07; g.strokeRect(s * 0.07, s * 0.07, s * 0.86, s * 0.86);
    g.beginPath(); g.moveTo(s * 0.2, s * 0.2); g.lineTo(s * 0.8, s * 0.8); g.moveTo(s * 0.8, s * 0.2); g.lineTo(s * 0.2, s * 0.8); g.stroke();
  },
  // yellow and black hazard stripes
  (g: CanvasRenderingContext2D, s: number) => {
    g.fillStyle = '#e8c21a'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#151515';
    for (let i = -s; i < s * 2; i += s * 0.3) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s * 0.15, 0); g.lineTo(i + s * 0.15 - s, s); g.lineTo(i - s, s); g.closePath(); g.fill(); }
  },
];

let signMats: THREE.MeshBasicMaterial[] | null = null;
const signMaterial = (i: number): THREE.MeshBasicMaterial => {
  signMats ??= SIGNS.map((draw) => shared(new THREE.MeshBasicMaterial({ map: canvasTexture(128, draw), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, fog: true })));
  return signMats[i % signMats.length];
};

let fenceMat: THREE.MeshBasicMaterial | null = null;
const fenceMaterial = (): THREE.MeshBasicMaterial => fenceMat ??= shared(new THREE.MeshBasicMaterial({
  map: canvasTexture(64, (g, s) => {
    g.strokeStyle = '#4a5733'; g.lineWidth = 3;
    for (let i = -s; i <= s * 2; i += s / 2) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.moveTo(i + s, 0); g.lineTo(i, s); g.stroke(); }
  }, [6, 1]),
  transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
}));

let stripeMat: THREE.MeshStandardMaterial | null = null;
const stripeMaterial = (): THREE.MeshStandardMaterial => stripeMat ??= shared(new THREE.MeshStandardMaterial({
  map: canvasTexture(64, (g, s) => { for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#f2f2f2' : '#c21818'; g.fillRect(i * s / 4, 0, s / 4, s); } }, [6, 1]), roughness: 0.7,
}));

/** everything a prop needs to fall apart: where the flung pieces go, and the dust and sparks that go with it */
export interface SceneryEnv { wreck: Wreckage; dust: Dust; fx: () => Fx }

const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  m.userData.restY = Math.min(w, h, d) / 2;
  return m;
};

const tmpV = new THREE.Vector3();
const tmpBox = new THREE.Box3();

/** One roadside thing: some parts, a hit box and an amount of punishment it takes before it comes apart. */
export class Scenery {
  readonly group = new THREE.Group();
  gone = false;
  /** world-space bounds (the hit box) */
  readonly bounds = new THREE.Box3();
  private readonly metal: boolean;
  /** a structure of loose blocks: damage knocks out the blocks near the hit and the rest stands until the whole is spent */
  private readonly partial: boolean;
  /** where each block of a loose structure stands, found when first needed (they do not move until they are thrown off) */
  private readonly partBoxes = new Map<THREE.Object3D, THREE.Box3>();

  /**
   * @param half half extents of its hit box (before turning)
   * @param hp hits it takes; a bullet does 1 (a fence or a sign falls to one), a shell much more, the mech walking through it 40 a second
   */
  constructor(readonly kind: string, x: number, z: number, rotY: number, half: THREE.Vector3, private hp: number, parts: THREE.Object3D[], private readonly env: SceneryEnv, metal = false, partial = false) {
    this.metal = metal;
    this.partial = partial;
    const y = terrainHeight(x, z);
    this.group.position.set(x, y, z);
    this.group.rotation.y = rotY;
    this.group.add(...parts);
    const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
    const hx = half.x * c + half.z * s, hz = half.x * s + half.z * c;
    this.bounds.set(new THREE.Vector3(x - hx, y, z - hz), new THREE.Vector3(x + hx, y + half.y * 2, z + hz));
  }

  /** where a ray meets it (distance, point in `out`), or Infinity. A structure of loose blocks is hit where a block really is: shots pass through the holes. */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    if (this.gone || !ray.intersectBox(this.bounds, tmpV)) return Infinity;
    if (!this.partial) { out.copy(tmpV); return tmpV.distanceTo(ray.origin); }
    this.group.updateMatrixWorld(true);
    let best = Infinity;
    for (const part of this.group.children) {
      let box = this.partBoxes.get(part);
      if (!box) { box = new THREE.Box3().setFromObject(part); this.partBoxes.set(part, box); }
      if (ray.intersectBox(box, tmpV)) {
        const t = tmpV.distanceTo(ray.origin);
        if (t < best) { best = t; out.copy(tmpV); }
      }
    }
    return best;
  }

  /** how far a point is from it (0 inside) */
  distanceTo(p: THREE.Vector3): number { return this.bounds.distanceToPoint(p); }

  /** take `n` of punishment from `from`; it comes apart when it has no more to take */
  damage(n: number, from: THREE.Vector3): void {
    if (this.gone) return;
    this.hp -= n;
    if (this.hp <= 0) { this.breakUp(from); return; }
    if (!this.partial) return;
    // loose blocks: those near the hit come off (a bullet knocks out a few, a shell takes whole sections)
    this.group.updateMatrixWorld(true);
    const reach = 0.6 + 0.06 * n;      // (the hit box stands a little off the brickwork)
    let knocked = 0;
    for (const part of [...this.group.children]) {
      if (part.getWorldPosition(tmpV).distanceTo(from) > reach) continue;
      this.throwOff(part, from);
      knocked++;
    }
    if (knocked > 0) {
      this.env.dust.puff(from, 1 + Math.min(4, knocked), 0.2, 1.2);
      this.collapseUnsupported();
      if (this.group.children.length <= 6) this.breakUp(from);        // all that is left is a few odd pieces: down they come
    }
  }

  /** whatever has nothing left under it falls: a brick with no brick below, a roof slab with the walls gone from under it */
  private collapseUnsupported(): void {
    for (let pass = 0; pass < 6; pass++) {
      const bricks = this.group.children.filter((c) => c.userData.course !== undefined);
      const fall: THREE.Object3D[] = [];
      for (const part of this.group.children) {
        const course = part.userData.course as number | undefined;
        if (course === undefined || course === 0) continue;              // not a brick, or on the ground
        if (course === -1) {                                              // a roof slab: held by walls under it (three bricks near enough)
          const near = bricks.filter((b) => b.userData.course === 3 && Math.abs(b.position.x - part.position.x) < 0.7 && Math.abs(b.position.z - part.position.z) < 1.2).length;
          if (near < 3) fall.push(part);
          continue;
        }
        const held = bricks.some((b) => b.userData.course === course - 1 && Math.abs(b.position.z - part.position.z) < 0.2
          && Math.abs(b.position.x - part.position.x) < (part.userData.span ? 1.3 : 0.2));
        if (!held) fall.push(part);
      }
      if (fall.length === 0) return;
      this.group.updateMatrixWorld(true);
      for (const part of fall) {
        const at = part.getWorldPosition(tmpV);
        this.throwOff(part, new THREE.Vector3(at.x + (Math.random() - 0.5) * 0.3, at.y, at.z + (Math.random() - 0.5) * 0.3), 0.4);
      }
    }
  }

  /** one piece comes off and flies away from `from` */
  private throwOff(part: THREE.Object3D, from: THREE.Vector3, gentle = 1): void {
    this.partBoxes.delete(part);
    const at = part.getWorldPosition(tmpV);
    const away = new THREE.Vector3(at.x - from.x, 0, at.z - from.z);
    if (away.lengthSq() < 1e-4) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    const speed = (1.5 + Math.random() * 3) * gentle;
    const vel = new THREE.Vector3(away.x * speed, (1.5 + Math.random() * 2.5) * gentle, away.z * speed);
    const spin = new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9).multiplyScalar(gentle);
    this.env.wreck.fling(part, vel, spin, (part.userData.restY as number | undefined) ?? 0.05);
  }

  private breakUp(from: THREE.Vector3): void {
    this.gone = true;
    const { dust } = this.env;
    this.group.updateMatrixWorld(true);
    const centre = this.bounds.getCenter(new THREE.Vector3());
    for (const part of [...this.group.children]) this.throwOff(part, from);
    const size = tmpBox.copy(this.bounds).getSize(new THREE.Vector3());
    dust.puff(centre, 3 + Math.round(size.x * size.y * 2), 0.25 + 0.2 * Math.max(size.y, 0.4), 1.4);
    if (this.metal) this.env.fx().sparks(centre, 8, 3, [0xffd080, 0xffffff]);
    this.group.removeFromParent();
  }
}

// ---- the catalogue ----

type Make = (x: number, z: number, rotY: number, env: SceneryEnv) => Scenery;

/** a length of chain-link on posts */
export const fence: Make = (x, z, rotY, env) => {
  const len = 3;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.5), fenceMaterial());
  mesh.position.y = 0.34;
  mesh.userData.restY = 0.02;
  const rail = box(len, 0.025, 0.025, POST, 0, 0.62, 0);
  return new Scenery('fence', x, z, rotY, new THREE.Vector3(len / 2, 0.33, 0.1), 1, [
    mesh, rail, box(0.05, 0.66, 0.05, POST, -len / 2 + 0.03, 0.33, 0), box(0.05, 0.66, 0.05, POST, len / 2 - 0.03, 0.33, 0), box(0.04, 0.6, 0.04, POST, 0, 0.3, 0),
  ], env, true);
};

/** a sign on a pole; `kind` picks the symbol */
export const signpost = (kind: number): Make => (x, z, rotY, env) => {
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), signMaterial(kind));
  sign.position.set(0, 0.95, 0.03);
  sign.userData.restY = 0.02;
  return new Scenery('sign', x, z, rotY, new THREE.Vector3(0.22, 0.58, 0.08), 2, [box(0.04, 1.0, 0.04, POST, 0, 0.5, 0), sign, box(0.46, 0.46, 0.015, STEEL, 0, 0.95, 0)], env, true);
};

/** a concrete roadblock: the sloped "jersey" barrier */
export const jerseyBarrier: Make = (x, z, rotY, env) => new Scenery('barrier', x, z, rotY, new THREE.Vector3(0.62, 0.19, 0.2), 40, [
  box(1.24, 0.14, 0.42, CONCRETE, 0, 0.07, 0),
  box(1.2, 0.14, 0.3, CONCRETE, 0, 0.21, 0),
  box(1.16, 0.12, 0.18, CONCRETE_DARK, 0, 0.34, 0),
  box(1.0, 0.03, 0.2, new THREE.MeshStandardMaterial({ color: 0xc21818, roughness: 0.8 }), 0, 0.41, 0),
], env);

/** a low wall of sandbags, `len` bags long and three rows high */
export const sandbagWall = (len: number): Make => (x, z, rotY, env) => {
  const parts: THREE.Object3D[] = [];
  const rng = mulberry32(Math.floor(x * 31 + z * 17));
  for (let row = 0; row < 3; row++) {
    const n = len - (row === 2 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const bag = box(0.34, 0.11, 0.2, rng() < 0.5 ? SANDBAG : SANDBAG_DARK, (i - (n - 1) / 2) * 0.33 + (row % 2) * 0.06, 0.055 + row * 0.1, (rng() - 0.5) * 0.03);
      bag.rotation.y = (rng() - 0.5) * 0.12;
      parts.push(bag);
    }
  }
  return new Scenery('sandbags', x, z, rotY, new THREE.Vector3(len * 0.17, 0.16, 0.12), 12, parts, env);
};

/** a "hedgehog" of three crossed steel beams */
export const tankTrap: Make = (x, z, rotY, env) => {
  const beam = (rx: number, ry: number, rz: number): THREE.Mesh => {
    const b = box(0.07, 0.62, 0.07, STEEL, 0, 0.26, 0);
    b.rotation.set(rx, ry, rz);
    b.userData.restY = 0.04;
    return b;
  };
  return new Scenery('trap', x, z, rotY, new THREE.Vector3(0.3, 0.28, 0.3), 25, [beam(0.9, 0, 0.5), beam(-0.9, 0.8, 0.5), beam(0.2, 1.6, -0.9)], env, true);
};

/**
 * A guardhouse laid up of loose blocks: courses of bricks round a door and a window, a roof of slabs, a lamp over the door and sandbags
 * banked in front. It comes apart a piece at a time: bullets knock blocks off, a shell takes a section of wall, and what is left falls
 * when the rest is spent.
 */
export const guardhouse: Make = (x, z, rotY, env) => {
  const B = 0.4, nx = 6, ny = 4, nz = 4;
  const rng = mulberry32(Math.floor(x * 7 + z * 11));
  const parts: THREE.Object3D[] = [];
  const brick = (px: number, py: number, pz: number, span = false): void => {
    const m = box(B * 0.98, B * 0.98, B * 0.98, BRICKS[Math.floor(rng() * BRICKS.length)], px, py, pz);
    m.rotation.y = (rng() - 0.5) * 0.02;
    m.userData.course = Math.round(py / B - 0.5);                          // which course of bricks it is in (0 = on the ground)
    m.userData.span = span;                                                // a lintel over the door or the window: held by the walls at its sides
    parts.push(m);
  };
  for (let y = 0; y < ny; y++) {
    const py = (y + 0.5) * B;
    for (let i = 0; i < nx; i++) {
      const px = (i - (nx - 1) / 2) * B;
      const door = (i === 1 || i === 2) && y < 3, window = i === 4 && (y === 1 || y === 2);
      if (!door && !window) brick(px, py, (nz / 2 - 0.5) * B, y === 3 && (i === 1 || i === 2 || i === 4));                    // the front (the bricks above the door and window are lintels)
      brick(px, py, -(nz / 2 - 0.5) * B);                                          // the back
    }
    for (let k = 1; k < nz - 1; k++) {
      const pz = (k - (nz - 1) / 2) * B;
      brick(-(nx / 2 - 0.5) * B, py, pz);
      brick((nx / 2 - 0.5) * B, py, pz);                                           // the sides
    }
  }
  const front = nz * B / 2 - 0.5 * B + B * 0.5 - 0.02;
  parts.push(box(2 * B, 3 * B, 0.04, GLASS, -0.5 * B, 1.5 * B, front - 0.1));      // the door, dark in its opening
  parts.push(box(B, 2 * B, 0.04, GLASS, 2 * B, 1.5 * B, front - 0.1));             // the window
  parts.push(box(0.14, 0.09, 0.1, LAMP, -0.5 * B, 3 * B + 0.12, front + 0.05));
  for (let i = 0; i < 3; i++) {
    const slab = box(nx * B * 0.36, 0.1, nz * B * 1.06, ROOF, (i - 1) * nx * B * 0.34, ny * B + 0.05, 0);   // the roof, in three slabs
    slab.userData.course = -1;
    parts.push(slab);
  }
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 5 - row; i++) parts.push(box(0.34, 0.11, 0.2, rng() < 0.5 ? SANDBAG : SANDBAG_DARK, (i - (4 - row) / 2) * 0.33 + 0.5, 0.055 + row * 0.1, front + 0.32));
  }
  return new Scenery('guardhouse', x, z, rotY, new THREE.Vector3(nx * B / 2, (ny * B + 0.1) / 2, nz * B / 2 + 0.2), 90, parts, env, false, true);
};

/** a barrier gate: a booth at the side of the road and a red-and-white arm lowered across it (`reach` along z) */
export const barrierGate = (reach: number): Make => (x, z, rotY, env) => {
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, reach), stripeMaterial());
  arm.position.set(0, 0.62, 0);
  arm.castShadow = true;
  arm.userData.restY = 0.03;
  return new Scenery('gate', x, z, rotY, new THREE.Vector3(0.3, 0.3, reach / 2), 6, [
    box(0.5, 0.85, 0.5, KHAKI, 0, 0.42, reach / 2 + 0.2),
    box(0.58, 0.07, 0.58, ROOF, 0, 0.88, reach / 2 + 0.2),
    arm,
  ], env);
};

// ---- laying them out along the road ----

export interface RoadLayout {
  /** the door, and where the road lies across the street */
  doorX: number; zc: number; halfWidth: number;
  /** how far back from the door the roadside runs */
  reach: number;
}

/** what a chunk's roadside is: the sceneries, and (they are ordinary explosive barrels) where the drums stand */
export interface Roadside { scenery: Scenery[]; drums: THREE.Vector3[] }

/**
 * Lay the roadside across x in [x0, x1]: chain-link along the far edge, warning signs now and then, a guardhouse behind the
 * road with sandbags and drums, a chicane of concrete roadblocks across it, and nearer the door tank traps, a barrier gate and
 * a second guardhouse. Seeded by position, so it is the same every time.
 */
export function roadside(x0: number, x1: number, road: RoadLayout, env: SceneryEnv): Roadside {
  const out: Roadside = { scenery: [], drums: [] };
  const { doorX, zc, halfWidth, reach } = road;
  const from = Math.max(x0, doorX + 6), to = Math.min(x1, doorX + reach);
  if (from >= to) return out;
  const back = zc - halfWidth - 1.0, front = zc + halfWidth - 0.2;      // the far edge of the road (behind the dry-stone wall and the infantry's ground) and the near one
  const add = (s: Scenery): void => { out.scenery.push(s); };
  const rngAt = (x: number): (() => number) => mulberry32(Math.floor(x * 13));

  // chain-link along the far edge of the road (the near edge is left open: a fence there would stand between the camera and the fight),
  // here and there gone or leaning
  for (let x = Math.ceil(from / 3) * 3; x < to; x += 3) {
    const rng = rngAt(x);
    if (rng() < 0.12) continue;
    add(fence(x, back, (rng() - 0.5) * 0.14, env));
  }
  // warning signs on the camera side of the road, every so often
  let k = 0;
  for (let x = Math.ceil(from / 26) * 26 + 9; x < to; x += 26, k++) add(signpost(k)(x, front + 0.5, (k % 2 ? 0.2 : -0.2), env));
  // roadblock chicanes: three barriers staggered across the street, with room between to get through
  for (let x = Math.ceil((from - 5) / 38) * 38 + 5; x < to - 8; x += 38) {
    if (x < doorX + 14) continue;
    add(jerseyBarrier(x, zc - 2.4, 0.1, env));
    add(jerseyBarrier(x - 2.6, zc - 0.2, -0.12, env));
    add(jerseyBarrier(x - 5.2, zc + 1.9, 0.08, env));
    add(sandbagWall(5)(x + 3, zc - 9.2, 0, env));
  }
  // guardhouses behind the road, of loose blocks, with sandbags and drums beside them
  for (const gx of [doorX + 52, doorX + 20]) {
    if (gx < from - 3 || gx > to + 3) continue;
    const gz = zc - halfWidth - 2.4;
    add(guardhouse(gx, gz, 0, env));
    add(sandbagWall(4)(gx + 2.4, gz - 0.1, 0.15, env));
    out.drums.push(new THREE.Vector3(gx - 1.9, 0, gz + 0.6), new THREE.Vector3(gx - 2.2, 0, gz + 0.2));
  }
  // by the door: tank traps, the barrier gate and a last roadblock
  const near = (x: number): boolean => x >= from && x <= to;
  if (near(doorX + 14)) add(barrierGate(5.8)(doorX + 14, zc - 1.1, 0, env));
  for (const [dx, dz] of [[9, -2.5], [10.5, 1.8], [8, 4.2]] as const) if (near(doorX + dx)) add(tankTrap(doorX + dx, zc + dz, dx, env));
  if (near(doorX + 7)) add(jerseyBarrier(doorX + 7, zc - 0.6, 0.05, env));
  return out;
}
