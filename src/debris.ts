import * as THREE from 'three';
import { swapRemove } from './util';
import type { Dust } from './dust';
import { Batch, SHAPES, pickShape, randomDims } from './rubble';

/** Surface height under a point; used so chunks land on whatever is still standing. */
export type FloorFn = (x: number, z: number, yBelow: number) => number;

/** A kinematic sphere (mech foot/knee/body) that shoves rubble. */
export interface Collider { pos: THREE.Vector3; vel: THREE.Vector3; r: number }

/** Rubble a soldier cannot step over: big chunks whose bottom is within the soldier's height. */
export interface Blocker { x: number; z: number; r: number }
const BLOCK_SIZE = 0.16;
const BLOCK_TOP = 0.25;

const MAX_CHUNKS = 10000;
/** Rubble falls at half the normal pull, so heavy pieces drop slowly and ponderously. */
const GRAVITY = 8;
const GRID = 0.6;            // spatial hash cell size (> largest chunk diameter)
const RESTITUTION = 0.15;   // heavy things barely bounce
const SLEEP_SPEED = 0.22;    // below this (units/s) for SLEEP_TIME the chunk goes to sleep
const SLEEP_TIME = 0.4;
const MAX_AWAKE_TIME = 6;    // force sleep so a jittering pile can't cost CPU forever
const WAKE_IMPACT = 2.0;     // a moving chunk must hit a sleeper this hard to wake it
/** Chunks bigger than this can crush things they hit while moving fast. */
const LETHAL_SIZE = 0.2;
const LETHAL_SPEED = 1.2;

interface Chunk {
  /** global id (registry, pair ordering, audit, culling) */
  slot: number;
  /** which shape batch, and the instance index within it */
  shape: number;
  inst: number;
  /** non-uniform proportions (product ~ 1), so pieces come as slabs, beams, blocks and lumps */
  dims: THREE.Vector3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  size: number;
  r: number;
  floor: FloorFn | null;
  /** a visible model driven by this chunk's physics instead of an instanced shape (a wrecked vehicle section) */
  body?: THREE.Object3D;
  asleep: boolean;
  sleepT: number;
  awakeT: number;
  key: number;
}

const cellKey = (ix: number, iy: number, iz: number): number =>
  ((ix + 4096) * 256 + (iz + 128)) * 128 + Math.max(0, Math.min(127, iy));

/**
 * Rubble: lightweight rigid-ish bodies (spheres standing in for pieces of every shape and proportion),
 * drawn as one InstancedMesh per shape. Chunks fall, bounce and settle, then sleep for free. Sleeping chunks
 * sit in a spatial hash and are woken by the mech's kinematic colliders, by hard impacts, or when the
 * structure under them is destroyed. Nothing despawns by age; only distance culling and a hard cap.
 */
export class Debris {
  private slots: (Chunk | null)[] = [];
  private free: number[] = [];
  private high = 0;
  private awake: Chunk[] = [];
  private sleepGrid = new Map<number, Chunk[]>();
  private awakeGrid = new Map<number, Chunk[]>();
  private batches: Batch[] = [];
  private dummy = new THREE.Object3D();
  private auditIdx = 0;
  private tmp = new THREE.Vector3();
  private n = new THREE.Vector3();
  private colliders: Collider[] = [];
  /** called every frame for each fast-moving big chunk (crush check) */
  onContact: ((pos: THREE.Vector3, size: number) => void) | null = null;

  constructor(scene: THREE.Scene, private dust: Dust) {
    // flat-shaded so the broken pieces look faceted; one material for every shape
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
    this.batches = SHAPES.map((g) => new Batch(scene, g, material, MAX_CHUNKS));
  }

  get count(): number { return this.high - this.free.length; }
  get awakeCount(): number { return this.awake.length; }

  setColliders(list: Collider[]): void { this.colliders = list; }

  /** @param floor optional surface lookup (remaining structure); the ground (y = 0) always applies */
  spawn(pos: THREE.Vector3, color: THREE.Color, size: number, vel: THREE.Vector3, floor: FloorFn | null = null): void {
    let slot: number;
    if (this.free.length > 0) slot = this.free.pop()!;
    else if (this.high < MAX_CHUNKS) slot = this.high++;
    else return;
    const shape = pickShape();
    const c: Chunk = {
      slot, shape, inst: this.batches[shape].alloc(), dims: randomDims(),
      pos: pos.clone(), vel: vel.clone(),
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      angVel: new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4), // slow tumbling
      size, r: size * 0.5, floor, asleep: false, sleepT: 0, awakeT: 0, key: 0,
    };
    this.slots[slot] = c;
    this.awake.push(c);
    this.batches[shape].setColor(c.inst, color);
    this.write(c);
  }

  /**
   * Add a rigid body that is drawn by `model` (already in the scene, positioned where the body's centre is) instead of
   * an instanced shape: it falls, is shoved by the mech and by shockwaves, counts as rubble for the mech's slowdown, as
   * cover for soldiers and as an obstacle to bullets, and stays put for good once it settles. A sphere of diameter
   * `size` stands in for it, and it is kept upright.
   * @param model its origin is the body's centre; position/rotation are overwritten every step
   */
  spawnBody(model: THREE.Object3D, size: number, vel: THREE.Vector3, floor: FloorFn | null = null): void {
    let slot: number;
    if (this.free.length > 0) slot = this.free.pop()!;
    else if (this.high < MAX_CHUNKS) slot = this.high++;
    else return;
    const c: Chunk = {
      slot, shape: -1, inst: -1, dims: new THREE.Vector3(1, 1, 1),
      pos: model.position.clone(), vel: vel.clone(), rot: model.rotation.clone(), angVel: new THREE.Vector3(),
      size, r: size * 0.5, floor, body: model, asleep: false, sleepT: 0, awakeT: 0, key: 0,
    };
    this.slots[slot] = c;
    this.awake.push(c);
    this.write(c);
  }

  /** Wake sleeping chunks within `radius` of a point (e.g. the cell under them was destroyed). */
  wakeNear(at: THREE.Vector3, radius: number): void {
    this.forEachNear(this.sleepGrid, at.x, at.y, at.z, radius, (c) => {
      if (c.pos.distanceToSquared(at) < (radius + c.r) * (radius + c.r)) this.wake(c);
    });
  }

  /** How congested the ground is around (x, z): sum of chunk "bulk" below maxY. */
  density(x: number, z: number, radius: number, maxY: number): number {
    let sum = 0;
    const visit = (c: Chunk) => {
      if (c.pos.y > maxY || Math.abs(c.pos.x - x) > radius || Math.abs(c.pos.z - z) > radius) return;
      sum += (c.size / 0.36) ** 2;
    };
    this.forEachNearBox(this.sleepGrid, x - radius, 0, z - radius, x + radius, maxY, z + radius, visit);
    this.forEachNearBox(this.awakeGrid, x - radius, 0, z - radius, x + radius, maxY, z + radius, visit);
    return sum;
  }

  /**
   * Collect chunks near (x, z) that block ground units into `out` (entries are reused).
   * @returns how many were written (capped at out.length)
   */
  collectBlockers(x: number, z: number, radius: number, out: Blocker[]): number {
    let n = 0;
    const ax = Math.floor((x - radius) / GRID), bx = Math.floor((x + radius) / GRID);
    const az = Math.floor((z - radius) / GRID), bz = Math.floor((z + radius) / GRID);
    const yTop = Math.floor((BLOCK_TOP + 0.3) / GRID);
    for (const grid of [this.sleepGrid, this.awakeGrid]) {
      for (let ix = ax; ix <= bx; ix++) {
        for (let iz = az; iz <= bz; iz++) {
          for (let iy = 0; iy <= yTop; iy++) {
            const b = grid.get(cellKey(ix, iy, iz));
            if (!b) continue;
            for (const c of b) {
              if (c.size < BLOCK_SIZE || c.pos.y - c.r > BLOCK_TOP) continue;
              if (n >= out.length) return n;
              const o = out[n++];
              o.x = c.pos.x; o.z = c.pos.z; o.r = c.r;
            }
          }
        }
      }
    }
    return n;
  }

  /**
   * Does the segment a -> b run into a chunk? Writes the entry point to `out`.
   * Chunks within `endSlack` of the end are ignored (a target standing next to rubble).
   */
  segmentHit(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3, endSlack = 0.12): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    const len = Math.sqrt(len2);
    if (len < 1e-4) return false;
    const steps = Math.max(1, Math.ceil(len / (GRID * 0.5)));
    let best = Infinity, lastK = -1;
    for (let st = 0; st <= steps; st++) {
      const t = st / steps;
      const ix = Math.floor((a.x + dx * t) / GRID), iy = Math.floor((a.y + dy * t) / GRID), iz = Math.floor((a.z + dz * t) / GRID);
      const centre = cellKey(ix, iy, iz);
      if (centre === lastK) continue;
      lastK = centre;
      for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) for (let gz = -1; gz <= 1; gz++) {
        const k = cellKey(ix + gx, iy + gy, iz + gz);
        for (const grid of [this.sleepGrid, this.awakeGrid]) {
          const bucket = grid.get(k);
          if (!bucket) continue;
          for (const c of bucket) {
            const ox = c.pos.x - a.x, oy = c.pos.y - a.y, oz = c.pos.z - a.z;
            const tc = Math.min(1, Math.max(0, (ox * dx + oy * dy + oz * dz) / len2));
            const qx = dx * tc - ox, qy = dy * tc - oy, qz = dz * tc - oz;
            const R = c.r * 1.1;
            const d2 = qx * qx + qy * qy + qz * qz;
            if (d2 > R * R) continue;
            const entry = Math.max(0, tc - Math.sqrt(R * R - d2) / len);
            if ((1 - entry) * len < endSlack) continue;
            if (entry < best) best = entry;
          }
        }
      }
    }
    if (best === Infinity) return false;
    out.set(a.x + dx * best, a.y + dy * best, a.z + dz * best);
    return true;
  }

  /** Knock chunks near a point along dir (a bullet striking rubble). */
  kick(at: THREE.Vector3, dir: THREE.Vector3, speed: number): void {
    const apply = (c: Chunk) => {
      const lim = c.r + 0.1;
      if (c.pos.distanceToSquared(at) < lim * lim) { this.wake(c); c.vel.addScaledVector(dir, speed); }
    };
    this.forEachNear(this.sleepGrid, at.x, at.y, at.z, 0.4, apply);
    this.forEachNear(this.awakeGrid, at.x, at.y, at.z, 0.4, apply);
  }

  /**
   * Shockwave: shoves every chunk within `radius` away from `at`, hardest at the centre, with an upward lift
   * and a random tumble. Small pieces fly farther than big slabs. Sleeping chunks are woken.
   */
  blast(at: THREE.Vector3, radius: number, speed: number): void {
    const push = (c: Chunk) => {
      const dx = c.pos.x - at.x, dy = c.pos.y - at.y, dz = c.pos.z - at.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= radius) return;
      const k = (speed * (1 - d / radius)) / (1 + c.size * 4);
      const inv = d > 1e-3 ? 1 / d : 0;
      this.wake(c);
      c.vel.x += dx * inv * k;
      c.vel.y += dy * inv * k + k * 0.6;
      c.vel.z += dz * inv * k;
      c.angVel.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    };
    this.forEachNear(this.sleepGrid, at.x, at.y, at.z, radius, push);
    this.forEachNear(this.awakeGrid, at.x, at.y, at.z, radius, push);
  }

  /** Drop chunks that are far outside [minX, maxX] (the rails never go back). */
  cull(minX: number, maxX: number): void {
    for (const c of this.slots) if (c && (c.pos.x < minX || c.pos.x > maxX)) this.remove(c);
  }

  update(dt: number): void {
    // mech kinematic colliders wake and shove nearby sleepers
    for (const col of this.colliders) {
      this.forEachNear(this.sleepGrid, col.pos.x, col.pos.y, col.pos.z, col.r + 0.3, (c) => {
        const lim = col.r + c.r + 0.05;
        if (c.pos.distanceToSquared(col.pos) < lim * lim) this.wake(c);
      });
    }

    this.audit();

    this.awakeGrid.clear();
    for (const c of this.awake) this.gridAdd(this.awakeGrid, c);

    for (let i = this.awake.length - 1; i >= 0; i--) {
      if (i >= this.awake.length) continue;
      const c = this.awake[i];
      if (this.step(c, dt)) {
        this.sleep(c, i);
      }
    }

    for (const batch of this.batches) batch.flush();
  }

  // ---- simulation ------------------------------------------------------------------------

  /** @returns true if the chunk should go to sleep */
  private step(c: Chunk, dt: number): boolean {
    const r = c.r;
    const surface = Math.max(0, c.floor ? c.floor(c.pos.x, c.pos.z, c.pos.y - r) : 0);
    c.vel.y -= GRAVITY * dt;
    c.pos.addScaledVector(c.vel, dt);
    if (c.body) { c.angVel.set(0, 0, 0); c.rot.x = c.rot.z = 0; }   // wrecks stay upright
    c.rot.x += c.angVel.x * dt; c.rot.y += c.angVel.y * dt; c.rot.z += c.angVel.z * dt;
    let grounded = false;

    if (c.pos.y - r <= surface) {
      c.pos.y = surface + r;
      const impact = -c.vel.y;
      if (impact > 2.2) this.dust.puff(this.tmp.set(c.pos.x, surface + 0.1, c.pos.z), 1, c.size * 1.5, 1);
      c.vel.y = impact > 1.1 ? impact * RESTITUTION : 0;
      // ground friction: heavy wrecks (rigid bodies) keep sliding noticeably further than loose rubble
      const f = Math.max(0, 1 - (c.body ? 2.5 : 8) * dt);
      c.vel.x *= f; c.vel.z *= f;
      c.angVel.multiplyScalar(Math.max(0, 1 - 6 * dt));
      grounded = true;
    }

    // mech feet / legs / body
    for (const col of this.colliders) {
      const n = this.n.subVectors(c.pos, col.pos);
      const lim = c.r + col.r;
      const d2 = n.lengthSq();
      if (d2 >= lim * lim) continue;
      const d = Math.sqrt(d2) || 1e-4;
      n.multiplyScalar(1 / d);
      c.pos.addScaledVector(n, lim - d);
      const vn = (c.vel.x - col.vel.x) * n.x + (c.vel.y - col.vel.y) * n.y + (c.vel.z - col.vel.z) * n.z;
      if (vn < 0) c.vel.addScaledVector(n, -(1 + 0.3) * vn);
      c.vel.x += col.vel.x * 0.15; c.vel.z += col.vel.z * 0.15; // drag along with the foot
      c.angVel.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
    }

    // other chunks (only resting ON a sleeper counts as support)
    const rested = this.collideChunks(c);

    if (this.onContact && c.size >= LETHAL_SIZE && c.vel.lengthSq() > LETHAL_SPEED * LETHAL_SPEED) {
      this.onContact(c.pos, c.size);
    }

    this.write(c);

    c.awakeT += dt;
    const slow = c.vel.lengthSq() < SLEEP_SPEED * SLEEP_SPEED && c.angVel.lengthSq() < 4;
    // a chunk may only sleep when something is actually holding it up: ground, structure or a chunk below
    if (slow && (grounded || rested || c.pos.y - r <= surface + 0.02)) c.sleepT += dt; else c.sleepT = 0;
    return c.sleepT >= SLEEP_TIME || c.awakeT > MAX_AWAKE_TIME;
  }

  private collideChunks(c: Chunk): boolean {
    let rested = false;
    const ix = Math.floor(c.pos.x / GRID), iy = Math.floor(c.pos.y / GRID), iz = Math.floor(c.pos.z / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = cellKey(ix + dx, iy + dy, iz + dz);
          if (this.collideBucket(c, this.sleepGrid.get(k))) rested = true;
          this.collideBucket(c, this.awakeGrid.get(k));
        }
      }
    }
    return rested;
  }

  private collideBucket(c: Chunk, bucket: Chunk[] | undefined): boolean {
    let rested = false;
    if (!bucket) return false;
    for (let bi = bucket.length - 1; bi >= 0; bi--) {
      if (bi >= bucket.length) continue; // waking a sleeper (and the ones resting on it) shrinks this bucket
      const o = bucket[bi];
      if (o === c) continue;
      const lim = c.r + o.r;
      const n = this.n.subVectors(c.pos, o.pos);
      const d2 = n.lengthSq();
      if (d2 >= lim * lim) continue;
      const d = Math.sqrt(d2) || 1e-4;
      if (d2 < 1e-8) n.set(0, 1, 0); else n.multiplyScalar(1 / d);
      const overlap = lim - d;
      const vn = c.vel.x * n.x + c.vel.y * n.y + c.vel.z * n.z;
      if (o.asleep) {
        c.pos.addScaledVector(n, overlap);
        if (vn < 0) {
          if (-vn > WAKE_IMPACT) {
            // hard hit: wake the sleeper and hand it half the momentum
            this.wake(o);
            o.vel.addScaledVector(n, vn * 0.5);
            c.vel.addScaledVector(n, -(1 + RESTITUTION) * vn * 0.5);
          } else {
            c.vel.addScaledVector(n, -(1 + RESTITUTION * 0.5) * vn);
          }
        }
        c.vel.x *= 0.96; c.vel.z *= 0.96;
        if (n.y > 0.45) rested = true; // supported only if the sleeper is underneath
      } else if (c.slot < o.slot) {
        // pair of awake chunks: split the correction, exchange the normal velocity
        c.pos.addScaledVector(n, overlap * 0.5);
        o.pos.addScaledVector(n, -overlap * 0.5);
        const vrel = (c.vel.x - o.vel.x) * n.x + (c.vel.y - o.vel.y) * n.y + (c.vel.z - o.vel.z) * n.z;
        if (vrel < 0) {
          const j = -(1 + RESTITUTION) * vrel * 0.5;
          c.vel.addScaledVector(n, j);
          o.vel.addScaledVector(n, -j);
        }
      }
    }
    return rested;
  }

  // ---- bookkeeping -----------------------------------------------------------------------

  private write(c: Chunk): void {
    if (c.body) {
      c.body.position.copy(c.pos);
      c.body.rotation.copy(c.rot);
      return;
    }
    this.dummy.position.copy(c.pos);
    this.dummy.rotation.copy(c.rot);
    this.dummy.scale.set(c.size * c.dims.x, c.size * c.dims.y, c.size * c.dims.z);
    this.dummy.updateMatrix();
    this.batches[c.shape].setMatrix(c.inst, this.dummy.matrix);
  }

  private gridAdd(grid: Map<number, Chunk[]>, c: Chunk): number {
    const k = cellKey(Math.floor(c.pos.x / GRID), Math.floor(c.pos.y / GRID), Math.floor(c.pos.z / GRID));
    const b = grid.get(k);
    if (b) b.push(c); else grid.set(k, [c]);
    return k;
  }

  private sleep(c: Chunk, awakeIndex: number): void {
    swapRemove(this.awake, awakeIndex);
    c.rot.set(0, c.rot.y, 0); // lie flat
    // resting on the ground or the structure: sit at the piece's real half-height, not its bounding sphere's
    const surface = Math.max(0, c.floor ? c.floor(c.pos.x, c.pos.z, c.pos.y - c.r + 0.02) : 0);
    if (c.pos.y - c.r <= surface + 0.06) c.pos.y = surface + Math.min((c.size * c.dims.y) / 2, c.r + 0.04);
    c.vel.set(0, 0, 0);
    c.asleep = true;
    c.key = this.gridAdd(this.sleepGrid, c);
    this.write(c);
  }

  private unbucket(b: Chunk[], c: Chunk): void {
    const i = b.indexOf(c);
    if (i >= 0) swapRemove(b, i);
    if (b.length === 0) this.sleepGrid.delete(c.key);
  }

  private wake(c: Chunk): void {
    if (!c.asleep) return;
    const b = this.sleepGrid.get(c.key);
    if (b) this.unbucket(b, c);
    c.asleep = false;
    c.sleepT = 0;
    c.awakeT = 0;
    c.angVel.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
    this.awake.push(c);
    // whatever was resting on this chunk loses its support
    const lim = c.r * 2 + 0.2;
    this.forEachNear(this.sleepGrid, c.pos.x, c.pos.y + c.r, c.pos.z, lim, (o) => {
      const reach = c.r + o.r + 0.08;
      if (o.asleep && o.pos.y > c.pos.y + 0.03 && o.pos.distanceToSquared(c.pos) < reach * reach) this.wake(o);
    });
  }

  /** Support audit: a few sleeping chunks per frame must still be held up by ground, structure or a chunk below. */
  private audit(): void {
    if (this.high === 0) return;
    let checked = 0;
    for (let n = 0; n < 160 && checked < 48; n++) {
      const c = this.slots[this.auditIdx];
      this.auditIdx = (this.auditIdx + 1) % this.high;
      if (!c || !c.asleep) continue;
      checked++;
      if (!this.supported(c)) this.wake(c);
    }
  }

  private supported(c: Chunk): boolean {
    const bottom = c.pos.y - c.r;
    const surface = Math.max(0, c.floor ? c.floor(c.pos.x, c.pos.z, bottom + 0.02) : 0);
    if (bottom <= surface + 0.06) return true;
    let held = false;
    this.forEachNear(this.sleepGrid, c.pos.x, c.pos.y, c.pos.z, c.r * 2 + 0.1, (o) => {
      if (held || o === c) return;
      const dx = c.pos.x - o.pos.x, dy = c.pos.y - o.pos.y, dz = c.pos.z - o.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      if (d < c.r + o.r + 0.08 && dy / d > 0.45) held = true;
    });
    return held;
  }

  private remove(c: Chunk): void {
    if (c.asleep) {
      const b = this.sleepGrid.get(c.key);
      if (b) this.unbucket(b, c);
    } else {
      const i = this.awake.indexOf(c);
      if (i >= 0) swapRemove(this.awake, i);
    }
    this.slots[c.slot] = null;
    this.free.push(c.slot);
    if (c.body) c.body.removeFromParent();
    else this.batches[c.shape].release(c.inst);
  }

  private forEachNear(grid: Map<number, Chunk[]>, x: number, y: number, z: number, radius: number, fn: (c: Chunk) => void): void {
    this.forEachNearBox(grid, x - radius, y - radius, z - radius, x + radius, y + radius, z + radius, fn);
  }

  private forEachNearBox(grid: Map<number, Chunk[]>, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, fn: (c: Chunk) => void): void {
    const ax = Math.floor(x0 / GRID), bx = Math.floor(x1 / GRID);
    const ay = Math.floor(Math.max(0, y0) / GRID), by = Math.floor(Math.max(0, y1) / GRID);
    const az = Math.floor(z0 / GRID), bz = Math.floor(z1 / GRID);
    for (let ix = ax; ix <= bx; ix++) {
      for (let iy = ay; iy <= by; iy++) {
        for (let iz = az; iz <= bz; iz++) {
          const b = grid.get(cellKey(ix, iy, iz));
          if (!b) continue;
          // iterate a copy: fn may wake (mutate) the bucket
          for (const c of b.slice()) fn(c);
        }
      }
    }
  }
}
