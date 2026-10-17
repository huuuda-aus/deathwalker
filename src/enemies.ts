import * as THREE from 'three';
import type { Fx } from './fx';
import type { Blocker } from './debris';
import { MECH_SCALE, LANE } from './mech';
import { CAM_DIST } from './level';
import { SOLDIER } from './config';

const BODY = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.8 });
const SKIN = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
const GUN_IDLE = new THREE.MeshStandardMaterial({ color: 0x222222 });

/** Soldier is 1/8 of the mech's height, +15%. Model is authored ~2 units tall. */
export const SOLDIER_HEIGHT = ((4 * MECH_SCALE) / 8) * 1.15; // mech model is 4 units tall before scaling
const K = SOLDIER_HEIGHT / 2;

/** What a soldier needs to know about the world around it; supplied by whoever creates it. */
export interface SoldierEnv {
  /** fills `out` with rubble near a point, returns how many */
  blockers(x: number, z: number, radius: number, out: Blocker[]): number;
  /** true if the segment a -> b is free of rubble */
  sight(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** highest solid surface under (x, z) at or below y (0 = ground), so corpses fall until something is under them */
  surface(x: number, z: number, y: number): number;
}

/** height (world) the soldiers aim at on the mech */
const CHEST_Y = 1.6;
const SOLDIER_R = 0.127;      // body radius used for rubble avoidance
const LOOKAHEAD = 0.45;
/** a body that falls less than this lands without bursting (it only slid off a ledge) */
const PLUNGE_MIN_FALL = 0.8;
/** the blood pool left under a flattened soldier */
const BLOOD_GEO = new THREE.CircleGeometry(0.16, 14).rotateX(-Math.PI / 2).translate(0, 0.004, 0);
const BLOOD_MAT = new THREE.MeshBasicMaterial({ color: 0x5a0c0c, transparent: true, opacity: 0.85, depthWrite: false });
/** how far troops looking for cover search, and the longest they will run for a post (seconds) */
const COVER_SEARCH = 8;
const POST_RUN_MAX = 8;
/** the longest a soldier chases one firing spot before giving up on it (seconds) */
const GOAL_MAX = 3;
/** troops running and gunning only shoot at targets this close */
const RUN_GUN_RANGE = 14;
const BLOCKER_BUF: Blocker[] = Array.from({ length: 48 }, () => ({ x: 0, z: 0, r: 0 }));
/** steering headings tried relative to the straight line to the target (degrees) */
const TURNS = [0, 30, 60, 90, 120].map((d) => (d * Math.PI) / 180);

/** 'mounted': riding or manning something (a cannon): no AI, the owner sets its position */
export type SoldierState = 'enter' | 'jump' | 'walk' | 'aim' | 'cooldown' | 'dead' | 'mounted';

/** Standing on a building floor: walks from the back to the ledge, then shoots from there. */
export interface Perch {
  ledgeZ: number;
  backZ: number;
  floorTop: (x: number, z: number, yMax: number) => number;
}

/** What a bullet strike throws up: pixel sparks of these colours, plus glowing embers that bounce and cool. */
export interface ImpactFx { colors: number[]; sparks: number; embers: number }

/** flesh: a couple of red-orange specks */
export const FLESH_IMPACT: ImpactFx = { colors: [0xff3020, 0xff8040], sparks: 2, embers: 0 };

/** metal: a shower of white-hot sparks and a few embers that bounce off */
export const METAL_IMPACT: ImpactFx = { colors: [0xffe080, 0xffa030, 0xffffff], sparks: 7, embers: 2 };

/** A shot being fired: where the barrel is, and a random miss in -1..1 on each axis. */
export type ShotFn = (from: THREE.Vector3, miss: THREE.Vector3) => void;

/** What the manager, the gun and the debris need from anything that fights on the enemy side. */
export interface Enemy {
  readonly group: THREE.Object3D;
  /** how a bullet strike on it looks */
  readonly impact: ImpactFx;
  readonly alive: boolean;
  readonly x: number;
  /** seconds since it died (0 while alive) */
  readonly deadTime: number;
  /** set once the kill has been credited to the scene */
  counted: boolean;
  /** the scene is over: leave */
  retreating: boolean;
  /** retreat finished: safe to remove */
  readonly gone: boolean;
  getBox(out: THREE.Box3): THREE.Box3;
  /** Returns true if the hit killed. */
  damage(n: number, fx: Fx): boolean;
  /** onShoot: called when it fires at the player; the caller makes the bullet and aims it. */
  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: ShotFn): void;
  /** free anything it put in the scene outside `group` */
  dispose(): void;
}

export class Soldier implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = FLESH_IMPACT;
  hp: number = SOLDIER.hp;
  state: SoldierState = 'walk';
  /** hitbox half extents (padded for forgiveness) */
  readonly half = new THREE.Vector3(0.345, 0.2875, 0.345);
  centerY = SOLDIER_HEIGHT / 2;
  /** model scale; perched soldiers are enlarged to offset their extra distance from the camera */
  private k = K;
  private body = new THREE.Group();
  private timer = 0;
  private stopDist = 6 + Math.random() * 4;
  private phase = Math.random() * 6;
  private legs: THREE.Mesh[] = [];
  private gun: THREE.Mesh;
  private gunMat = GUN_IDLE.clone();
  private fallDir = 1;
  deadTime = 0;
  private vel = new THREE.Vector3();
  private fallStart = 0;
  /** height the soldier was standing at when killed (corpses stay on their floor) */
  private deadVy = 0;
  /** killed by being stepped on: lies flat where it stood */
  private squashed = false;
  /** thrown out of an upper floor: still falling, will burst on landing */
  private plunging = false;
  private plungeFrom = 0;
  private plungeVel = new THREE.Vector3();
  /** which way we are going round an obstacle (+1/-1), 0 = none; kept for a moment to avoid dithering */
  private avoid = 0;
  private avoidT = 0;
  private blockedT = 0;
  /** spot to step to when rubble blocks the line of fire */
  private goal: { x: number; z: number } | null = null;
  private losT = 0;
  /** seconds spent walking to the current firing spot, and how many spots in a row it gave up on */
  private goalT = 0;
  private goalFails = 0;
  private muzzleTmp = new THREE.Vector3();
  private missTmp = new THREE.Vector3();
  private sightA = new THREE.Vector3();
  private sightB = new THREE.Vector3();
  private perch: Perch | null = null;
  /** set when a retreating perched soldier has stepped back out of sight */
  gone = false;
  /** After the scene is cleared, survivors walk off to the left instead of fighting. */
  retreating = false;
  /** set once the kill has been credited to the scene */
  counted = false;
  /**
   * What it does once on the ground: 'normal' walks at the mech and stops to fire; troops off a truck run, either
   * 'scatter' to a spot of its own out in the street and fire from there, or to 'cover' behind the nearest big
   * rubble to fight from its edge. Neither closes in on the mech.
   */
  plan: 'normal' | 'scatter' | 'cover' = 'normal';
  /** where a troop is heading to fight from, how long it has been running there, and whether it has settled in */
  private post: { x: number; z: number } | null = null;
  private postT = 0;
  private holding = false;
  /** seconds until the next shot while running and gunning */
  private gunT = 0.5 + Math.random();

  constructor(x: number, z: number, private readonly env: SoldierEnv) {
    this.group.position.set(x, 0, z);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.35), BODY);
    torso.position.y = 1.1;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), SKIN);
    head.position.y = 1.7;
    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.36), BODY);
    helmet.position.y = 1.88;
    this.gun = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.1), this.gunMat);
    this.gun.position.set(0.35, 1.2, 0.2);
    for (const z of [-0.1, 0.1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.18), BODY);
      leg.geometry.translate(0, -0.35, 0);
      leg.position.set(0, 0.7, z);
      this.legs.push(leg);
      this.body.add(leg);
    }
    for (const m of [torso, head, helmet, this.gun, ...this.legs]) m.castShadow = true;
    this.body.add(torso, head, helmet, this.gun);
    this.body.scale.setScalar(this.k);
    this.group.add(this.body);
  }

  get x(): number { return this.group.position.x; }
  get z(): number { return this.group.position.z; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const c = this.group.position;
    const cy = c.y + this.centerY;
    out.min.set(c.x - this.half.x, cy - this.half.y, c.z - this.half.z);
    out.max.set(c.x + this.half.x, cy + this.half.y, c.z + this.half.z);
    return out;
  }

  get alive(): boolean { return this.state !== 'dead'; }

  dispose(): void {}

  /** Hand control to an owner (a cannon): no AI until `release`. */
  mount(): void { this.state = 'mounted'; }

  /** Put a mounted soldier at a spot, facing +1 (right) or -1 (left), swaying a little as it works. */
  station(x: number, y: number, z: number, facing: number, sway = 0): void {
    this.group.position.set(x, y, z);
    this.body.scale.x = facing * this.k;
    this.body.rotation.z = sway;
    this.fallDir = facing;
  }

  /** Leap off something (a truck): fall with this velocity until the ground is under us, then carry out `plan`. */
  launch(vel: THREE.Vector3): void {
    this.state = 'jump';
    this.vel.copy(vel);
    this.fallStart = this.group.position.y;
  }

  /** Back to being an ordinary infantryman on the ground. */
  release(): void {
    if (this.state !== 'mounted') return;
    this.state = 'walk';
    this.body.rotation.z = 0;
    this.group.position.y = 0;
  }

  /** Start inside a building at `from` (floor level) and head for the ledge. */
  perchAt(from: THREE.Vector3, perch: Perch): void {
    this.group.position.copy(from);
    // from deeper in the scene they would read smaller than street soldiers: match a soldier at z ~ 0.5
    const mul = (CAM_DIST - from.z) / (CAM_DIST - 0.5);
    this.k = K * mul;
    this.half.multiplyScalar(mul);
    this.centerY *= mul;
    this.body.scale.setScalar(this.k);
    this.perch = perch;
    this.state = 'enter';
  }

  /** Flattened under the mech's foot: dead on the spot, squashed flat in a pool of blood, no hop. */
  splat(fx: Fx): void {
    if (!this.alive) return;
    this.hp = 0;
    this.state = 'dead';
    this.deadTime = 0;
    this.deadVy = 0;
    this.flatten(fx);
  }

  /** Lie squashed flat in a pool of blood, with a spray of it. */
  private flatten(fx: Fx): void {
    this.squashed = true;
    this.body.scale.y = this.k * 0.08;
    this.body.rotation.z = 0;
    this.group.rotation.z = 0;
    this.group.add(new THREE.Mesh(BLOOD_GEO, BLOOD_MAT));
    const at = new THREE.Vector3(this.x, this.group.position.y + 0.05, this.z);
    fx.burst(at, 26, 3.5, [0x8a1010, 0xc02020, 0x601010, 0xffa040]);
    fx.sparks(at, 8, 3, [0xc02020, 0x8a1010]);
  }

  /** Returns true if the hit killed. */
  damage(n: number, fx: Fx): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.state = 'dead';
    this.deadTime = 0;
    if (this.group.position.y > SOLDIER.highFloorY && Math.random() < SOLDIER.plungeChance) {
      this.plunge();
      return true;
    }
    this.deadVy = 1.0; // a little hop as it drops
    fx.burst(new THREE.Vector3(this.x, this.group.position.y + this.centerY, this.z), 12, 2.5, [0x8a1010, 0xc02020, 0xffa040]);
    return true;
  }

  /**
   * Killed on an upper floor: no spray in the room. The body is flung out of the bay, tumbles down the front of the
   * building and bursts on whatever it lands on.
   */
  private plunge(): void {
    this.plunging = true;
    this.plungeFrom = this.group.position.y;
    this.deadVy = 3;
    // far enough forward (toward the camera) to clear the ledge from wherever in the room it was standing
    const toEdge = this.perch ? Math.max(0.3, this.perch.ledgeZ + 0.3 - this.group.position.z) : 0.3;
    this.plungeVel.set((Math.random() - 0.5) * 1.2, 0, THREE.MathUtils.clamp(toEdge / 0.3, 1.2, 9) * (1 + Math.random() * 0.3));
  }

  /**
   * Walk toward (ux, uz) while steering round rubble: try the straight heading, then
   * progressively wider turns (preferring the side we are already going round).
   * @returns false if every heading is blocked
   */
  private walkAround(dt: number, ux: number, uz: number, speed: number = SOLDIER.walkSpeed, reach = Infinity): boolean {
    const g = this.group;
    const nb = this.env.blockers(this.x, this.z, 1.0, BLOCKER_BUF);
    const clear = (px: number, pz: number): boolean => {
      for (let i = 0; i < nb; i++) {
        const b = BLOCKER_BUF[i];
        const lim = b.r + SOLDIER_R + 0.02;
        if ((px - b.x) ** 2 + (pz - b.z) ** 2 < lim * lim) return false;
      }
      return true;
    };
    this.avoidT -= dt;
    if (this.avoidT <= 0) this.avoid = 0;
    const first = this.avoid !== 0 ? this.avoid : Math.random() < 0.5 ? 1 : -1;

    let hx = 0, hz = 0, found = false, side = 0;
    outer: for (const turn of TURNS) {
      for (const sgn of turn === 0 ? [0] : [first, -first]) {
        const a = turn * sgn;
        const cx = Math.cos(a), sx = Math.sin(a);
        const x = ux * cx - uz * sx, z = ux * sx + uz * cx;
        if (clear(this.x + x * LOOKAHEAD * 0.5, this.z + z * LOOKAHEAD * 0.5) && clear(this.x + x * LOOKAHEAD, this.z + z * LOOKAHEAD)) {
          hx = x; hz = z; side = sgn; found = true;
          break outer;
        }
      }
    }
    if (!found) return false;
    if (side !== 0) { this.avoid = side; this.avoidT = 1.0; }

    // never step further than the spot being walked to: a long step (slow frame, run speed) would overshoot it, and
    // the next one overshoot back, leaving the soldier shuffling to and fro around it
    const step = Math.min(speed * dt, reach);
    g.position.x += hx * step;
    g.position.z = THREE.MathUtils.clamp(g.position.z + hz * step, Math.min(LANE.zMin, g.position.z), LANE.zMax);
    this.pushOut(nb);
    return true;
  }

  /** Fire one bullet, with a random miss. */
  private shoot(fx: Fx, dir: number, onShoot: ShotFn): void {
    const muzzle = this.muzzlePoint(dir);
    fx.sparks(muzzle, 2, 1.5, [0xffd080]);
    onShoot(muzzle, this.missTmp.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1));
  }

  private muzzlePoint(dir: number): THREE.Vector3 {
    return this.muzzleTmp.set(this.x + dir * 0.8 * this.k, this.group.position.y + 1.2 * this.k, this.z + 0.2 * this.k);
  }

  /** 'cover' / 'scatter' plans: run to the chosen post; once there (or out of time) hold it and fight from it. */
  private runToPost(dt: number, target: THREE.Vector3): boolean {
    if (!this.post) {
      // nothing to hide behind: scatter into the street instead
      this.post = (this.plan === 'cover' ? this.pickCover(target) : null) ?? this.pickScatter(target);
      this.postT = 0;
    }
    const dx = this.post.x - this.x, dz = this.post.z - this.z, d = Math.hypot(dx, dz);
    this.postT += dt;
    if (d < 0.08 || this.postT > POST_RUN_MAX) { this.holding = true; return false; }
    return this.walkAround(dt, dx / d, dz / d, SOLDIER.runSpeed, d);
  }

  /** A spot of its own: a little way along the street from where it landed, a good firing distance from the mech. */
  private pickScatter(target: THREE.Vector3): { x: number; z: number } {
    const standoff = SOLDIER.standoffMin + Math.random() * (SOLDIER.standoffMax - SOLDIER.standoffMin);
    let x = this.x + (Math.random() * 2 - 1) * SOLDIER.scatterSpread;
    const side = Math.sign(x - target.x) || (Math.random() < 0.5 ? -1 : 1);
    if (Math.abs(x - target.x) < standoff) x = target.x + side * standoff;       // never closer than the standoff
    return { x, z: LANE.zMin + Math.random() * (LANE.zMax - LANE.zMin) };
  }

  /** The spot just behind the nearest big chunk of rubble, as seen from the mech. */
  private pickCover(target: THREE.Vector3): { x: number; z: number } | null {
    const n = this.env.blockers(this.x, this.z, COVER_SEARCH, BLOCKER_BUF);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const b = BLOCKER_BUF[i];
      const d = (b.x - this.x) ** 2 + (b.z - this.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const b = BLOCKER_BUF[best];
    const ax = b.x - target.x, az = b.z - target.z, al = Math.hypot(ax, az) || 1;
    const off = b.r + SOLDIER_R + 0.12;
    return { x: b.x + (ax / al) * off, z: THREE.MathUtils.clamp(b.z + (az / al) * off, LANE.zMin, LANE.zMax) };
  }

  /** Clear line of fire from standing at (x, z) to the mech's chest? (rubble is cover, for both sides) */
  private hasLOS(target: THREE.Vector3, x = this.x, z = this.z): boolean {
    // both ways: his gun to the mech's chest, and the mech's guns down to his torso
    // (a soldier that cannot be hit must not be able to hit back)
    const gun = this.sightA.set(x, this.group.position.y + 1.2 * this.k, z + 0.2 * this.k);
    const chest = this.sightB.set(target.x, CHEST_Y, target.z);
    if (!this.env.sight(gun, chest)) return false;
    gun.set(x, this.group.position.y + this.centerY, z);
    return this.env.sight(chest, gun);
  }

  /**
   * Nearest nearby spot (growing ring) that is not inside rubble and has a clear line of fire,
   * i.e. where the soldier can stand at the edge of cover and be shot at as well as shoot.
   */
  private findExposedSpot(target: THREE.Vector3): { x: number; z: number } | null {
    const nb = this.env.blockers(this.x, this.z, 2.4, BLOCKER_BUF);
    const start = Math.random() * Math.PI * 2;
    for (const rad of [0.35, 0.7, 1.1, 1.6, 2.2]) {
      for (let k = 0; k < 12; k++) {
        const a = start + (k * Math.PI) / 6;
        const cx = this.x + Math.cos(a) * rad;
        const cz = THREE.MathUtils.clamp(this.z + Math.sin(a) * rad, Math.min(LANE.zMin, this.z), LANE.zMax);
        let free = true;
        for (let i = 0; i < nb && free; i++) {
          const b = BLOCKER_BUF[i];
          const lim = b.r + SOLDIER_R + 0.03;
          if ((cx - b.x) ** 2 + (cz - b.z) ** 2 < lim * lim) free = false;
        }
        if (!free || Math.hypot(target.x - cx, target.z - cz) < 3) continue;
        if (this.hasLOS(target, cx, cz)) return { x: cx, z: cz };
      }
    }
    return null;
  }

  /** Hard collision: never end a frame inside rubble (also covers chunks rolling into us). */
  private pushOut(nb: number): void {
    const g = this.group;
    for (let i = 0; i < nb; i++) {
      const b = BLOCKER_BUF[i];
      const dx = g.position.x - b.x, dz = g.position.z - b.z;
      const lim = b.r + SOLDIER_R;
      const d2 = dx * dx + dz * dz;
      if (d2 >= lim * lim) continue;
      const d = Math.sqrt(d2) || 1e-4;
      g.position.x = b.x + (dx / d) * lim;
      g.position.z = b.z + (dz / d) * lim;
    }
  }

  /** onShoot: called for each bullet the soldier fires at the player; the caller makes the bullet and aims it. */
  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: ShotFn): void {
    const g = this.group;
    if (this.state === 'mounted') return;
    if (this.state === 'dead') {
      this.deadTime += dt;
      const k = Math.min(1, this.deadTime / 0.35);
      if (this.plunging) {
        g.rotation.z -= this.fallDir * 7 * dt;                // tumbling as it falls
        g.position.x += this.plungeVel.x * dt;
        g.position.z += this.plungeVel.z * dt;
      } else if (!this.squashed) {
        g.rotation.z = -this.fallDir * k * 1.5;
      }
      // corpses obey gravity too: fall until a floor (or the ground) is under them
      const ground = Math.max(0, this.env.surface(this.x, this.z, g.position.y + 0.05));
      this.deadVy -= 16 * dt;
      g.position.y = Math.max(ground, g.position.y + this.deadVy * dt);
      if (g.position.y <= ground) {
        this.deadVy = 0;
        if (this.plunging && this.plungeFrom - ground > PLUNGE_MIN_FALL) this.flatten(fx);
        this.plunging = false;
      }
      return;
    }
    if (this.state === 'jump') {
      // fell through a broken floor: drop until something solid is under us
      this.vel.y -= 16 * dt;
      g.position.addScaledVector(this.vel, dt);
      this.body.scale.x = (Math.sign(target.x - this.x) || 1) * this.k;
      const land = this.perch ? this.perch.floorTop(this.x, this.z, g.position.y + 0.05) : 0;
      if (g.position.y <= land) {
        const fell = this.fallStart - land;
        g.position.y = land;
        this.state = 'walk';
        this.perch = null;
        if (fell > 0.7) this.damage(99, fx); // the floor went out from under it
      }
      return;
    }
    if (this.retreating && this.perch) {
      // perched soldiers step back into the building and disappear
      this.body.scale.x = this.k;
      g.position.z -= 1.5 * dt;
      this.phase += dt * 9;
      this.legs[0].rotation.z = Math.sin(this.phase) * 0.6;
      this.legs[1].rotation.z = -Math.sin(this.phase) * 0.6;
      if (g.position.z <= this.perch.backZ) this.gone = true;
      return;
    }
    if (this.retreating) {
      this.body.scale.x = -this.k;
      g.position.x -= 4 * dt;
      this.pushOut(this.env.blockers(this.x, this.z, 0.6, BLOCKER_BUF));
      this.phase += dt * 12;
      this.legs[0].rotation.z = Math.sin(this.phase) * 0.6;
      this.legs[1].rotation.z = -Math.sin(this.phase) * 0.6;
      return;
    }
    const dxT = target.x - this.x;
    const dzT = target.z - this.z;
    const dir = Math.sign(dxT) || 1;
    this.fallDir = dir;
    this.body.scale.x = dir * this.k; // flip to face target; model faces +x
    const dist = Math.hypot(dxT, dzT);

    // a perched soldier whose floor was shot away falls
    if (this.perch && this.perch.floorTop(this.x, this.z, g.position.y + 0.05) < g.position.y - 0.03) {
      this.state = 'jump';
      this.vel.set(0, 0, 0);
      this.fallStart = g.position.y;
      return;
    }

    if (this.state === 'enter' && this.perch) {
      g.position.z += 1.0 * dt;
      this.phase += dt * 9;
      this.legs[0].rotation.z = Math.sin(this.phase) * 0.6;
      this.legs[1].rotation.z = -Math.sin(this.phase) * 0.6;
      if (g.position.z >= this.perch.ledgeZ) {
        g.position.z = this.perch.ledgeZ;
        this.state = 'aim';
        this.timer = 0.6;
      }
    } else if (this.state === 'walk') {
      let moved = false;
      const pace = this.plan === 'normal' ? SOLDIER.walkSpeed : SOLDIER.runSpeed;
      if (this.plan !== 'normal' && !this.holding) {
        moved = this.runToPost(dt, target);
      } else if (dist > this.stopDist && !this.holding) {
        this.goal = null;
        moved = this.walkAround(dt, dxT / dist, dzT / dist, pace);
        if (moved) {
          this.blockedT = 0;
        } else {
          // boxed in by rubble: wait, and open fire only if there is a line of fire
          this.blockedT += dt;
          if (this.blockedT > 1.5 && dist < 14 && this.hasLOS(target)) { this.state = 'aim'; this.timer = 0.6; this.blockedT = 0; }
        }
      } else if (this.hasLOS(target)) {
        this.goal = null;
        this.goalFails = 0;
        this.state = 'aim';
        this.timer = 0.6;
      } else {
        // in range but rubble is in the way: step out to where there is a clear line of fire
        this.losT -= dt;
        if (!this.goal && this.losT <= 0) { this.goal = this.findExposedSpot(target); this.losT = 0.4; this.goalT = 0; }
        if (this.goal) {
          const gx = this.goal.x - this.x, gz = this.goal.z - this.z, gd = Math.hypot(gx, gz);
          this.goalT += dt;
          if (gd < 0.06) this.goal = null;
          else if (this.goalT > GOAL_MAX) {
            // not getting there: stand and wait, for longer each time it happens
            this.goal = null;
            this.goalFails++;
            this.losT = 1.5 * this.goalFails * this.goalFails;
          }
          else { moved = this.walkAround(dt, gx / gd, gz / gd, pace, gd); if (!moved) this.goal = null; }
        } else if (dist > 3 && !this.holding) {
          moved = this.walkAround(dt, dxT / dist, dzT / dist, pace); // no spot found: close in instead
        }
      }
      if (moved && this.plan === 'scatter') {
        // running and gunning: shoot on the move whenever there is a line of fire
        this.gunT -= dt;
        if (this.gunT <= 0 && dist < RUN_GUN_RANGE && this.hasLOS(target)) {
          this.gunT = 1.4 + Math.random() * 1.4;
          this.shoot(fx, dir, onShoot);
        }
      }
      if (moved) {
        this.phase += dt * (this.plan === 'normal' ? 9 : 16);
        this.legs[0].rotation.z = Math.sin(this.phase) * 0.6;
        this.legs[1].rotation.z = -Math.sin(this.phase) * 0.6;
      } else {
        this.legs.forEach((l) => (l.rotation.z = 0));
      }
    } else if (this.state === 'aim') {
      this.legs.forEach((l) => (l.rotation.z = 0));
      this.timer -= dt;
      const blink = Math.floor(this.timer * 20) % 2 === 0;
      this.gunMat.color.setHex(blink ? 0xff5030 : 0x222222);
      this.gunMat.emissive.setHex(blink ? 0xff3010 : 0x000000);
      if (this.timer <= 0) {
        this.gunMat.color.setHex(0x222222);
        this.gunMat.emissive.setHex(0x000000);
        if (!this.hasLOS(target)) {
          // rubble moved into the line: do not fire into cover, find a better spot (or retry from the ledge)
          this.state = this.perch ? 'cooldown' : 'walk';
          this.timer = 0.4;
          this.losT = 0;
        } else {
          this.shoot(fx, dir, onShoot);
          this.state = 'cooldown';
          this.timer = 1.2 + Math.random() * 1.3;
        }
      }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) {
        // perched soldiers keep shooting from the ledge instead of walking
        this.state = this.perch ? 'aim' : 'walk';
        this.timer = 0.6;
      }
    }
  }
}
