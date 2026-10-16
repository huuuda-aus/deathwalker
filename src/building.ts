import * as THREE from 'three';
import type { Debris, Dust } from './debris';

export const CELL = 0.4;
/** Depth (z) of floors and pillars: the building's structural body. */
const DEPTH = 6 * CELL;
/** How far a floor/wall member can reach horizontally from a pillar or support, in cells. */
const SPAN = 5;
const INF = 1000;
/** A storey that keeps less than this share of its load-bearing cells can no longer carry what is above it. */
const BEARING_MIN = 0.6;

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

/** Structural cell kinds. */
const T = { Empty: 0, Slab: 1, Pillar: 2, Wall: 3, Window: 4, Stair: 5 } as const;

interface Spec {
  hp: number;
  /** front face offset from the building's front plane (z0); positive = sticks out */
  front: number;
  thick: number;
  /** horizontal member: has limited span between supports */
  span: boolean;
  /** takes part in load paths (windows don't) */
  structural: boolean;
}

const SPEC: Record<number, Spec> = {
  [T.Slab]:   { hp: 4, front: 0,             thick: DEPTH,       span: true,  structural: true },
  [T.Pillar]: { hp: 6, front: 0.25 * CELL,   thick: DEPTH,       span: false, structural: true },
  [T.Wall]:   { hp: 3, front: -0.125 * CELL, thick: 0.75 * CELL, span: true,  structural: true },
  [T.Window]: { hp: 1, front: -0.5 * CELL,   thick: 0.25 * CELL, span: false, structural: false },
  [T.Stair]:  { hp: 3, front: -1.25 * CELL,  thick: 2.5 * CELL,  span: false, structural: true },
};

type BayKind = 'window' | 'open' | 'blank' | 'stair';
interface Bay { kind: BayKind; width: number; start: number; /** per storey: open firing bay (no glazing/sill) */ open: boolean[] }

/** A floor opening enemies can stand in and shoot from. */
export interface Ledge { c0: number; c1: number; r: number; x: number }
const STORY = 5; // rows per storey: slab, spandrel, window, window, header

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
  private colors: THREE.Color[] = [];
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
  private mat = new THREE.Matrix4();

  constructor(
    x0: number, z0: number, tint: number, rnd: () => number,
    private debris: Debris, private dust: Dust,
  ) {
    this.x0 = x0; this.z0 = z0;

    // ---- layout: pillars between bays; variable height
    const stories = [1, 2, 2, 3, 3, 4, 5][Math.floor(rnd() * 7)];
    const nBays = 2 + Math.floor(rnd() * 3);
    const stairBay = rnd() < 0.5 ? Math.floor(rnd() * nBays) : -1;
    const bays: Bay[] = [];
    for (let i = 0; i < nBays; i++) {
      const kind: BayKind = i === stairBay ? 'stair' : rnd() < 0.5 ? 'open' : rnd() < 0.3 ? 'blank' : 'window';
      const open = Array.from({ length: stories }, (_, st) => st === 0 || rnd() < 0.7);
      bays.push({ kind, width: kind === 'stair' ? 2 : 3, start: 0, open });
    }
    // every building offers at least one firing bay
    if (!bays.some((b) => b.kind === 'open')) {
      const b = bays.find((x) => x.kind !== 'stair') ?? bays[0];
      if (b.kind !== 'stair') b.kind = 'open';
    }
    // per column: pillar, or (bay index, local column)
    const colInfo: { pillar: boolean; bay: number; local: number }[] = [{ pillar: true, bay: -1, local: 0 }];
    bays.forEach((b, i) => {
      b.start = colInfo.length;
      for (let l = 0; l < b.width; l++) colInfo.push({ pillar: false, bay: i, local: l });
      colInfo.push({ pillar: true, bay: -1, local: 0 });
    });
    this.cols = colInfo.length;
    this.rows = stories * STORY + 1;
    this.width = this.cols * CELL;
    this.height = this.rows * CELL;
    for (const b of bays) {
      if (b.kind !== 'open') continue;
      for (let st = 0; st < stories; st++) {
        if (b.open[st]) this.ledges.push({ c0: b.start, c1: b.start + b.width - 1, r: st * STORY, x: x0 + (b.start + b.width / 2) * CELL });
      }
    }

    this.type = new Uint8Array(this.cols * this.rows);
    this.hp = new Uint8Array(this.cols * this.rows);
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        this.type[c * this.rows + r] = this.cellType(colInfo[c], bays, r);
      }
    }

    // ---- ruin: missing roof, fallen upper pillars, holes in floors, shell damage, broken glazing
    this.ruin(colInfo, stories, rnd);
    for (let i = 0; i < this.type.length; i++) this.hp[i] = this.type[i] === T.Empty ? 0 : SPEC[this.type[i]].hp;
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

    // ---- instances
    const concrete = new THREE.Color(tint);
    const n = this.cols * this.rows;
    this.mesh = new THREE.InstancedMesh(BOX, MAT, n);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const q = new THREE.Quaternion();
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        const i = c * this.rows + r;
        const t = this.type[i];
        const col = this.cellColor(t, concrete, rnd);
        this.colors.push(col);
        this.mesh.setColorAt(i, col);
        if (t === T.Empty) { this.mesh.setMatrixAt(i, ZERO); continue; }
        const spec = SPEC[t];
        const zc = z0 + spec.front - spec.thick / 2;
        this.mat.compose(new THREE.Vector3(x0 + (c + 0.5) * CELL, (r + 0.5) * CELL, zc), q, new THREE.Vector3(CELL, CELL, spec.thick));
        this.mesh.setMatrixAt(i, this.mat);
      }
    }
    this.object.add(this.mesh);
  }

  /** Knock the building about so it reads as a ruin, not a clean block. Edits `type` in place. */
  private ruin(colInfo: { pillar: boolean }[], stories: number, rnd: () => number): void {
    const { cols, rows, type } = this;
    const kill = (c: number, r: number): void => {
      if (c < 0 || c >= cols || r < 1 || r >= rows) return; // the foundation row stays
      const i = c * rows + r;
      if (type[i] !== T.Empty) { type[i] = T.Empty; this.ruinCount++; }
    };
    const level = 0.4 + rnd() * 0.6; // how wrecked this one is

    // broken glazing and missing wall panels
    for (let c = 0; c < cols; c++) {
      for (let r = 1; r < rows; r++) {
        const t = type[c * rows + r];
        if (t === T.Window && rnd() < 0.1 + 0.35 * level) kill(c, r);
        else if (t === T.Wall && r >= STORY && rnd() < 0.15 * level) kill(c, r);
      }
    }
    // roof: gone, or partly gone
    const roofGone = rnd() < 0.55;
    for (let c = 0; c < cols; c++) if (roofGone ? rnd() < 0.85 : rnd() < 0.3 * level) kill(c, rows - 1);
    // ragged top storey
    const top0 = (stories - 1) * STORY + 1;
    for (let c = 0; c < cols; c++) {
      if (rnd() >= 0.7 * level) continue;
      const cut = top0 + Math.floor(rnd() * STORY);
      for (let r = cut + 1; r < rows; r++) kill(c, r);
    }
    // upper-level pillars that have fallen
    for (let c = 0; c < cols; c++) {
      if (!colInfo[c].pillar) continue;
      for (let st = 1; st < stories; st++) {
        if (rnd() < 0.2 * level) for (let k = 1; k < STORY; k++) kill(c, st * STORY + k);
      }
    }
    // holes in the floors above ground level
    for (let st = 1; st <= stories; st++) {
      if (rnd() >= 0.45 * level) continue;
      const start = Math.floor(rnd() * cols), len = 2 + Math.floor(rnd() * 4);
      for (let c = start; c < start + len; c++) kill(c, st * STORY);
    }
    // shell damage: bites out of the facade above the ground floor
    const bites = Math.floor(rnd() * (1 + 3 * level));
    for (let b = 0; b < bites; b++) {
      const cx = Math.floor(rnd() * cols), cy = STORY + Math.floor(rnd() * Math.max(1, rows - STORY)), rad = 1 + Math.floor(rnd() * 2);
      for (let c = cx - rad; c <= cx + rad; c++) for (let r = cy - rad; r <= cy + rad; r++) if ((c - cx) ** 2 + (r - cy) ** 2 <= rad * rad + 1) kill(c, r);
    }
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

  private cellType(col: { pillar: boolean; bay: number; local: number }, bays: Bay[], r: number): number {
    if (r % STORY === 0) return T.Slab; // foundation, floors, roof
    if (col.pillar) return T.Pillar;
    const bay = bays[col.bay];
    const kind = bay.kind;
    const k = r % STORY; // 1 spandrel, 2-3 glazing, 4 header
    if (kind === 'open' && bay.open[Math.floor(r / STORY)]) return k === 4 ? T.Wall : T.Empty; // firing bay: ledge + lintel
    if (kind === 'blank') return T.Wall;
    if (kind === 'stair') return (col.local === 0) === (k % 2 === 1) ? T.Stair : T.Empty; // zig-zag flights
    return k === 1 || k === 4 ? T.Wall : T.Window;
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

  /** Spawn data for an enemy that walks from the back of the floor to the ledge edge. */
  ledgeSpawn(l: Ledge): { pos: THREE.Vector3; ledgeZ: number; backZ: number; floorTop: (x: number, yMax: number) => number } {
    const y = (l.r + 1) * CELL;
    const backZ = this.z0 - DEPTH + 0.75 * CELL;
    const x = l.x + (Math.random() - 0.5) * 2 * CELL;
    return {
      pos: new THREE.Vector3(x, y, backZ),
      ledgeZ: this.z0 - 0.5 * CELL,
      backZ,
      floorTop: (fx, yMax) => this.floorTop(fx, yMax),
    };
  }

  /** Top of the highest intact floor slab under x that is at or below yMax (0 = ground). */
  floorTop(x: number, yMax: number): number {
    const c = Math.floor((x - this.x0) / CELL);
    if (c < 0 || c >= this.cols) return 0;
    for (let r = Math.min(this.rows - 1, Math.floor(yMax / CELL)); r >= 0; r--) {
      const i = c * this.rows + r;
      if (this.hp[i] > 0 && this.type[i] === T.Slab) return (r + 1) * CELL;
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
        // exact test against this member's own box
        const spec = SPEC[this.type[i]];
        const zf = this.z0 + spec.front, zb = zf - spec.thick;
        const bx0 = this.x0 + c * CELL, by0 = r * CELL;
        let a0 = 0, a1 = Infinity, miss = false;
        for (const [oo, dd, lo, hi] of [[o.x, d.x, bx0, bx0 + CELL], [o.y, d.y, by0, by0 + CELL], [o.z, d.z, zb, zf]] as const) {
          if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) { miss = true; break; } continue; }
          let t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
          if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
          a0 = Math.max(a0, t1); a1 = Math.min(a1, t2);
          if (a0 > a1) { miss = true; break; }
        }
        if (!miss) { out.set(o.x + d.x * a0, o.y + d.y * a0, o.z + d.z * a0); return a0; }
      }
      // advance to the next cell the ray enters
      if (tMaxX < tMaxY) { if (tMaxX > tf) break; c += stepX; tMaxX += tDX; }
      else { if (tMaxY > tf) break; r += stepY; tMaxY += tDY; }
    }
    return Infinity;
  }

  /** Apply damage in a circle (world xy). hit = a live cell was within the radius. */
  damage(px: number, py: number, radius: number): DamageResult {
    const res = { hit: false, destroyed: 0 };
    if (px < this.x0 - radius || px > this.x0 + this.width + radius || py > this.height + radius) return res;
    const cMin = Math.max(0, Math.floor((px - radius - this.x0) / CELL));
    const cMax = Math.min(this.cols - 1, Math.floor((px + radius - this.x0) / CELL));
    const rMin = Math.max(0, Math.floor((py - radius) / CELL));
    const rMax = Math.min(this.rows - 1, Math.floor((py + radius) / CELL));
    let changed = false;
    for (let c = cMin; c <= cMax; c++) {
      for (let r = rMin; r <= rMax; r++) {
        const i = c * this.rows + r;
        if (this.hp[i] === 0) continue;
        const cx = this.x0 + (c + 0.5) * CELL, cy = (r + 0.5) * CELL;
        if (Math.hypot(cx - px, cy - py) > radius + CELL * 0.35) continue;
        res.hit = changed = true;
        this.hp[i]--;
        if (this.hp[i] === 0) {
          res.destroyed++;
          this.breakCell(c, r, true);
        } else {
          this.tmpColor.copy(this.colors[i]).multiplyScalar(0.65);
          this.mesh.setColorAt(i, this.tmpColor); // cracked / scorched
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

  private cellCenter(c: number, r: number): THREE.Vector3 {
    const spec = SPEC[this.type[c * this.rows + r]];
    return new THREE.Vector3(this.x0 + (c + 0.5) * CELL, (r + 0.5) * CELL, this.z0 + spec.front - spec.thick / 2);
  }

  /** Top of the highest intact cell under (x, z) whose top is at or below yBelow; 0 = ground. */
  solidTop(x: number, z: number, yBelow: number): number {
    if (z > this.z0 + 0.4 * CELL || z < this.z0 - DEPTH) return 0;
    const c = Math.floor((x - this.x0) / CELL);
    if (c < 0 || c >= this.cols) return 0;
    for (let r = Math.min(this.rows - 1, Math.floor((yBelow + 0.05) / CELL) - 1); r >= 0; r--) {
      const i = c * this.rows + r;
      if (this.hp[i] === 0) continue;
      // thin members (glazing, walls) only occupy part of the depth: no standing on thin air behind them
      const spec = SPEC[this.type[i]];
      const zf = this.z0 + spec.front;
      if (z <= zf + 0.02 && z >= zf - spec.thick - 0.02) return (r + 1) * CELL;
    }
    return 0;
  }

  /** Is the point inside an intact member (respecting each member's real depth)? Used for small bodies like coals. */
  solidAt(x: number, y: number, z: number): boolean {
    if (x < this.x0 || x >= this.x0 + this.width || y < 0 || y >= this.height) return false;
    if (z > this.z0 + 0.4 * CELL || z < this.z0 - DEPTH) return false;
    const i = Math.floor((x - this.x0) / CELL) * this.rows + Math.floor(y / CELL);
    if (this.hp[i] === 0) return false;
    const spec = SPEC[this.type[i]];
    const zf = this.z0 + spec.front;
    return z <= zf + 0.005 && z >= zf - spec.thick - 0.005;
  }

  private floorFn = (x: number, z: number, y: number): number => this.solidTop(x, z, y);

  /** @param fallH height of the cell above where support was lost (structural collapse only) */
  private breakCell(c: number, r: number, byBullet: boolean, fallH = 0): void {
    const i = c * this.rows + r;
    const pos = this.cellCenter(c, r);
    pos.z = this.z0 + SPEC[this.type[i]].front; // spawn at the visible face
    this.hp[i] = 0;
    this.mesh.setMatrixAt(i, ZERO);
    this.debris.wakeNear(pos, CELL * 1.2); // rubble that was resting on this cell
    const col = this.colors[i];
    const glass = this.type[i] === T.Window;
    // Rubble comes in varied small pieces (never bigger than ~0.3): a soldier can see and be seen over
    // the small ones, and the big ones are not tall enough to hide a whole soldier for long.
    const piece = (lo: number, hi: number) => CELL * (lo + Math.random() * (hi - lo));
    if (byBullet) {
      const v = (spread: number, up: number) => new THREE.Vector3((Math.random() - 0.5) * spread, up * (0.3 + Math.random()), 1 + Math.random() * 3);
      for (let k = 0; k < 2; k++) this.debris.spawn(pos, col, glass ? piece(0.2, 0.35) : piece(0.4, 0.7), v(3, 3), this.floorFn);
      for (let k = 0; k < 2; k++) this.debris.spawn(pos, col, piece(0.2, 0.35), v(6, 4), this.floorFn);
      this.dust.puff(pos, glass ? 1 : 2, CELL * 2.2, 1.5);
    } else {
      // structural collapse: the member drops from somewhere within its depth, so it can crush whatever is inside
      const spec = SPEC[this.type[i]];
      // the structure topples out into the street like a falling wall: the higher the cell,
      // the harder it is thrown outward (+z), as if rotating about the base's front edge
      const outBase = Math.min(5, 1.0 + 0.6 * fallH);
      const n = this.debris.count > 6000 ? 2 : 3; // stay under the chunk cap in big levels
      for (let k = 0; k < n; k++) {
        pos.z = this.z0 + spec.front - Math.random() * spec.thick;
        const out = outBase * (0.7 + Math.random() * 0.6);
        this.debris.spawn(pos, col, piece(0.3, 0.75), new THREE.Vector3((Math.random() - 0.5) * 1.6, -0.5 - Math.random() * 0.5, out), this.floorFn);
      }
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
          if (hp[i] > 0 && (type[i] === T.Pillar || type[i] === T.Wall || type[i] === T.Stair)) alive++;
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
    const { rows, hp } = this;
    if (falling.length === 0) return;
    for (const i of falling) hp[i] = 0; // mark first so floor lookups see the final state
    let baseRow = rows;
    for (const i of falling) baseRow = Math.min(baseRow, i % rows);
    for (const i of falling) {
      const c = Math.floor(i / rows), r = i % rows;
      hp[i] = 1; // breakCell zeroes it again; keeps cellCenter/type lookups valid
      this.breakCell(c, r, false, (r - baseRow) * CELL);
    }
    this.dust.puff(new THREE.Vector3(this.x0 + this.width / 2, 0.5, this.z0 + 1.0), 4, CELL * 3, 2.5);
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
