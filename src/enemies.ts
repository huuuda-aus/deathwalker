import * as THREE from 'three';
import type { Fx } from './fx';
import type { Blocker } from './debris';
import type { Carrier } from './building';
import { MECH_SCALE, LANE, clearOfWalls } from './mech';
import { CAM_DIST } from './level';
import { WEAPON, SOLDIER } from './config';
import { sfx } from './sfx';

const BODY = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.8 });
const SKIN = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
const GUN_IDLE = new THREE.MeshStandardMaterial({ color: 0x222222 });

/** Soldier is 1/8 of the mech's height, +15%. Model is authored ~2 units tall. */
export const SOLDIER_HEIGHT = ((4 * MECH_SCALE) / 8) * 1.15; // mech model is 4 units tall before scaling
/** soldiers are drawn this much bigger than the reference height (the cannon, horse and truck are sized from SOLDIER_HEIGHT and stay as they were) */
const SOLDIER_SCALE = 1.15;
const K = (SOLDIER_HEIGHT / 2) * SOLDIER_SCALE;

/** What a soldier needs to know about the world around it; supplied by whoever creates it. */
export interface SoldierEnv {
  /** fills `out` with rubble near a point, returns how many */
  blockers(x: number, z: number, radius: number, out: Blocker[]): number;
  /** true if the segment a -> b is free of rubble */
  sight(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** highest solid surface under (x, z) at or below y (0 = ground), so corpses fall until something is under them */
  surface(x: number, z: number, y: number): number;
  /** like `blockers`, for choosing cover (optional): only what a soldier at (x, z) can really get behind */
  cover?(x: number, z: number, radius: number, out: Blocker[]): number;
  /** every enemy in the game, so soldiers can keep clear of each other (optional) */
  others?(): readonly Enemy[];
  /** the stretch of the street (x) that is on screen at depth z, inset a little: soldiers have to fight inside it (optional) */
  arena?(z: number): { min: number; max: number };
}

/** height (world) the soldiers aim at on the mech */
const CHEST_Y = 1.6;
const SOLDIER_R = 0.127;      // body radius used for rubble avoidance
const LOOKAHEAD = 0.45;
/** a soldier riding a collapse is buried after this long even if the block never settles (seconds) */
const RIDE_MAX = 8;
/** a body that falls less than this lands without bursting (it only slid off a ledge) */
const PLUNGE_MIN_FALL = 0.8;
/** the blood pool left under a flattened soldier */
const BLOOD_GEO = new THREE.CircleGeometry(0.16, 14).rotateX(-Math.PI / 2).translate(0, 0.004, 0);
const BLOOD_MAT = new THREE.MeshBasicMaterial({ color: 0x5a0c0c, transparent: true, opacity: 0.85, depthWrite: false });
/** how far troops looking for cover search, and the longest they will run for a post (seconds) */
const COVER_SEARCH = 8;
const POST_RUN_MAX = 8;
/** a soldier hurrying back on screen heads for a point this far inside the edge, so it does not hover on it */
const ARENA_ENTRY = 0.6;
/** the longest a soldier chases one firing spot before giving up on it (seconds) */
const GOAL_MAX = 3;
/** troops running and gunning only shoot at targets this close */
const RUN_GUN_RANGE = 14;
const BLOCKER_BUF: Blocker[] = Array.from({ length: 48 }, () => ({ x: 0, z: 0, r: 0 }));
/** steering headings tried relative to the straight line to the target (degrees) */
const TURNS = [0, 30, 60, 90, 120].map((d) => (d * Math.PI) / 180);

/** 'mounted': riding or manning something (a cannon): no AI, the owner sets its position */
export type SoldierState = 'enter' | 'jump' | 'ride' | 'walk' | 'aim' | 'cooldown' | 'dead' | 'mounted';

/** Standing on a building floor: walks from the back to the ledge, then shoots from there. */
export interface Perch {
  ledgeZ: number;
  backZ: number;
  floorTop: (x: number, z: number, yMax: number) => number;
  /** the collapsing block that took the floor from under (x, y), if the floor came down with one */
  carrierAt: (x: number, y: number) => Carrier | null;
}

/** What a bullet strike throws up: pixel sparks of these colours, plus glowing embers that bounce and cool. */
export interface ImpactFx { colors: number[]; sparks: number; embers: number; sound: 'flesh' | 'metal' }

/** flesh: a couple of red-orange specks */
export const FLESH_IMPACT: ImpactFx = { colors: [0xff3020, 0xff8040], sparks: 2, embers: 0, sound: 'flesh' };

/** metal: a shower of white-hot sparks and a few embers that bounce off */
export const METAL_IMPACT: ImpactFx = { colors: [0xffe080, 0xffa030, 0xffffff], sparks: 7, embers: 2, sound: 'metal' };

/** A shot being fired: where the barrel is, and a random miss in -1..1 on each axis. */
export type ShotFn = (from: THREE.Vector3, miss: THREE.Vector3, opts?: ShotOpts) => void;

/** How a shot differs from a rifleman's: `precision` scales the miss (below 1 = better aim), `speed` is the bullet's, `heavy` is a machine gun's round */
export interface ShotOpts { precision?: number; speed?: number; heavy?: boolean }

/** What the manager, the gun and the debris need from anything that fights on the enemy side. */
export interface Enemy {
  readonly group: THREE.Object3D;
  /** how a bullet strike on it looks */
  readonly impact: ImpactFx;
  readonly alive: boolean;
  /** the target lock holds on to it even when it is off the screen (a missile that has climbed out of view) */
  readonly lockAnywhere?: boolean;
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
  /** Returns true if the hit killed. `push`: the velocity a bullet gives something it kills (along its path). */
  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean;
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
  /** what killed him, for the score: set by whatever does it (a bullet unless said otherwise) */
  cause: 'bullet' | 'stomp' | 'crush' | 'blast' | 'air' = 'bullet';
  /** hitbox half extents (padded for forgiveness) */
  readonly half = new THREE.Vector3(0.345, 0.2875, 0.345).multiplyScalar(SOLDIER_SCALE);
  centerY = (SOLDIER_HEIGHT / 2) * SOLDIER_SCALE;
  /** model scale; perched soldiers are enlarged to offset their extra distance from the camera */
  protected k = K;
  protected body = new THREE.Group();
  /** the head and the helmet on it (the machine gunner keeps them upright when he lies down) */
  /** whatever kills him from a height makes him plunge, screaming (a paratrooper whose canopy is shot away) */
  protected forcePlunge = false;
  protected head: THREE.Mesh;
  protected helmet: THREE.Mesh;
  protected timer = 0;
  protected stopDist = 6 + Math.random() * 4;
  protected phase = Math.random() * 6;
  /** 0 = standing, 1 = down on one knee behind cover */
  protected kneel = 0;
  protected readonly stand = { centerY: (SOLDIER_HEIGHT / 2) * SOLDIER_SCALE, halfY: 0.2875 * SOLDIER_SCALE };
  protected legs: THREE.Mesh[] = [];
  /** shown only while a soldier is plunging from a building, flailing */
  protected arms: THREE.Mesh[] = [];
  protected gun: THREE.Mesh;
  protected gunMat = GUN_IDLE.clone();
  protected fallDir = 1;
  deadTime = 0;
  protected vel = new THREE.Vector3();
  protected fallStart = 0;
  /** height the soldier was standing at when killed (corpses stay on their floor) */
  protected deadVy = 0;
  /** killed by being stepped on: lies flat where it stood */
  protected squashed = false;
  /** thrown out of an upper floor: still falling, will burst on landing */
  /** riding a collapsing floor down: the block, where he stood and where the block was when it took him, and for how long */
  protected ride: Carrier | null = null;
  protected rideT = 0;
  protected rideBase = new THREE.Vector3();
  protected rideFrom = new THREE.Vector3();
  protected plunging = false;
  protected plungeFrom = 0;
  protected plungeVel = new THREE.Vector3();
  /** the bullet's push on a soldier it killed: slides him along until it dies away */
  protected fling = new THREE.Vector3();
  /** which way we are going round an obstacle (+1/-1), 0 = none; kept for a moment to avoid dithering */
  protected avoid = 0;
  protected avoidT = 0;
  protected blockedT = 0;
  /** for noticing a soldier who runs without getting anywhere: the clock, and where he was when it began */
  private stuckT = 0;
  private stuckX = 0;
  private stuckZ = 0;
  /** spot to step to when rubble blocks the line of fire */
  protected goal: { x: number; z: number } | null = null;
  protected losT = 0;
  /** seconds spent walking to the current firing spot, and how many spots in a row it gave up on */
  protected goalT = 0;
  protected goalFails = 0;
  /** how long it has been unable to make headway getting back on screen */
  protected offscreenT = 0;
  protected muzzleTmp = new THREE.Vector3();
  protected missTmp = new THREE.Vector3();
  protected sightA = new THREE.Vector3();
  protected sightB = new THREE.Vector3();
  protected perch: Perch | null = null;
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
  protected post: { x: number; z: number } | null = null;
  protected postT = 0;
  protected holding = false;
  /** seconds until the next shot while running and gunning */
  protected gunT = 0.5 + Math.random();

  constructor(x: number, z: number, protected readonly env: SoldierEnv) {
    this.group.position.set(x, 0, z);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.35), BODY);
    torso.position.y = 1.1;
    const head = (this.head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), SKIN));
    head.position.y = 1.7;
    const helmet = (this.helmet = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.36), BODY));
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
    for (const z of [-0.3, 0.3]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.6, 0.14), BODY);
      arm.geometry.translate(0, -0.3, 0);
      arm.position.set(0, 1.4, z);
      arm.visible = false;
      this.arms.push(arm);
      this.body.add(arm);
    }
    for (const m of [torso, head, helmet, this.gun, ...this.legs, ...this.arms]) m.castShadow = true;
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

  /** Street infantry that is not busy with anything else (walking at the mech, not perched or in the air). */
  get free(): boolean { return this.alive && this.state === 'walk' && this.plan === 'normal' && !this.perch; }

  /** Drop everything and run to this spot (a gun to man), shooting on the way; `holding` says when it has got there or given up. */
  rushTo(x: number, z: number): void {
    this.plan = 'scatter';
    this.post = { x, z };
    this.postT = 0;
    this.holding = false;
    this.goal = null;
  }

  /** Never mind: back to walking at the mech like any other soldier. */
  standDown(): void {
    if (this.state === 'mounted') return;
    this.plan = 'normal';
    this.post = null;
    this.holding = false;
  }

  /** Climb aboard a gun: the gun takes over where it stands. */
  crewUp(): void {
    this.standDown();
    this.mount();
  }

  /** has stopped running to its post: arrived, or timed out */
  get settled(): boolean { return this.holding; }

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
    this.cause = 'stomp';
    this.hp = 0;
    this.state = 'dead';
    this.deadTime = 0;
    this.deadVy = 0;
    this.resetPose();
    sfx.impact('flesh', this.group.position);
    this.flatten(fx);
  }

  /**
   * Plunging from a building: it tips over to go head first (turning about its middle, so the head leads), arms and
   * legs flailing wildly, with a little wobble as it falls.
   */
  protected flail(): void {
    const t = this.deadTime;
    const a = Math.min(1, t / 0.45);
    const th = -this.fallDir * Math.PI * a * a * (3 - 2 * a) + Math.sin(t * 9 + this.phase) * 0.12;
    const cy = this.centerY;
    this.body.rotation.z = th;
    this.body.position.set(cy * Math.sin(th), cy - cy * Math.cos(th), 0);
    const w = t * 17 + this.phase;
    this.arms[0].rotation.z = 2.6 + Math.sin(w) * 0.9;
    this.arms[1].rotation.z = -2.6 + Math.sin(w + 2.1) * 0.9;
    this.arms[0].rotation.x = Math.sin(w * 0.7) * 0.7;
    this.arms[1].rotation.x = Math.cos(w * 0.8) * 0.7;
    this.legs[0].rotation.z = Math.sin(w * 0.8) * 0.9;
    this.legs[1].rotation.z = -Math.sin(w * 0.8 + 1) * 0.9;
  }

  /** The fall is over: back to ordinary body geometry, lying where it landed (or about to be flattened). */
  protected landFlailing(): void {
    this.body.position.set(0, 0, 0);
    this.body.rotation.z = 0;
    this.group.rotation.z = -this.fallDir * 1.5;
    for (const a of this.arms) a.visible = false;
    for (const l of this.legs) l.rotation.set(0, 0, 0);
  }

  /** Lie squashed flat in a pool of blood, with a spray of it. */
  protected flatten(fx: Fx): void {
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
  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.state = 'dead';
    this.deadTime = 0;
    this.resetPose();
    const plunges = this.group.position.y > SOLDIER.highFloorY && (this.forcePlunge || Math.random() < SOLDIER.plungeChance);
    sfx.soldierDeath(this.x, plunges, this.forcePlunge);
    if (push) {
      // the bullet's momentum carries him along its path, and he falls the way he is thrown
      this.fling.copy(push).multiplyScalar(WEAPON.pushShare.soldier);
      if (Math.abs(push.x) > 0.5) this.fallDir = Math.sign(push.x);
    }
    if (plunges) {
      this.plunge();
      return true;
    }
    this.deadVy = 1.0 + this.fling.y * 0.5; // a little hop as it drops, more if it is shot upward
    fx.burst(new THREE.Vector3(this.x, this.group.position.y + this.centerY, this.z), 12, 2.5, [0x8a1010, 0xc02020, 0xffa040]);
    return true;
  }

  /**
   * Killed on an upper floor: no spray in the room. The body is flung out of the bay, tumbles down the front of the
   * building and bursts on whatever it lands on.
   */
  protected plunge(): void {
    this.plunging = true;
    for (const a of this.arms) a.visible = true;
    this.plungeFrom = this.group.position.y;
    this.deadVy = 3 + this.fling.y * 0.5;
    // far enough forward (toward the camera) to clear the ledge from wherever in the room it was standing
    const toEdge = this.perch ? Math.max(0.3, this.perch.ledgeZ + 0.3 - this.group.position.z) : 0.3;
    this.plungeVel.set((Math.random() - 0.5) * 1.2 + this.fling.x * 0.4, 0, THREE.MathUtils.clamp(toEdge / 0.3, 1.2, 9) * (1 + Math.random() * 0.3));
  }

  /** Running: long strides, a lean into the run and a bounce, at `rate` rad/s of stride cycle; it stands up if it was kneeling. */
  protected runCycle(dt: number, rate: number, dir: number): void {
    this.phase += dt * rate;
    const s = Math.sin(this.phase);
    this.legs[0].rotation.z = s * 1.0;
    this.legs[1].rotation.z = -s * 1.0;
    this.body.rotation.z = -dir * 0.22;
    this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.07 * this.k;
    this.setKneel(0);
  }

  /** Standing still: upright, or, holding a spot behind cover, down on one knee (smaller target, gun lower). */
  protected standPose(dt: number): void {
    const goal = this.plan === 'cover' && this.holding && !this.perch ? 1 : 0;
    this.setKneel(this.kneel + (goal - this.kneel) * Math.min(1, dt * 8));
    this.legs[0].rotation.z = 1.2 * this.kneel;               // front leg bent forward
    this.legs[1].rotation.z = -1.5 * this.kneel;              // rear knee on the ground
    this.body.rotation.z = 0;
    this.body.position.y = -0.45 * this.k * this.kneel;
  }

  protected setKneel(k: number): void {
    this.kneel = k;
    const shrink = 1 - 0.28 * k;
    this.centerY = this.stand.centerY * shrink;
    this.half.y = this.stand.halfY * shrink;
  }

  /** Back to a plain upright body (before a death pose takes over). */
  protected resetPose(): void {
    this.setKneel(0);
    this.body.rotation.z = 0;
    this.body.position.y = 0;
    for (const l of this.legs) l.rotation.z = 0;
  }

  /**
   * Walk toward (ux, uz) while steering round rubble: try the straight heading, then
   * progressively wider turns (preferring the side we are already going round).
   * @returns false if every heading is blocked
   */
  protected walkAround(dt: number, ux: number, uz: number, speed: number = SOLDIER.walkSpeed, reach = Infinity): boolean {
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
    g.position.z = THREE.MathUtils.clamp(g.position.z + hz * step, Math.min(LANE.soldierZMin, g.position.z), LANE.soldierZMax);
    this.pushOut(nb);
    return true;
  }

  /** Fire one bullet, with a random miss. */
  protected shoot(fx: Fx, dir: number, onShoot: ShotFn): void {
    const muzzle = this.muzzlePoint(dir);
    fx.sparks(muzzle, 2, 1.5, [0xffd080]);
    onShoot(muzzle, this.missTmp.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1));
  }

  protected muzzlePoint(dir: number): THREE.Vector3 {
    return this.muzzleTmp.set(this.x + dir * 0.8 * this.k, this.group.position.y + (1.2 - 0.45 * this.kneel) * this.k, this.z + 0.2 * this.k);
  }

  /** 'cover' / 'scatter' plans: run to the chosen post; once there (or out of time) hold it and fight from it. */
  protected runToPost(dt: number, target: THREE.Vector3): boolean {
    if (!this.post) {
      // nothing to hide behind: scatter into the street instead
      this.post = (this.plan === 'cover' ? this.pickCover(target) : null) ?? this.pickScatter(target);
      this.postT = 0;
    }
    const dx = this.post.x - this.x, dz = this.post.z - this.z, d = Math.hypot(dx, dz);
    this.postT += dt;
    if (d < 0.2 || this.postT > POST_RUN_MAX) { this.holding = true; return false; }       // (near enough: the walls and rubble keep him a hair short of the exact spot)
    const moved = this.walkAround(dt, dx / d, dz / d, SOLDIER.runSpeed, d);
    // making no headway (against a wall, in a crowd): stop running on the spot and make a stand where he is
    this.stuckT += dt;
    if (this.stuckT >= 0.6) {
      if (Math.hypot(this.x - this.stuckX, this.z - this.stuckZ) < 0.1) this.holding = true;
      this.stuckT = 0; this.stuckX = this.x; this.stuckZ = this.z;
    }
    return moved;
  }

  /** A spot of its own: a little way along the street from where it landed, a good firing distance from the mech. */
  protected pickScatter(target: THREE.Vector3): { x: number; z: number } {
    let spot = { x: 0, z: 0 };
    for (let tries = 0; tries < 8; tries++) {
      const standoff = SOLDIER.standoffMin + Math.random() * (SOLDIER.standoffMax - SOLDIER.standoffMin);
      let x = this.x + (Math.random() * 2 - 1) * SOLDIER.scatterSpread;
      const side = Math.sign(x - target.x) || (Math.random() < 0.5 ? -1 : 1);
      if (Math.abs(x - target.x) < standoff) x = target.x + side * standoff;       // never closer than the standoff
      spot = this.onScreenSpot({ x, z: clearOfWalls(LANE.soldierZMin + Math.random() * (LANE.soldierZMax - LANE.soldierZMin)) });
      if (!this.spotTaken(spot.x, spot.z, SOLDIER.spotGap)) break;                  // someone else is already heading there
    }
    return spot;
  }

  /** Is this soldier within the area the player can see and shoot at? (always, if the game does not say) */
  protected onScreen(): boolean {
    const a = this.env.arena?.(this.group.position.z);
    return !a || (this.x >= a.min && this.x <= a.max);
  }

  /**
   * Off screen: run for the nearest part of the street that is on it, and fire at nothing until there. A soldier
   * that cannot get through (boxed in by rubble out there) is moved to the edge after a moment; nobody sees it.
   */
  protected hurryIn(dt: number): boolean {
    const a = this.env.arena!(this.group.position.z);
    const tx = THREE.MathUtils.clamp(this.x, a.min + ARENA_ENTRY, a.max - ARENA_ENTRY);
    const dx = tx - this.x;
    const moved = this.walkAround(dt, Math.sign(dx) || 1, 0, SOLDIER.runSpeed, Math.abs(dx));
    this.offscreenT = moved ? 0 : this.offscreenT + dt;
    if (this.offscreenT > 2) { this.group.position.x = tx; this.offscreenT = 0; }
    return moved;
  }

  /** a spot on the street that is on screen (nudged inward if it is not) */
  protected onScreenSpot(spot: { x: number; z: number }): { x: number; z: number } {
    const a = this.env.arena?.(spot.z);
    return a ? { x: THREE.MathUtils.clamp(spot.x, a.min + ARENA_ENTRY, a.max - ARENA_ENTRY), z: spot.z } : spot;
  }

  /** Is another soldier standing at, or on his way to, this spot? */
  protected spotTaken(x: number, z: number, gap: number): boolean {
    const others = this.env.others?.();
    if (!others) return false;
    for (const o of others) {
      if (o === this || !(o instanceof Soldier) || !o.alive) continue;
      const px = o.post ? o.post.x : o.x, pz = o.post ? o.post.z : o.group.position.z;
      if ((px - x) ** 2 + (pz - z) ** 2 < gap * gap) return true;
    }
    return false;
  }

  /**
   * Personal space: soldiers standing on top of each other (running to the same spot, crowding a cover) ease apart.
   * Everyone does their own share, so a pair moves away from each other equally.
   */
  protected keepApart(dt: number): void {
    const others = this.env.others?.();
    if (!others) return;
    const g = this.group.position;
    let px = 0, pz = 0;
    for (const o of others) {
      if (o === this || !(o instanceof Soldier) || !o.alive || o.state === 'mounted' || o.perch) continue;
      if (Math.abs(g.y - o.group.position.y) > 0.3) continue;                    // on another floor
      const dx = g.x - o.x, dz = g.z - o.group.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= SOLDIER.personalSpace * SOLDIER.personalSpace) continue;
      const d = Math.sqrt(d2);
      const push = 1 - d / SOLDIER.personalSpace;
      if (d > 1e-4) { px += (dx / d) * push; pz += (dz / d) * push; }
      else { const a = Math.random() * Math.PI * 2; px += Math.cos(a) * push; pz += Math.sin(a) * push; }
    }
    if (px === 0 && pz === 0) return;
    const move = SOLDIER.separateSpeed * dt;
    g.x += px * move;
    g.z = THREE.MathUtils.clamp(g.z + pz * move, Math.min(LANE.soldierZMin, g.z), LANE.soldierZMax);
    this.pushOut(this.env.blockers(this.x, this.z, 0.6, BLOCKER_BUF));
  }

  /** The spot just behind the nearest big chunk of rubble, as seen from the mech. */
  protected pickCover(target: THREE.Vector3): { x: number; z: number } | null {
    const n = (this.env.cover ?? this.env.blockers).call(this.env, this.x, this.z, COVER_SEARCH, BLOCKER_BUF);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const b = BLOCKER_BUF[i];
      const d = (b.x - this.x) ** 2 + (b.z - this.z) ** 2;
      const a = this.env.arena?.(b.z);
      if (a && (b.x < a.min + ARENA_ENTRY || b.x > a.max - ARENA_ENTRY)) continue;      // rubble out of sight is no use
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const b = BLOCKER_BUF[best];
    // directly behind it, as seen from the mech; or, if someone is already there, round to one side or the other
    const base = Math.atan2(b.z - target.z, b.x - target.x);
    const off = b.r + SOLDIER_R + 0.12;
    const swing = Math.random() < 0.5 ? 1 : -1;
    let spot = { x: 0, z: 0 };
    let found = false;
    for (const turn of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
      const a = base + turn * swing;
      spot = { x: b.x + Math.cos(a) * off, z: THREE.MathUtils.clamp(b.z + Math.sin(a) * off, LANE.soldierZMin, LANE.soldierZMax) };
      if (this.insideBlocker(spot.x, spot.z, n)) continue;                           // a spot in the rubble, or in the wall, is one he could not stand on
      if (!this.env.sight(this.sightA.set(this.x, 0.2, this.z), this.sightB.set(spot.x, 0.2, spot.z))) continue;   // or one he could not get to (the far side of a wall)
      found = true;
      if (!this.spotTaken(spot.x, spot.z, SOLDIER.spotGap)) break;
    }
    return found ? spot : null;
  }

  /** Is (x, z) inside any of the first `n` blockers in the buffer (where a soldier cannot stand)? */
  private insideBlocker(x: number, z: number, n: number): boolean {
    for (let i = 0; i < n; i++) {
      const b = BLOCKER_BUF[i];
      const lim = b.r + SOLDIER_R + 0.03;
      if ((x - b.x) ** 2 + (z - b.z) ** 2 < lim * lim) return true;
    }
    return false;
  }

  /** Clear line of fire from standing at (x, z) to the mech's chest? (rubble is cover, for both sides) */
  protected hasLOS(target: THREE.Vector3, x = this.x, z = this.z): boolean {
    // both ways: his gun to the mech's chest, and the mech's guns down to his torso
    // (a soldier that cannot be hit must not be able to hit back)
    const gun = this.sightA.set(x, this.group.position.y + (1.2 - 0.45 * this.kneel) * this.k, z + 0.2 * this.k);
    const chest = this.sightB.set(target.x, CHEST_Y, target.z);
    if (!this.env.sight(gun, chest)) return false;
    gun.set(x, this.group.position.y + this.centerY, z);
    return this.env.sight(chest, gun);
  }

  /**
   * Nearest nearby spot (growing ring) that is not inside rubble and has a clear line of fire,
   * i.e. where the soldier can stand at the edge of cover and be shot at as well as shoot.
   */
  protected findExposedSpot(target: THREE.Vector3): { x: number; z: number } | null {
    const nb = this.env.blockers(this.x, this.z, 2.4, BLOCKER_BUF);
    const start = Math.random() * Math.PI * 2;
    for (const rad of [0.35, 0.7, 1.1, 1.6, 2.2]) {
      for (let k = 0; k < 12; k++) {
        const a = start + (k * Math.PI) / 6;
        const cx = this.x + Math.cos(a) * rad;
        const cz = THREE.MathUtils.clamp(this.z + Math.sin(a) * rad, Math.min(LANE.soldierZMin, this.z), LANE.soldierZMax);
        let free = true;
        for (let i = 0; i < nb && free; i++) {
          const b = BLOCKER_BUF[i];
          const lim = b.r + SOLDIER_R + 0.03;
          if ((cx - b.x) ** 2 + (cz - b.z) ** 2 < lim * lim) free = false;
        }
        if (!free || Math.hypot(target.x - cx, target.z - cz) < 3 || clearOfWalls(cz) !== cz) continue;
        // a place on the far side of a wall is no good: he could not walk there
        if (!this.env.sight(this.sightA.set(this.x, 0.2, this.z), this.sightB.set(cx, 0.2, cz))) continue;
        if (this.hasLOS(target, cx, cz)) return { x: cx, z: cz };
      }
    }
    return null;
  }

  /** Hard collision: never end a frame inside rubble (also covers chunks rolling into us). */
  protected pushOut(nb: number): void {
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
        this.flail();
        g.position.x += this.plungeVel.x * dt;
        g.position.z += this.plungeVel.z * dt;
      } else if (!this.squashed) {
        g.rotation.z = -this.fallDir * k * 1.5;
        g.position.x += this.fling.x * dt;
        g.position.z += this.fling.z * dt;
        this.fling.multiplyScalar(Math.exp(-(g.position.y > 0.05 ? 0.4 : 5) * dt));   // little drag in the air, a lot on the ground
      }
      // corpses obey gravity too: fall until a floor (or the ground) is under them
      const ground = this.env.surface(this.x, this.z, g.position.y + 0.05);
      this.deadVy -= 16 * dt;
      g.position.y = Math.max(ground, g.position.y + this.deadVy * dt);
      if (g.position.y <= ground) {
        this.deadVy = 0;
        if (this.plunging) {
          this.landFlailing();
          if (this.plungeFrom - ground > PLUNGE_MIN_FALL) this.flatten(fx);
        }
        this.plunging = false;
      }
      return;
    }
    if (this.state === 'ride') {
      // the floor is coming down with the building: he rides it, alive, until it crumbles into rubble and buries him
      const c = this.ride!;
      this.rideT += dt;
      g.position.set(this.rideBase.x + c.tx - this.rideFrom.x, this.rideBase.y + c.ty - this.rideFrom.y, this.rideBase.z + c.tz - this.rideFrom.z);
      this.body.rotation.z = Math.sin(this.rideT * 22 + this.phase) * 0.09;
      if (c.crumbledTo(this.rideBase.y) || this.rideT > RIDE_MAX) { this.ride = null; this.splat(fx); }
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
      g.position.z -= 2.4 * dt;
      this.runCycle(dt, 14, -1);
      if (g.position.z <= this.perch.backZ) this.gone = true;
      return;
    }
    if (this.retreating) {
      this.body.scale.x = -this.k;
      g.position.x -= 4 * dt;
      this.pushOut(this.env.blockers(this.x, this.z, 0.6, BLOCKER_BUF));
      this.runCycle(dt, 16, -1);
      return;
    }
    // nobody fires from out of sight: whoever has drifted off screen goes back to hurrying in
    if (!this.perch && !this.retreating && (this.state === 'aim' || this.state === 'cooldown') && !this.onScreen()) this.state = 'walk';
    if (!this.perch) this.keepApart(dt);
    const dxT = target.x - this.x;
    const dzT = target.z - this.z;
    const dir = Math.sign(dxT) || 1;
    this.fallDir = dir;
    this.body.scale.x = dir * this.k; // flip to face target; model faces +x
    const dist = Math.hypot(dxT, dzT);

    // a perched soldier whose floor was shot away falls
    if (this.perch && this.perch.floorTop(this.x, this.z, g.position.y + 0.05) < g.position.y - 0.03) {
      const carrier = this.perch.carrierAt(this.x, g.position.y);
      if (carrier) {
        this.state = 'ride';
        this.ride = carrier;
        this.rideT = 0;
        this.rideBase.copy(g.position);
        this.rideFrom.set(carrier.tx, carrier.ty, carrier.tz);
        this.resetPose();
        return;
      }
      this.state = 'jump';
      this.vel.set(0, 0, 0);
      this.fallStart = g.position.y;
      return;
    }

    if (this.state === 'enter' && this.perch) {
      g.position.z += 2.0 * dt;
      this.runCycle(dt, 14, dir);
      if (g.position.z >= this.perch.ledgeZ) {
        g.position.z = this.perch.ledgeZ;
        this.state = 'aim';
        this.timer = 0.6;
      }
    } else if (this.state === 'walk') {
      let moved = false;
      const pace = this.plan === 'normal' ? SOLDIER.walkSpeed : SOLDIER.runSpeed;
      if (!this.perch && !this.retreating && !this.onScreen()) {
        moved = this.hurryIn(dt);
      } else if (this.plan !== 'normal' && !this.holding) {
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
      if (moved) this.runCycle(dt, pace * 6.2, dir);
      else this.standPose(dt);
    } else if (this.state === 'aim') {
      this.standPose(dt);
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
      this.standPose(dt);
      this.timer -= dt;
      if (this.timer <= 0) {
        // perched soldiers keep shooting from the ledge instead of walking
        this.state = this.perch ? 'aim' : 'walk';
        this.timer = 0.6;
      }
    }
  }
}
