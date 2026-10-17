import * as THREE from 'three';
import type { Debris } from './debris';
import type { Dust } from './dust';
import { generateLayout } from './buildingLayout';
import { CELL, DEPTH, MAXL, STORY, T, SPEC, DEEP, type Ledge } from './buildingSpec';

export { CELL, type Ledge };

/** One layer of a member that is part of a collapsing block, with where it started. */
interface BlockLayer { c: number; r: number; k: number; inst: number; base: THREE.Matrix4; pos: THREE.Vector3 }

/** A rigid piece of the building that has lost its support and is coming down. */
interface Block {
  /** its layers, lowest row first */
  layers: BlockLayer[];
  t: number;
  /** seconds it holds still (shuddering) before it moves */
  delay: number;
  /** how far it drops before it touches what is under it, and how long that takes */
  D: number;
  tA: number;
  /** the height its bottom ends up at: the top of what it lands on */
  py: number;
  /** sideways drift while coming down */
  drift: number;
  /** columns it lands on, and the lowest row it occupies */
  contact: number[];
  baseRow: number;
  puff: number;
  /** how many layers it started with, and a running count toward the next piece breaking off */
  total: number;
  crumble: number;
  /** after landing: how fast the crush climbs the block (rows/s), and how many rows it has climbed */
  crushRate: number;
  crushed: number;
}

/** Where an enemy appears in a bay, and what it needs to walk to the ledge. */
export interface LedgeSpawn {
  pos: THREE.Vector3;
  ledgeZ: number;
  backZ: number;
  floorTop: (x: number, z: number, yMax: number) => number;
}

/** How far a floor/wall member can reach horizontally from a pillar or support, in cells. */
const SPAN = 5;
const INF = 1000;
/** A storey that keeps less than this share of its load-bearing cells can no longer carry what is above it. */
const BEARING_MIN = 0.6;
/** a collapsing block: how hard it falls (units/s^2), how long it holds before moving (s) */
const BLOCK_G = 8;
const COLLAPSE_DELAY = 0.35;
/** the whole collapse (hold, fall, crush) runs at this multiple of real time */
const COLLAPSE_SPEED = 1.5;
/** it creeps toward the camera as it comes down: speed and furthest distance (units) */
const FORWARD_SPEED = 0.4;
const FORWARD_MAX = 0.6;
/** after it lands the rows are crushed from the bottom at this many rows per second, kept between these limits */
const CRUSH_MIN_ROWS = 6;
const CRUSH_MAX_ROWS = 11;
/** pieces that break loose from the bottom of a moving block, per second, until it has lost this share of itself */
const CRUMBLE_RATE = 22;
const CRUMBLE_MAX = 0.25;
/** landing from a drop longer than this breaks a layer of the top of the supporting columns; a longer one, or a bigger block, two */
const IMPACT_MIN_DROP = 0.7;
const IMPACT_HEAVY_DROP = 2.6;
const IMPACT_HEAVY_LAYERS = 160;
const BOX = new THREE.BoxGeometry(1, 1, 1);
const MAT = new THREE.MeshStandardMaterial({ roughness: 0.9 });
/** background rows: unlit near-black cut-outs against the sky (one material per shade) */
const silMats = new Map<number, THREE.MeshBasicMaterial>();
const silMat = (color: number): THREE.MeshBasicMaterial => {
  let m = silMats.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color, fog: false }); silMats.set(color, m); }
  return m;
};
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);


export interface DamageResult { hit: boolean; destroyed: number }

/**
 * Destructible building built from structural members on a CELL-sized grid:
 * floor slabs, pillars, spandrel/header walls, glazing and an open stairwell with zig-zag flights.
 * Bullets weaken cells; after every hit a support solver collapses whatever lost its load path
 * (pillars hold floors, walls and slabs can only span a few cells unsupported).
 */
export class Building {
  /** everything to add to the scene for this building */
  readonly object = new THREE.Group();
  readonly x0: number;
  readonly width: number;
  readonly height: number;
  private mesh: THREE.InstancedMesh;
  private cols: number;
  private rows: number;
  private type: Uint8Array;
  private hp: Uint8Array;
  /** per-member count of intact layers (0 = gone); the solver and most queries use this */
  /** per layer (member index * MAXL + k): hit points, instance index, colour */
  private lhp!: Uint8Array;
  private inst!: Int32Array;
  private layerColors: (THREE.Color | null)[] = [];
  private deepLayers: number;
  private ledges: Ledge[] = [];
  /** bumped whenever cells change; lets the rain height-map know to rebuild */
  version = 0;
  /** set once the building has collapsed: it no longer hosts enemies */
  down = false;
  /** false for background rows: they never host enemies or rubble */
  hostsEnemies = true;
  private initialAlive = 0;
  private ruinCount = 0;
  private rubbleDone = false;
  /** load-bearing cells per storey when intact */
  private bearingTotal: number[] = [];
  private z0: number;
  private tmpColor = new THREE.Color();
  /** pieces of the building that are coming down right now */
  private blocks: Block[] = [];
  private poseM = new THREE.Matrix4();
  private poseOut = new THREE.Matrix4();
  private mat = new THREE.Matrix4();

  constructor(
    x0: number, z0: number, tint: number, rnd: () => number,
    private debris: Debris, private dust: Dust,
    /** false for the cheap background copies: deep members stay a single block */
    layered = true,
  ) {
    this.x0 = x0; this.z0 = z0;
    this.deepLayers = layered ? MAXL : 1;

    const layout = generateLayout(x0, rnd);
    const { stories } = layout;
    this.cols = layout.cols;
    this.rows = layout.rows;
    this.width = this.cols * CELL;
    this.height = this.rows * CELL;
    this.ledges = layout.ledges;
    this.type = layout.type;
    this.ruinCount = layout.ruinCount;
    this.hp = new Uint8Array(this.cols * this.rows);
    for (let i = 0; i < this.type.length; i++) this.hp[i] = this.type[i] === T.Empty ? 0 : this.layersOf(this.type[i]);
    // whatever lost its load path in the ruin pass has fallen already: remove it silently
    for (const i of this.unsupported(false)) { this.type[i] = T.Empty; this.hp[i] = 0; this.ruinCount++; }

    // load-bearing census for the storey-failure rule (taken from the ruined state)
    for (let st = 0; st < stories; st++) {
      let n = 0;
      for (let c = 0; c < this.cols; c++) {
        for (let k = 1; k < STORY; k++) {
          const t = this.type[c * this.rows + st * STORY + k];
          if (t === T.Pillar || t === T.Wall || t === T.Stair) n++;
        }
      }
      this.bearingTotal.push(n);
    }
    this.initialAlive = this.hp.reduce((a, h) => a + (h > 0 ? 1 : 0), 0);

    // ---- instances: one per layer of every member
    const concrete = new THREE.Color(tint);
    const members = this.cols * this.rows;
    this.lhp = new Uint8Array(members * MAXL);
    this.inst = new Int32Array(members * MAXL).fill(-1);
    this.layerColors = new Array(members * MAXL).fill(null);
    let total = 0;
    for (let i = 0; i < members; i++) {
      const t = this.type[i];
      if (t === T.Empty) continue;
      for (let k = 0; k < this.layersOf(t); k++) { this.lhp[i * MAXL + k] = this.layerHpOf(t); this.inst[i * MAXL + k] = total++; }
    }
    this.mesh = new THREE.InstancedMesh(BOX, MAT, Math.max(1, total));
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const q = new THREE.Quaternion();
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        const i = c * this.rows + r;
        const t = this.type[i];
        if (t === T.Empty) continue;
        const spec = SPEC[t], L = this.layersOf(t), lt = spec.thick / L;
        const base = this.cellColor(t, concrete, rnd);
        for (let k = 0; k < L; k++) {
          const li = i * MAXL + k;
          // deeper layers are a touch darker, so the layers read when a shot peels the front one away
          const col = base.clone().multiplyScalar((1 - 0.06 * k) * (0.96 + rnd() * 0.08));
          this.layerColors[li] = col;
          this.mesh.setColorAt(this.inst[li], col);
          const zc = z0 + spec.front - (k + 0.5) * lt;
          this.mat.compose(new THREE.Vector3(x0 + (c + 0.5) * CELL, (r + 0.5) * CELL, zc), q, new THREE.Vector3(CELL, CELL, lt));
          this.mesh.setMatrixAt(this.inst[li], this.mat);
        }
      }
    }
    this.object.add(this.mesh);
  }

  /** How many depth layers this kind of member is built from. */
  private layersOf(t: number): number {
    const deep = DEEP[t];
    return deep ? Math.min(deep, this.deepLayers) : 1;
  }

  /** Each layer of a layered member has half the member's old hit points (the whole depth still adds up to more). */
  private layerHpOf(t: number): number {
    const spec = SPEC[t];
    return this.layersOf(t) > 1 ? Math.max(1, Math.ceil(spec.hp / 2)) : spec.hp;
  }

  /** Turn this building into a flat black cut-out of the same ruined shape (far rows). */
  asSilhouette(color: number): void {
    this.hostsEnemies = false;
    this.mesh.material = silMat(color);
    this.mesh.castShadow = this.mesh.receiveShadow = false;
  }

  /** Height of the highest intact cell in column c (0 if the column is empty). */
  private columnTop(c: number): number {
    for (let r = this.rows - 1; r >= 0; r--) if (this.hp[c * this.rows + r] > 0) return (r + 1) * CELL;
    return 0;
  }

  /** Call back with the footprint (x0, x1, z0, z1) and top height of every column: what rain lands on. */
  forEachColumnTop(cb: (x0: number, x1: number, z0: number, z1: number, top: number) => void): void {
    const z1 = this.z0 + 0.4 * CELL, z0 = this.z0 - DEPTH;
    for (let c = 0; c < this.cols; c++) {
      const top = this.columnTop(c);
      if (top > 0) cb(this.x0 + c * CELL, this.x0 + (c + 1) * CELL, z0, z1, top);
    }
  }

  /** Pre-existing wreckage in front of the building, created when the camera gets near. */
  spawnRuinRubble(): void {
    if (this.rubbleDone) return;
    this.rubbleDone = true;
    const n = Math.min(70, Math.round(this.ruinCount * 0.5));
    const col = new THREE.Color(0x4a4e58);
    for (let k = 0; k < n; k++) {
      const size = CELL * (0.3 + Math.random() * 0.45);
      const pos = new THREE.Vector3(this.x0 + Math.random() * this.width, 0.4 + Math.random() * 0.6, this.z0 - DEPTH * 0.2 + Math.random() * 3.2);
      this.debris.spawn(pos, col, size, new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, Math.random() * 0.6), this.floorFn);
    }
  }

  private cellColor(t: number, concrete: THREE.Color, rnd: () => number): THREE.Color {
    const c = new THREE.Color();
    const v = 0.92 + rnd() * 0.16;
    switch (t) {
      case T.Slab: return c.copy(concrete).multiplyScalar(1.15 * v);
      case T.Pillar: return c.copy(concrete).multiplyScalar(0.8 * v);
      case T.Wall: return c.copy(concrete).multiplyScalar(0.95 * v);
      case T.Stair: return c.copy(concrete).multiplyScalar(0.6 * v);
      case T.Window: return c.setHex(0x1b2438);
      default: return c;
    }
  }

  /** Firing bays whose centre is within [minX, maxX] and whose floor is still intact. */
  ledgeList(minX: number, maxX: number): Ledge[] {
    if (this.down || !this.hostsEnemies) return [];
    return this.ledges.filter((l) => {
      if (l.x < minX || l.x > maxX) return false;
      for (let c = l.c0; c <= l.c1; c++) if (this.hp[c * this.rows + l.r] === 0) return false;
      return true;
    });
  }

  /** Floor positions for props inside the ground-floor open bays (on the foundation slab, behind the front edge). */
  groundBaySpots(count: number, rnd: () => number): THREE.Vector3[] {
    const bays = this.ledges.filter((l) => l.r === 0);
    const out: THREE.Vector3[] = [];
    for (let tries = 0; out.length < count && bays.length > 0 && tries < 20; tries++) {
      const l = bays[Math.floor(rnd() * bays.length)];
      const p = new THREE.Vector3(l.x + (rnd() - 0.5) * 0.8, CELL, this.z0 - 0.7 - rnd() * 1.0);
      if (out.every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 0.5)) out.push(p);
    }
    return out;
  }

  /**
   * Spawn data for an enemy that walks in from the floor of a bay to the ledge edge, or null if that floor is not
   * whole any more: the slab must still be there under the whole path across the bay (a floor shot out at the
   * front or the back would drop the soldier at once).
   */
  ledgeSpawn(l: Ledge): LedgeSpawn | null {
    const y = (l.r + 1) * CELL;
    const backZ = this.z0 - DEPTH + 0.75 * CELL;
    const ledgeZ = this.z0 - 0.5 * CELL;
    // anywhere across the bay (clear of the pillars) and a random way in from the back
    const halfSpan = Math.max(0, ((l.c1 - l.c0 + 1) / 2 - 0.6) * CELL);
    const x = l.x + (Math.random() * 2 - 1) * halfSpan;
    const startZ = backZ + Math.random() * 0.5 * (ledgeZ - backZ);
    for (const z of [startZ, (startZ + ledgeZ) / 2, ledgeZ]) {
      for (const px of [x, l.x - halfSpan, l.x + halfSpan]) {
        if (this.floorTop(px, z, y + 0.05) < y - 0.01) return null;
      }
    }
    return {
      pos: new THREE.Vector3(x, y, startZ),
      ledgeZ,
      backZ,
      floorTop: (fx, fz, yMax) => this.floorTop(fx, fz, yMax),
    };
  }

  /** Which layer of member i contains depth z (or -1), given its box. */
  private layerAt(i: number, z: number): number {
    const t = this.type[i];
    if (t === T.Empty) return -1;
    const spec = SPEC[t], L = this.layersOf(t), lt = spec.thick / L;
    const zf = this.z0 + spec.front;
    if (z > zf + 0.005 || z < zf - spec.thick - 0.005) return -1;
    return Math.min(L - 1, Math.max(0, Math.floor((zf - z) / lt)));
  }

  /** Top of the highest intact floor slab under (x, z) that is at or below yMax (0 = ground). */
  floorTop(x: number, z: number, yMax: number): number {
    const c = Math.floor((x - this.x0) / CELL);
    if (c < 0 || c >= this.cols) return 0;
    for (let r = Math.min(this.rows - 1, Math.floor(yMax / CELL)); r >= 0; r--) {
      const i = c * this.rows + r;
      if (this.hp[i] === 0 || this.type[i] !== T.Slab) continue;
      const k = this.layerAt(i, z);
      if (k >= 0 && this.lhp[i * MAXL + k] > 0) return (r + 1) * CELL;
    }
    return 0;
  }

  /**
   * Nearest intact-cell hit along the ray, against every face of every member (front, sides, tops),
   * so a slanted shot cannot slip past a pillar's side or a slab's edge. Walks the (x, y) grid cell by
   * cell along the ray and tests the real box of each intact cell. Returns the ray distance t, or Infinity.
   */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    const o = ray.origin, d = ray.direction;
    // the building's bounding box
    const minX = this.x0, maxX = this.x0 + this.width, minY = 0, maxY = this.height;
    const minZ = this.z0 - DEPTH, maxZ = this.z0 + 0.4 * CELL;
    let tn = 0, tf = Infinity;
    for (const [oo, dd, lo, hi] of [[o.x, d.x, minX, maxX], [o.y, d.y, minY, maxY], [o.z, d.z, minZ, maxZ]] as const) {
      if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return Infinity; continue; }
      let t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tn = Math.max(tn, t1); tf = Math.min(tf, t2);
      if (tn > tf) return Infinity;
    }

    // start cell, clamped into the grid, then 2D DDA over (x, y); z is free (members differ in depth)
    const px = o.x + d.x * tn, py = o.y + d.y * tn;
    let c = Math.min(this.cols - 1, Math.max(0, Math.floor((px - this.x0) / CELL)));
    let r = Math.min(this.rows - 1, Math.max(0, Math.floor(py / CELL)));
    const stepX = d.x > 0 ? 1 : -1, stepY = d.y > 0 ? 1 : -1;
    const nextX = (cc: number) => this.x0 + (stepX > 0 ? cc + 1 : cc) * CELL;
    const nextY = (rr: number) => (stepY > 0 ? rr + 1 : rr) * CELL;
    let tMaxX = Math.abs(d.x) < 1e-9 ? Infinity : (nextX(c) - o.x) / d.x;
    let tMaxY = Math.abs(d.y) < 1e-9 ? Infinity : (nextY(r) - o.y) / d.y;
    const tDX = Math.abs(d.x) < 1e-9 ? Infinity : CELL / Math.abs(d.x);
    const tDY = Math.abs(d.y) < 1e-9 ? Infinity : CELL / Math.abs(d.y);

    for (let guard = 0; guard < this.cols + this.rows + 6; guard++) {
      if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) break;
      const i = c * this.rows + r;
      if (this.hp[i] > 0) {
        // exact test against each intact layer of this member; the nearest wins
        const spec = SPEC[this.type[i]], L = this.layersOf(this.type[i]), lt = spec.thick / L;
        const bx0 = this.x0 + c * CELL, by0 = r * CELL;
        let bestT = Infinity;
        for (let k = 0; k < L; k++) {
          if (this.lhp[i * MAXL + k] === 0) continue;
          const zf = this.z0 + spec.front - k * lt, zb = zf - lt;
          let a0 = 0, a1 = Infinity, miss = false;
          for (const [oo, dd, lo, hi] of [[o.x, d.x, bx0, bx0 + CELL], [o.y, d.y, by0, by0 + CELL], [o.z, d.z, zb, zf]] as const) {
            if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) { miss = true; break; } continue; }
            let t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            a0 = Math.max(a0, t1); a1 = Math.min(a1, t2);
            if (a0 > a1) { miss = true; break; }
          }
          if (!miss && a0 < bestT) bestT = a0;
        }
        if (bestT < Infinity) { out.set(o.x + d.x * bestT, o.y + d.y * bestT, o.z + d.z * bestT); return bestT; }
      }
      // advance to the next cell the ray enters
      if (tMaxX < tMaxY) { if (tMaxX > tf) break; c += stepX; tMaxX += tDX; }
      else { if (tMaxY > tf) break; r += stepY; tMaxY += tDY; }
    }
    return Infinity;
  }

  /**
   * Apply damage around a 3D impact point: every intact layer within `radius` of the point (its box, not
   * its centre) is weakened. A shot at the face hits the front layer; once that is gone the next shot
   * reaches the layer behind it; a shot at a side face hits the layer at that depth.
   */
  damage(px: number, py: number, pz: number, radius: number): DamageResult {
    const res = { hit: false, destroyed: 0 };
    if (px < this.x0 - radius || px > this.x0 + this.width + radius || py > this.height + radius) return res;
    const cMin = Math.max(0, Math.floor((px - radius - this.x0) / CELL));
    const cMax = Math.min(this.cols - 1, Math.floor((px + radius - this.x0) / CELL));
    const rMin = Math.max(0, Math.floor((py - radius) / CELL));
    const rMax = Math.min(this.rows - 1, Math.floor((py + radius) / CELL));
    const reach = radius * 0.9;
    let changed = false;
    for (let c = cMin; c <= cMax; c++) {
      for (let r = rMin; r <= rMax; r++) {
        const i = c * this.rows + r;
        if (this.hp[i] === 0) continue;
        const spec = SPEC[this.type[i]], L = this.layersOf(this.type[i]), lt = spec.thick / L;
        const bx0 = this.x0 + c * CELL, by0 = r * CELL;
        const dx = Math.max(bx0 - px, 0, px - (bx0 + CELL)), dy = Math.max(by0 - py, 0, py - (by0 + CELL));
        if (dx * dx + dy * dy > reach * reach) continue;
        for (let k = 0; k < L; k++) {
          const li = i * MAXL + k;
          if (this.lhp[li] === 0) continue;
          const zf = this.z0 + spec.front - k * lt, zb = zf - lt;
          const dz = Math.max(zb - pz, 0, pz - zf);
          if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
          res.hit = changed = true;
          this.lhp[li]--;
          if (this.lhp[li] === 0) {
            res.destroyed++;
            this.breakLayer(c, r, k, true);
          } else {
            this.tmpColor.copy(this.layerColors[li]!).multiplyScalar(0.65);
            this.mesh.setColorAt(this.inst[li], this.tmpColor); // cracked / scorched
          }
        }
      }
    }
    if (changed) {
      this.version++;
      this.settle();
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
    return res;
  }

  /** Top of the highest intact cell under (x, z) whose top is at or below yBelow; 0 = ground. */
  solidTop(x: number, z: number, yBelow: number): number {
    if (z > this.z0 + 0.4 * CELL || z < this.z0 - DEPTH) return 0;
    const c = Math.floor((x - this.x0) / CELL);
    if (c < 0 || c >= this.cols) return 0;
    for (let r = Math.min(this.rows - 1, Math.floor((yBelow + 0.05) / CELL) - 1); r >= 0; r--) {
      const i = c * this.rows + r;
      if (this.hp[i] === 0) continue;
      // thin members and removed layers only occupy part of the depth: no standing on thin air behind them
      const k = this.layerAt(i, z);
      if (k >= 0 && this.lhp[i * MAXL + k] > 0) return (r + 1) * CELL;
    }
    return 0;
  }

  /** Is the point inside an intact layer of a member? Used for small bodies like coals. */
  solidAt(x: number, y: number, z: number): boolean {
    if (x < this.x0 || x >= this.x0 + this.width || y < 0 || y >= this.height) return false;
    if (z > this.z0 + 0.4 * CELL || z < this.z0 - DEPTH) return false;
    const i = Math.floor((x - this.x0) / CELL) * this.rows + Math.floor(y / CELL);
    if (this.hp[i] === 0) return false;
    const k = this.layerAt(i, z);
    return k >= 0 && this.lhp[i * MAXL + k] > 0;
  }

  private floorFn = (x: number, z: number, y: number): number => this.solidTop(x, z, y);

  /** Take one layer of a member out of the structure (its mesh instance is left for the caller to deal with). */
  private removeLayer(c: number, r: number, k: number): void {
    const i = c * this.rows + r;
    this.lhp[i * MAXL + k] = 0;
    this.hp[i]--;
  }

  /** Remove one layer of a member and throw its rubble (a bullet's work). */
  private breakLayer(c: number, r: number, k: number, byBullet: boolean, fallH = 0): void {
    this.removeLayer(c, r, k);
    this.shedRubble(c, r, k, byBullet, fallH);
  }

  /**
   * Hide a layer's instance and throw its rubble.
   * @param fallH height of the cell above where support was lost (structural collapse only)
   * @param at where the layer is now, and `vel` how fast it is moving (a piece of a collapsing block shattering)
   */
  private shedRubble(c: number, r: number, k: number, byBullet: boolean, fallH = 0, at?: THREE.Vector3, vel?: THREE.Vector3): void {
    const i = c * this.rows + r, li = i * MAXL + k;
    const t = this.type[i], spec = SPEC[t], L = this.layersOf(t), lt = spec.thick / L;
    this.mesh.setMatrixAt(this.inst[li], ZERO);
    const zf = this.z0 + spec.front - k * lt;
    const pos = at ?? new THREE.Vector3(this.x0 + (c + 0.5) * CELL, (r + 0.5) * CELL, byBullet ? zf : zf - Math.random() * lt);
    this.debris.wakeNear(pos, CELL * 1.2); // rubble that was resting here
    const col = this.layerColors[li]!;
    const glass = t === T.Window;
    // Rubble comes in varied small pieces (never bigger than ~0.3): a soldier can see and be seen over
    // the small ones, and the big ones are not tall enough to hide a whole soldier for long.
    const piece = (lo: number, hi: number) => CELL * (lo + Math.random() * (hi - lo));
    if (byBullet) {
      const v = (spread: number, up: number) => new THREE.Vector3((Math.random() - 0.5) * spread * 0.8, up * 0.7 * (0.3 + Math.random()), (1 + Math.random() * 3) * 0.8);
      for (let n = 0; n < 2; n++) this.debris.spawn(pos, col, glass ? piece(0.2, 0.35) : piece(0.35, 0.65), v(3, 3), this.floorFn);
      this.debris.spawn(pos, col, piece(0.2, 0.35), v(6, 4), this.floorFn);
      this.dust.puff(pos, 1, CELL * 2.2, 1.5);
    } else if (vel) {
      // a piece of a collapsing block: it carries the block's motion at that point, plus a scatter
      const v = (k2: number) => new THREE.Vector3(vel.x + (Math.random() - 0.5) * 1.2 * k2, vel.y + (Math.random() - 0.5) * 0.8 * k2, vel.z + Math.random() * 1.2 * k2);
      this.debris.spawn(pos, col, piece(0.35, 0.8), v(1), this.floorFn);
      if (this.debris.count < 4000) this.debris.spawn(pos, col, piece(0.25, 0.5), v(1.3), this.floorFn);
    } else {
      // structural collapse: the layer drops from somewhere within its depth, so it can crush whatever is inside.
      // The structure topples out into the street like a falling wall: the higher the cell, the harder it is
      // thrown outward (+z), as if rotating about the base's front edge.
      // (scaled down to match the slower rubble gravity, so it still lands in the street)
      const outBase = Math.min(5, 1.0 + 0.6 * fallH) * 0.72;
      const out = outBase * (0.7 + Math.random() * 0.6);
      this.debris.spawn(pos, col, piece(0.35, 0.8), new THREE.Vector3((Math.random() - 0.5) * 1.6, -0.5 - Math.random() * 0.5, out), this.floorFn);
      if (this.debris.count < 4000) this.debris.spawn(pos, col, piece(0.25, 0.5), new THREE.Vector3((Math.random() - 0.5) * 1.6, -0.5, out * 0.8), this.floorFn);
    }
  }

  /**
   * Load-path solver. Support flows from the foundation up and sideways (never down).
   * Pillars/stairs only receive support from below; slabs and walls can also be carried
   * sideways, losing one cell of "reach" per step (SPAN cells from the nearest solid support).
   */
  /** Cells that have lost their load path (and, with storeyRule, those above a failed storey). */
  private unsupported(storeyRule: boolean): number[] {
    const { cols, rows, hp, type } = this;
    const reach = new Int16Array(cols * rows).fill(-1);
    const queue: number[] = [];
    for (let c = 0; c < cols; c++) {
      const i = c * rows;
      if (hp[i] > 0) { reach[i] = INF; queue.push(i); }
    }
    const tryMove = (from: number, c: number, r: number, vertical: boolean): void => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return;
      const to = c * rows + r;
      if (hp[to] === 0 || !SPEC[type[to]].structural) return;
      const fromSpan = SPEC[type[from]].span, toSpan = SPEC[type[to]].span;
      if (!toSpan && !vertical) return; // pillars/stairs only stand on what is beneath them
      const R = reach[from];
      let nr: number;
      if (!toSpan) nr = R;
      else if (vertical) nr = fromSpan ? R : Math.min(R, SPAN - 1);
      else nr = fromSpan ? R - 1 : SPAN - 1;
      if (nr > reach[to]) { reach[to] = nr; queue.push(to); }
    };
    for (let qi = 0; qi < queue.length; qi++) {
      const from = queue[qi];
      const c = Math.floor(from / rows), r = from % rows;
      tryMove(from, c, r + 1, true);
      tryMove(from, c - 1, r, false);
      tryMove(from, c + 1, r, false);
    }

    // Storey failure: if a storey has lost too much of its load-bearing structure,
    // everything above it comes down regardless of what is locally still connected.
    let collapseFrom = rows; // first row that falls
    for (let st = 0; storeyRule && st < this.bearingTotal.length; st++) {
      let alive = 0;
      for (let c = 0; c < cols; c++) {
        for (let k = 1; k < STORY; k++) {
          const i = c * rows + st * STORY + k;
          // a layered member counts by how much of its depth is left, so wearing pillars down weakens the storey
          if (hp[i] > 0 && (type[i] === T.Pillar || type[i] === T.Wall || type[i] === T.Stair)) alive += hp[i] / this.layersOf(type[i]);
        }
      }
      if (alive < this.bearingTotal[st] * BEARING_MIN) { collapseFrom = (st + 1) * STORY; break; }
    }
    this.storeyFailed = collapseFrom < rows;
    if (collapseFrom < rows) {
      for (let c = 0; c < cols; c++) for (let r = collapseFrom; r < rows; r++) reach[c * rows + r] = -1;
    }

    const falling: number[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        if (hp[i] === 0) continue;
        const spec = SPEC[type[i]];
        if (spec.structural) { if (reach[i] < 0) falling.push(i); continue; }
        // glazing falls when fewer than two solid neighbours still frame it
        let framed = 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cc = c + dc, rr = r + dr;
          if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
          const j = cc * rows + rr;
          if (hp[j] > 0 && SPEC[type[j]].structural && reach[j] >= 0) framed++;
        }
        if (framed < 2) falling.push(i);
      }
    }
    return falling;
  }

  private storeyFailed = false;

  private settle(): void {
    const falling = this.unsupported(true);
    let alive = 0;
    for (let i = 0; i < this.hp.length; i++) if (this.hp[i] > 0) alive++;
    // a storey that failed, or most of the structure gone: the building is down for good
    if (this.storeyFailed || alive < this.initialAlive * 0.4) this.down = true;
    if (falling.length === 0) return;
    // whatever lost its support comes down in connected pieces, each a rigid block that falls (and tilts) as one
    const fallingSet = new Set(falling);
    const detached: { members: number[] }[] = [];
    const seen = new Set<number>();
    for (const start of falling) {
      if (seen.has(start)) continue;
      const members: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const i = stack.pop()!;
        members.push(i);
        const c = Math.floor(i / this.rows), r = i % this.rows;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cc = c + dc, rr = r + dr;
          if (cc < 0 || cc >= this.cols || rr < 0 || rr >= this.rows) continue;
          const j = cc * this.rows + rr;
          if (fallingSet.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
        }
      }
      detached.push({ members });
    }
    // take every falling layer out of the structure first, so the landing heights below see the final state
    const pieces = detached.map(({ members }) => this.detach(members));
    for (const p of pieces) this.launchBlock(p);
    this.dust.puff(new THREE.Vector3(this.x0 + this.width / 2, 0.5, this.z0 + 1.0), 3, CELL * 3, 1.5);
  }

  /** Remove the members' layers from the structure, keeping their meshes to animate. */
  private detach(members: number[]): BlockLayer[] {
    const layers: BlockLayer[] = [];
    for (const i of members) {
      const c = Math.floor(i / this.rows), r = i % this.rows;
      for (let k = 0; k < MAXL; k++) {
        const li = i * MAXL + k;
        if (this.lhp[li] === 0) continue;
        const base = new THREE.Matrix4();
        this.mesh.getMatrixAt(this.inst[li], base);
        layers.push({ c, r, k, inst: this.inst[li], base, pos: new THREE.Vector3().setFromMatrixPosition(base) });
        this.removeLayer(c, r, k);
      }
    }
    return layers;
  }

  /**
   * Work out how a detached block comes down. It holds a moment, shuddering, then drops straight down (and a
   * little toward the camera) until it touches what is left standing under it: a lower floor, or the ground.
   * Then it is crushed from the bottom up: each row breaks into rubble as the mass above comes down through it,
   * so the lower levels go first and the upper ones follow as they arrive.
   */
  private launchBlock(layers: BlockLayer[]): void {
    const { rows } = this;
    const bottom = new Map<number, number>();             // column -> lowest row of the block in it
    for (const l of layers) bottom.set(l.c, Math.min(bottom.get(l.c) ?? Infinity, l.r));
    let D = Infinity;                                     // the clear drop under the block: its tightest column
    const contact: number[] = [];
    for (const [c, r0] of bottom) {
      let top = 0;
      for (let r = r0 - 1; r >= 0; r--) if (this.hp[c * rows + r] > 0) { top = (r + 1) * CELL; break; }
      const gap = r0 * CELL - top;
      if (gap < D - 1e-6) { D = gap; contact.length = 0; }
      if (gap < D + CELL * 0.3) contact.push(c);
    }
    const baseRow = Math.min(...layers.map((l) => l.r));
    // the bottom row of the block lands on `py`: the top of whatever is under it
    const fall = D > 0.02 ? Math.sqrt((2 * D) / BLOCK_G) : 0;
    this.blocks.push({
      layers: layers.sort((p, q) => p.r - q.r), t: 0, delay: COLLAPSE_DELAY, D, tA: fall, py: baseRow * CELL - D,
      drift: (Math.random() - 0.5) * 0.2, contact, puff: 0, baseRow, total: layers.length, crumble: 0,
      crushRate: THREE.MathUtils.clamp((BLOCK_G * fall * 0.6) / CELL, CRUSH_MIN_ROWS, CRUSH_MAX_ROWS), crushed: 0,
    });
    this.version++;
  }

  /** Is anything of this building still coming down? */
  get collapsing(): boolean { return this.blocks.length > 0; }

  /** Advance the falling blocks. */
  step(realDt: number): void {
    if (this.blocks.length === 0) return;
    const dt = realDt * COLLAPSE_SPEED;
    for (let bi = this.blocks.length - 1; bi >= 0; bi--) {
      const b = this.blocks[bi];
      b.t += dt;
      let tx: number;
      let ty = 0, tz = 0, vy = 0;
      if (b.t < b.delay) {
        // it holds for a beat, shuddering, with dust shaken loose
        tx = Math.sin(b.t * 95) * 0.012 * (b.t / b.delay);
        b.puff -= dt;
        if (b.puff <= 0) { b.puff = 0.1; this.bottomPuff(b, 1, 0.8); }
      } else {
        const tau = b.t - b.delay;
        tz = Math.min(FORWARD_MAX, FORWARD_SPEED * tau);          // creeping toward the camera as it comes down
        tx = b.drift * Math.min(tau, b.tA + 1);
        if (tau < b.tA) {
          ty = -0.5 * BLOCK_G * tau * tau;
          vy = -BLOCK_G * tau;
          b.puff -= dt;
          if (b.puff <= 0) { b.puff = 0.07; this.bottomPuff(b, 2, 1.2); }
        } else {
          // it has landed: the rows are crushed from the bottom, and what is left keeps coming down
          b.crushed = (tau - b.tA) * b.crushRate;
          ty = -b.D - b.crushed * CELL;
          vy = -BLOCK_G * b.tA * 0.6;
          this.crushRows(b, tx, tz);
        }
      }
      this.poseBlock(b, tx, ty, tz);
      if (b.t >= b.delay && b.t - b.delay < b.tA) this.crumble(b, dt, vy, tz);
      if (b.layers.length === 0) {
        this.landed(b);
        this.blocks.splice(bi, 1);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Once it is moving, bits break off its underside and fall away from it. */
  private crumble(b: Block, dt: number, vy: number, tz: number): void {
    b.crumble += CRUMBLE_RATE * dt;
    while (b.crumble >= 1 && b.layers.length > b.total * (1 - CRUMBLE_MAX)) {
      b.crumble -= 1;
      // from the lowest two rows
      const low = b.layers.filter((l) => l.r <= b.baseRow + 1);
      if (low.length === 0) break;
      const l = low[Math.floor(Math.random() * low.length)];
      const at = l.pos.clone().applyMatrix4(this.poseM);
      this.shedRubble(l.c, l.r, l.k, false, 0, at, new THREE.Vector3(b.drift + (Math.random() - 0.5), vy * 0.4, 0.5 + tz));
      b.layers.splice(b.layers.indexOf(l), 1);
    }
    if (b.crumble > 3) b.crumble = 0;
  }

  /** Break every layer the crush has reached into rubble at the foot of the block, and kick up dust for each row. */
  private crushRows(b: Block, tx: number, tz: number): void {
    // a row is gone once the mass above has come down through it
    while (b.layers.length > 0 && b.layers[0].r - b.baseRow + 1 <= b.crushed) {
      const row = b.layers[0].r;
      let n = 0;
      while (b.layers.length > 0 && b.layers[0].r === row) {
        const l = b.layers.shift()!;
        const at = new THREE.Vector3(l.pos.x + tx, b.py + 0.05 + Math.random() * CELL * 0.6, l.pos.z + tz);
        // it bursts out at the foot of the pile: spread sideways, spilling toward the street
        const v = new THREE.Vector3((Math.random() - 0.5) * 2.2 + b.drift, 0.2 + Math.random() * 1.0, 0.8 + Math.random() * 1.6);
        this.shedRubble(l.c, l.r, l.k, false, 0, at, v);
        n++;
      }
      if (n > 0) this.dust.puff(new THREE.Vector3(this.x0 + (b.contact[Math.floor(Math.random() * b.contact.length)] + Math.random()) * CELL, b.py + 0.2, this.z0 + 0.6 + tz), 2, CELL * 3, 2);
    }
  }

  private bottomPuff(b: Block, n: number, spread: number): void {
    const c = b.contact[Math.floor(Math.random() * b.contact.length)] ?? b.layers[0].c;
    this.dust.puff(new THREE.Vector3(this.x0 + (c + Math.random()) * CELL, Math.max(0.1, b.py + 0.1), this.z0 + 0.5), n, CELL * 2.5, spread);
  }

  /** Put every remaining layer of the block where the block's motion says. */
  private poseBlock(b: Block, tx: number, ty: number, tz: number): void {
    const m = this.poseM.makeTranslation(tx, ty, tz);
    for (const l of b.layers) this.mesh.setMatrixAt(l.inst, this.poseOut.multiplyMatrices(m, l.base));
  }

  /**
   * The whole block is down. What it landed on takes the blow: a tall block that fell far breaks a layer of the top
   * of every column that carried it, which can bring that down in turn.
   */
  private landed(b: Block): void {
    if (b.D > IMPACT_MIN_DROP) {
      const hits = b.D > IMPACT_HEAVY_DROP || b.total > IMPACT_HEAVY_LAYERS ? 2 : 1;
      for (const c of b.contact) {
        for (let r = b.baseRow - 1; r >= 0; r--) {
          const i = c * this.rows + r;
          if (this.hp[i] <= 0) continue;
          const L = this.layersOf(this.type[i]);
          for (let n = 0, k = 0; n < hits && k < L; k++) {
            if (this.lhp[i * MAXL + k] === 0) continue;
            this.breakLayer(c, r, k, false);
            n++;
          }
          break;
        }
      }
    }
    this.version++;
    this.settle();
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
