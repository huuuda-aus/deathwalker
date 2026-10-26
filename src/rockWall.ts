import * as THREE from 'three';
import type { Blocker, Debris } from './debris';
import type { Dust } from './dust';
import { terrainHeight } from './terrain';
import { mulberry32 } from './util';

/** a dry-stone wall: two stones deep */
const DEPTH_OFFSET = 0.16;
/**
 * How much punishment a stone takes. The city's walls give a cell three hits; the stones are 30% tougher than that, so about four
 * bullets to dislodge one (a shell's blast, hundreds, takes every stone near it at once).
 */
const STONE_HP = 3 * 1.3;
/** how big a stone counts as for bullets and line of sight, and the posts the infantry steer round (they form a continuous line) */
const STONE_R = 0.21, POST_GAP = 0.45, POST_R = 0.32;
const COLOURS = [0x8a7a66, 0x9c8a70, 0x7a6a58, 0xa89478, 0x6e5f4e, 0x93826a].map((c) => new THREE.Color(c));
/** faceted, flat-ish stones: a dodecahedron, squashed differently for every stone */
const GEO = new THREE.DodecahedronGeometry(0.5, 0);
const MAT = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
MAT.userData.shared = true;

/** the wall's pieces are chosen in cells of this length, so they are the same whichever chunk of the street asks for them */
const CELL = 48;
/** pieces take about this share of the street's length (a little more is asked for than is wanted: the spacing between them runs long) */
const DENSITY = 0.38;

/** one standing stretch of wall: where it runs, how many courses high, how far out from the walkway it stands, and how ragged its two ends are */
interface Piece { a: number; b: number; courses: number; out: number; raggedA: number; raggedB: number }

/**
 * The pieces of wall on one side of the street between x0 and x1: spotty and uneven, some long, some short, some low, some high, each
 * standing a little differently far out, with a stepped, ragged end. About `DENSITY` of the street is wall. Deterministic: the same
 * stretch of street always gets the same pieces.
 */
function pieces(x0: number, x1: number, side: number): Piece[] {
  const out: Piece[] = [];
  for (let k = Math.floor(x0 / CELL) - 1; k <= Math.floor(x1 / CELL); k++) {
    const rng = mulberry32(k * 977 + side * 131 + 5);
    let x = k * CELL + rng() * 14;
    while (x < (k + 1) * CELL) {
      const length = Math.min(1.2 + rng() ** 1.5 * 7.8, (k + 1) * CELL - 0.5 - x);       // never into the next cell: its pieces would stand through this one's
      if (length < 1.0) break;
      const piece: Piece = { a: x, b: x + length, courses: 2 + Math.floor(rng() * 3), out: rng() * 0.4, raggedA: 0.1 + rng() * 0.25, raggedB: 0.1 + rng() * 0.25 };
      if (piece.b > x0 && piece.a < x1) out.push(piece);
      x += length + (length * (1 - DENSITY)) / DENSITY * (0.4 + rng() * 1.2);
    }
  }
  return out;
}

interface Stone {
  x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; tz: number; colour: THREE.Color;
  course: number; depth: number; hp: number;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Low dry-stone walls along one side of the street: courses of flat, faceted stones laid in a running bond, each stone resting on the
 * ones beneath it, straight, in spotty pieces of different lengths and heights. The infantry shelter behind them (they are a line of
 * obstacles for them to steer round and a thing no bullet or line of sight passes), and they are built to be wrecked: a stone takes
 * a few bullets, a shell blows a breach, the mech wading through knocks stones off; stones that lose what they rest on fall; and
 * what comes off flies. One instanced mesh for the lot.
 */
export class RockWall {
  readonly mesh: THREE.InstancedMesh;
  readonly minX: number;
  readonly maxX: number;
  private readonly stones: Stone[];
  private readonly alive: Uint8Array;
  /** the stones in order of x, so a search can start in the right place */
  private readonly xs: Float32Array;
  private readonly posts: { x: number; z: number; live: number }[] = [];
  private readonly postX0: number;

  /** @param x0,x1 the length it covers; @param base where the walkway's edge lies (z) and which way out from it is `outward` (+1 or -1); @param side 0 or 1: which of the two walls (so they differ) */
  constructor(x0: number, x1: number, base: number, outward: number, side: number, private readonly debris: Debris, private readonly dust: Dust) {
    const stones: Stone[] = [];
    const rng = mulberry32(Math.floor(x0) * 31 + side * 7 + 3);
    for (const piece of pieces(x0, x1, side)) {
      for (let d = 0; d < 2; d++) {
        const z = base + outward * (piece.out + (d ? DEPTH_OFFSET : -DEPTH_OFFSET) + 0.3);
        // the stones of the course below, to stand on: this lane's, in order of x
        let below: Stone[] = [];
        for (let c = 0; c < piece.courses; c++) {
          // courses shorten toward their ends and toward the top, so the ends step down
          const from = piece.a + c * piece.raggedA, to = piece.b - c * piece.raggedB;
          const lane: Stone[] = [];
          if (to - from > 0.3) {
            let x = from + ((c + d) % 2) * 0.12 + rng() * 0.04;
            while (x < to) {
              const length = Math.min(0.3 + rng() * 0.16, to - x + 0.05);
              if (length < 0.18) break;
              const cx = x + length / 2;
              const sy = c === piece.courses - 1 ? 0.13 : 0.14;
              // rest on whatever is beneath: the highest top among the stones below that this one overlaps (the ground, for the first course)
              let top = terrainHeight(cx, z) - 0.01;
              for (const s of below) if (Math.abs(s.x - cx) < (s.sx + length) / 2 - 0.01) top = Math.max(top, s.y + s.sy / 2);
              if (cx >= x0 && cx < x1) {
                const st: Stone = {
                  x: cx, z, y: top + sy / 2 - 0.005, sx: length, sy, sz: 0.22 + rng() * 0.08,
                  ry: (rng() - 0.5) * 0.2, tz: (rng() - 0.5) * 0.1, colour: COLOURS[Math.floor(rng() * COLOURS.length)],
                  course: c, depth: d, hp: STONE_HP,
                };
                stones.push(st); lane.push(st);
              } else {
                // outside this chunk, but its neighbour will build it: keep its place for the stones above
                lane.push({ x: cx, z, y: top + sy / 2 - 0.005, sx: length, sy, sz: 0.25, ry: 0, tz: 0, colour: COLOURS[0], course: c, depth: d, hp: STONE_HP });
              }
              x += length + 0.01;
            }
          }
          below = lane;
        }
      }
    }
    stones.sort((a, b) => a.x - b.x);
    this.stones = stones;
    this.alive = new Uint8Array(stones.length).fill(1);
    this.xs = Float32Array.from(stones.map((s) => s.x));
    this.minX = x0; this.maxX = x1;
    this.mesh = new THREE.InstancedMesh(GEO, MAT, Math.max(1, stones.length));
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    stones.forEach((s, i) => {
      tmpQuat.setFromEuler(tmpEuler.set(0, s.ry, s.tz));
      this.mesh.setMatrixAt(i, tmpMatrix.compose(new THREE.Vector3(s.x, s.y, s.z), tmpQuat, new THREE.Vector3(s.sx, s.sy, s.sz)));
      this.mesh.setColorAt(i, s.colour);
    });
    this.mesh.count = stones.length;
    // the line of posts the infantry steer round and take cover behind: every so often along the wall, wherever stones stand
    this.postX0 = Math.ceil(x0 / POST_GAP) * POST_GAP;
    for (let x = this.postX0; x < x1; x += POST_GAP) this.posts.push({ x, z: 0, live: 0 });
    for (const s of stones) { const p = this.post(s.x); p.z = (p.z * p.live + s.z) / (p.live + 1); p.live++; }        // each post stands on the middle of the wall's two lanes
  }

  private post(x: number): { x: number; z: number; live: number } {
    return this.posts[Math.min(this.posts.length - 1, Math.max(0, Math.round((x - this.postX0) / POST_GAP)))];
  }

  /** first stone whose x is at least `x` */
  private from(x: number): number {
    let lo = 0, hi = this.xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.xs[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Does the segment a -> b cross a stone? If so, `out` is where it first does. */
  segmentHit(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3, endSlack = 0.1): boolean {
    const lo = Math.min(a.x, b.x) - 0.4, hi = Math.max(a.x, b.x) + 0.4;
    if (hi < this.minX || lo > this.maxX) return false;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len2 = dx * dx + dy * dy + dz * dz, len = Math.sqrt(len2);
    if (len < 1e-4) return false;
    let best = Infinity;
    const R = STONE_R * 1.1;
    for (let i = this.from(lo); i < this.xs.length && this.xs[i] <= hi; i++) {
      if (!this.alive[i]) continue;
      const s = this.stones[i];
      const ox = s.x - a.x, oy = s.y - a.y, oz = s.z - a.z;
      const tc = Math.min(1, Math.max(0, (ox * dx + oy * dy + oz * dz) / len2));
      const qx = dx * tc - ox, qy = dy * tc - oy, qz = dz * tc - oz;
      const d2 = qx * qx + qy * qy + qz * qz;
      if (d2 > R * R) continue;
      const entry = Math.max(0, tc - Math.sqrt(R * R - d2) / len);
      if ((1 - entry) * len < endSlack) continue;
      if (entry < best) best = entry;
    }
    if (best === Infinity) return false;
    out.set(a.x + dx * best, a.y + dy * best, a.z + dz * best);
    return true;
  }

  /** the posts near (x, z), added to `out` from index `n`; returns the new count. With `sideZ`, only the posts a soldier standing at that z could shelter behind (he must be outside the wall already). */
  blockers(x: number, z: number, radius: number, out: Blocker[], n: number, sideZ?: number): number {
    if (x + radius < this.minX || x - radius > this.maxX) return n;
    const i0 = Math.max(0, Math.floor((x - radius - this.postX0) / POST_GAP)), i1 = Math.min(this.posts.length - 1, Math.ceil((x + radius - this.postX0) / POST_GAP));
    for (let i = i0; i <= i1; i++) {
      const p = this.posts[i];
      if (p.live < 2 || Math.hypot(p.x - x, p.z - z) > radius) continue;
      if (sideZ !== undefined && (p.z > 0 ? sideZ < p.z + 0.2 : sideZ > p.z - 0.2)) continue;           // a soldier on the walkway side of the wall cannot get behind it
      if (n >= out.length) return n;                                  // (the list is a fixed size)
      const b = out[n++];
      b.x = p.x; b.z = p.z; b.r = POST_R;
    }
    return n;
  }

  /**
   * Punish every stone within `radius` of `at`: each loses `power` times how close it is to the middle, a stone with nothing left comes off, and
   * whatever then has nothing under it falls too.
   * @param gentle what comes off is not thrown far (the mech wading through)
   */
  damage(at: THREE.Vector3, radius: number, power: number, gentle = false): number {
    if (at.x + radius < this.minX || at.x - radius > this.maxX) return 0;
    let knocked = 0;
    for (let i = this.from(at.x - radius); i < this.xs.length && this.xs[i] <= at.x + radius; i++) {
      if (!this.alive[i]) continue;
      const s = this.stones[i];
      const d = Math.sqrt((s.x - at.x) ** 2 + (s.y - at.y) ** 2 + (s.z - at.z) ** 2);
      if (d > radius) continue;
      // a stone takes the full blow if the hit is on it (the hit point of a bullet is on the stone's surface), less the further off it is
      s.hp -= power * (1 - 0.6 * Math.min(1, Math.max(0, d - STONE_R) / Math.max(0.05, radius - STONE_R)));
      if (s.hp <= 0) { this.remove(i, at, gentle); knocked++; }
    }
    if (knocked > 0) {
      knocked += this.settle(at.x - radius - 0.7, at.x + radius + 0.7, at);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dust.puff(at, 2 + Math.min(6, knocked >> 2), 0.25, 1.2);
    }
    return knocked;
  }

  /** the stone comes off: gone from the wall, and (mostly) a piece of rubble flying */
  private remove(i: number, from: THREE.Vector3, gentle: boolean): void {
    const s = this.stones[i];
    this.alive[i] = 0;
    this.post(s.x).live--;
    this.mesh.setMatrixAt(i, ZERO);
    if (Math.random() < 0.7) {
      const d = Math.hypot(s.x - from.x, s.z - from.z) || 1, push = gentle ? 0.8 : 3;
      const vel = new THREE.Vector3(((s.x - from.x) / d) * push * (0.5 + Math.random()), (gentle ? 0.8 : 2.2) + Math.random() * 2, ((s.z - from.z) / d) * push * (0.5 + Math.random()));
      this.debris.spawn(new THREE.Vector3(s.x, s.y, s.z), s.colour, 0.14 + Math.random() * 0.1, vel);
    }
  }

  /** every stone in x range with nothing under it (in its own lane, one course down) falls: until nothing more does */
  private settle(x0: number, x1: number, from: THREE.Vector3): number {
    let fallen = 0;
    for (let pass = 0; pass < 8; pass++) {
      let any = false;
      for (let i = this.from(x0); i < this.xs.length && this.xs[i] <= x1; i++) {
        if (!this.alive[i]) continue;
        const s = this.stones[i];
        if (s.course === 0) continue;
        let held = false;
        for (let j = this.from(s.x - 0.6); j < this.xs.length && this.xs[j] <= s.x + 0.6; j++) {
          if (!this.alive[j]) continue;
          const t = this.stones[j];
          if (t.course === s.course - 1 && t.depth === s.depth && Math.abs(t.x - s.x) < (t.sx + s.sx) / 2 - 0.02) { held = true; break; }
        }
        if (!held) { this.remove(i, from, true); fallen++; any = true; }
      }
      if (!any) break;
    }
    return fallen;
  }

  dispose(): void { this.mesh.dispose(); }
}
