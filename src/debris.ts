import * as THREE from 'three';

const MAX_DUST = 300;

/** Soft smoke/dust puffs: one Points draw call with per-particle size and alpha. */
export class Dust {
  private max = MAX_DUST;
  private items: { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; size0: number; size1: number }[] = [];
  private geo = new THREE.BufferGeometry();
  private posAttr = new THREE.BufferAttribute(new Float32Array(MAX_DUST * 3), 3);
  private sizeAttr = new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1);
  private alphaAttr = new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1);
  private material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uScale: { value: 500 }, uColor: { value: new THREE.Color(0x6a7a88) } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aAlpha;
      uniform float uScale; varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale / -mv.z;
        vAlpha = aAlpha;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.1, d) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  private points: THREE.Points;

  constructor(scene: THREE.Scene) {
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setAttribute('aAlpha', this.alphaAttr);
    this.geo.setDrawRange(0, 0);
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** @param viewportHeightPx drawing-buffer height, @param fovDeg vertical fov */
  setViewport(viewportHeightPx: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  puff(at: THREE.Vector3, count: number, size: number, spread = 1.5): void {
    for (let i = 0; i < count && this.items.length < this.max; i++) {
      const life = 0.8 + Math.random() * 1.2;
      this.items.push({
        pos: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * size, (Math.random() - 0.5) * size, (Math.random() - 0.5) * size)),
        vel: new THREE.Vector3((Math.random() - 0.5) * spread, Math.random() * spread * 0.8, Math.random() * spread * 0.5),
        life, maxLife: life, size0: size * 0.6, size1: size * (1.8 + Math.random()),
      });
    }
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) { this.items[i] = this.items[this.items.length - 1]; this.items.pop(); continue; }
      p.vel.multiplyScalar(Math.max(0, 1 - 1.8 * dt));
      p.pos.addScaledVector(p.vel, dt);
    }
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      const k = 1 - p.life / p.maxLife;
      this.posAttr.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
      this.sizeAttr.setX(i, p.size0 + (p.size1 - p.size0) * k);
      this.alphaAttr.setX(i, 0.55 * (1 - k) * Math.min(1, k * 8));
    }
    this.geo.setDrawRange(0, this.items.length);
    this.posAttr.needsUpdate = this.sizeAttr.needsUpdate = this.alphaAttr.needsUpdate = true;
  }
}

/** Surface height under a point; used so chunks land on whatever is still standing. */
export type FloorFn = (x: number, z: number, yBelow: number) => number;

/** A kinematic sphere (mech foot/knee/body) that shoves rubble. */
export interface Collider { pos: THREE.Vector3; vel: THREE.Vector3; r: number }

/** Rubble a soldier cannot step over: big chunks whose bottom is within the soldier's height. */
export interface Blocker { x: number; z: number; r: number }
const BLOCK_SIZE = 0.16;
const BLOCK_TOP = 0.25;

const MAX_CHUNKS = 10000;
const GRAVITY = 16;
const GRID = 0.6;            // spatial hash cell size (> largest chunk diameter)
const RESTITUTION = 0.25;
const SLEEP_SPEED = 0.22;    // below this (units/s) for SLEEP_TIME the chunk goes to sleep
const SLEEP_TIME = 0.4;
const MAX_AWAKE_TIME = 6;    // force sleep so a jittering pile can't cost CPU forever
const WAKE_IMPACT = 2.0;     // a moving chunk must hit a sleeper this hard to wake it
/** Chunks bigger than this can crush things they hit while moving fast. */
const LETHAL_SIZE = 0.2;
const LETHAL_SPEED = 1.2;

interface Chunk {
  slot: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  size: number;
  r: number;
  floor: FloorFn | null;
  asleep: boolean;
  sleepT: number;
  awakeT: number;
  key: number;
}

const cellKey = (ix: number, iy: number, iz: number): number =>
  ((ix + 4096) * 256 + (iz + 128)) * 128 + Math.max(0, Math.min(127, iy));

/**
 * Rubble: lightweight rigid-ish bodies (spheres standing in for cubes) in one InstancedMesh.
 * Chunks fall, bounce and settle, then sleep for free. Sleeping chunks sit in a spatial hash
 * and are woken by the mech's kinematic colliders, by hard impacts, or when the structure
 * under them is destroyed. Nothing despawns by age; only distance culling and a hard cap.
 */
export class Debris {
  private slots: (Chunk | null)[] = [];
  private free: number[] = [];
  private high = 0;
  private awake: Chunk[] = [];
  private sleepGrid = new Map<number, Chunk[]>();
  private awakeGrid = new Map<number, Chunk[]>();
  private mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private dMin = Infinity;
  private dMax = -1;
  private colorDirty = false;
  private auditIdx = 0;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private tmp = new THREE.Vector3();
  private n = new THREE.Vector3();
  private colliders: Collider[] = [];
  /** called every frame for each fast-moving big chunk (crush check) */
  onContact: ((pos: THREE.Vector3, size: number) => void) | null = null;

  constructor(scene: THREE.Scene, private dust: Dust) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.9 }),
      MAX_CHUNKS,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
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
    const c: Chunk = {
      slot, pos: pos.clone(), vel: vel.clone(),
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      angVel: new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10),
      size, r: size * 0.5, floor, asleep: false, sleepT: 0, awakeT: 0, key: 0,
    };
    this.slots[slot] = c;
    this.awake.push(c);
    this.mesh.setColorAt(slot, color);
    this.colorDirty = true;
    this.mesh.count = this.high;
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

    if (this.dMax >= this.dMin) {
      const attr = this.mesh.instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(this.dMin * 16, (this.dMax - this.dMin + 1) * 16);
      attr.needsUpdate = true;
      this.dMin = Infinity; this.dMax = -1;
    }
    if (this.colorDirty && this.mesh.instanceColor) { this.mesh.instanceColor.needsUpdate = true; this.colorDirty = false; }
  }

  // ---- simulation ------------------------------------------------------------------------

  /** @returns true if the chunk should go to sleep */
  private step(c: Chunk, dt: number): boolean {
    const r = c.r;
    const surface = Math.max(0, c.floor ? c.floor(c.pos.x, c.pos.z, c.pos.y - r) : 0);
    c.vel.y -= GRAVITY * dt;
    c.pos.addScaledVector(c.vel, dt);
    c.rot.x += c.angVel.x * dt; c.rot.y += c.angVel.y * dt; c.rot.z += c.angVel.z * dt;
    let grounded = false;

    if (c.pos.y - r <= surface) {
      c.pos.y = surface + r;
      const impact = -c.vel.y;
      if (impact > 3) this.dust.puff(this.tmp.set(c.pos.x, surface + 0.1, c.pos.z), 1, c.size * 1.5, 1);
      c.vel.y = impact > 1.5 ? impact * RESTITUTION : 0;
      const f = Math.max(0, 1 - 8 * dt); // ground friction
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
      c.angVel.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
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
    this.dummy.position.copy(c.pos);
    this.dummy.rotation.copy(c.rot);
    this.dummy.scale.setScalar(c.size);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(c.slot, this.dummy.matrix);
    if (c.slot < this.dMin) this.dMin = c.slot;
    if (c.slot > this.dMax) this.dMax = c.slot;
  }

  private gridAdd(grid: Map<number, Chunk[]>, c: Chunk): number {
    const k = cellKey(Math.floor(c.pos.x / GRID), Math.floor(c.pos.y / GRID), Math.floor(c.pos.z / GRID));
    const b = grid.get(k);
    if (b) b.push(c); else grid.set(k, [c]);
    return k;
  }

  private sleep(c: Chunk, awakeIndex: number): void {
    const last = this.awake.length - 1;
    this.awake[awakeIndex] = this.awake[last];
    this.awake.pop();
    c.rot.set(0, c.rot.y, 0); // lie flat
    c.vel.set(0, 0, 0);
    c.asleep = true;
    c.key = this.gridAdd(this.sleepGrid, c);
    this.write(c);
  }

  private wake(c: Chunk): void {
    if (!c.asleep) return;
    const b = this.sleepGrid.get(c.key);
    if (b) { const i = b.indexOf(c); if (i >= 0) { b[i] = b[b.length - 1]; b.pop(); } if (b.length === 0) this.sleepGrid.delete(c.key); }
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
      if (b) { const i = b.indexOf(c); if (i >= 0) { b[i] = b[b.length - 1]; b.pop(); } if (b.length === 0) this.sleepGrid.delete(c.key); }
    } else {
      const i = this.awake.indexOf(c);
      if (i >= 0) { this.awake[i] = this.awake[this.awake.length - 1]; this.awake.pop(); }
    }
    this.slots[c.slot] = null;
    this.free.push(c.slot);
    this.mesh.setMatrixAt(c.slot, this.zero);
    if (c.slot < this.dMin) this.dMin = c.slot;
    if (c.slot > this.dMax) this.dMax = c.slot;
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
