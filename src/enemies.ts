import * as THREE from 'three';
import type { Fx } from './fx';
import type { Blocker } from './debris';
import { MECH_SCALE, LANE } from './mech';
import { CAM_DIST } from './level';

const BODY = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.8 });
const SKIN = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
const GUN_IDLE = new THREE.MeshStandardMaterial({ color: 0x222222 });

/** Soldier is 1/8 of the mech's height, +15%. Model is authored ~2 units tall. */
const SOLDIER_HEIGHT = ((4 * MECH_SCALE) / 8) * 1.15; // mech model is 4 units tall before scaling
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
const BLOCKER_BUF: Blocker[] = Array.from({ length: 48 }, () => ({ x: 0, z: 0, r: 0 }));
/** steering headings tried relative to the straight line to the target (degrees) */
const TURNS = [0, 30, 60, 90, 120].map((d) => (d * Math.PI) / 180);

export type SoldierState = 'enter' | 'jump' | 'walk' | 'aim' | 'cooldown' | 'dead';

/** Standing on a building floor: walks from the back to the ledge, then shoots from there. */
export interface Perch {
  ledgeZ: number;
  backZ: number;
  floorTop: (x: number, z: number, yMax: number) => number;
}

export class Soldier {
  readonly group = new THREE.Group();
  hp = 4;
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
  /** which way we are going round an obstacle (+1/-1), 0 = none; kept for a moment to avoid dithering */
  private avoid = 0;
  private avoidT = 0;
  private blockedT = 0;
  /** spot to step to when rubble blocks the line of fire */
  private goal: { x: number; z: number } | null = null;
  private losT = 0;
  private sightA = new THREE.Vector3();
  private sightB = new THREE.Vector3();
  private perch: Perch | null = null;
  /** set when a retreating perched soldier has stepped back out of sight */
  gone = false;
  /** After the scene is cleared, survivors walk off to the left instead of fighting. */
  retreating = false;
  /** set once the kill has been credited to the scene */
  counted = false;

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

  /** Returns true if the hit killed. */
  damage(n: number, fx: Fx): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.state = 'dead';
    this.deadTime = 0;
    this.deadVy = 1.0; // a little hop as it drops
    fx.burst(new THREE.Vector3(this.x, this.group.position.y + this.centerY, this.z), 12, 2.5, [0x8a1010, 0xc02020, 0xffa040]);
    return true;
  }

  /**
   * Walk toward (ux, uz) while steering round rubble: try the straight heading, then
   * progressively wider turns (preferring the side we are already going round).
   * @returns false if every heading is blocked
   */
  private walkAround(dt: number, ux: number, uz: number): boolean {
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

    const speed = 1.2;
    g.position.x += hx * speed * dt;
    g.position.z = THREE.MathUtils.clamp(g.position.z + hz * speed * dt, Math.min(LANE.zMin, g.position.z), LANE.zMax);
    this.pushOut(nb);
    return true;
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

  /** onShoot: called when the soldier fires at the player; hit chance resolved by caller. */
  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: () => void): void {
    const g = this.group;
    if (this.state === 'dead') {
      this.deadTime += dt;
      const k = Math.min(1, this.deadTime / 0.35);
      g.rotation.z = -this.fallDir * k * 1.5;
      // corpses obey gravity too: fall until a floor (or the ground) is under them
      const ground = Math.max(0, this.env.surface(this.x, this.z, g.position.y + 0.05));
      this.deadVy -= 16 * dt;
      g.position.y = Math.max(ground, g.position.y + this.deadVy * dt);
      if (g.position.y <= ground) this.deadVy = 0;
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
      if (dist > this.stopDist) {
        this.goal = null;
        moved = this.walkAround(dt, dxT / dist, dzT / dist);
        if (moved) {
          this.blockedT = 0;
        } else {
          // boxed in by rubble: wait, and open fire only if there is a line of fire
          this.blockedT += dt;
          if (this.blockedT > 1.5 && dist < 14 && this.hasLOS(target)) { this.state = 'aim'; this.timer = 0.6; this.blockedT = 0; }
        }
      } else if (this.hasLOS(target)) {
        this.goal = null;
        this.state = 'aim';
        this.timer = 0.6;
      } else {
        // in range but rubble is in the way: step out to where there is a clear line of fire
        this.losT -= dt;
        if (!this.goal && this.losT <= 0) { this.goal = this.findExposedSpot(target); this.losT = 0.4; }
        if (this.goal) {
          const gx = this.goal.x - this.x, gz = this.goal.z - this.z, gd = Math.hypot(gx, gz);
          if (gd < 0.06) this.goal = null;
          else { moved = this.walkAround(dt, gx / gd, gz / gd); if (!moved) this.goal = null; }
        } else if (dist > 3) {
          moved = this.walkAround(dt, dxT / dist, dzT / dist); // no spot found: close in instead
        }
      }
      if (moved) {
        this.phase += dt * 9;
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
          const muzzle = new THREE.Vector3(this.x + dir * 0.8 * this.k, g.position.y + 1.2 * this.k, this.z + 0.2 * this.k);
          fx.sparks(muzzle, 2, 1.5, [0xffd080]);
          onShoot();
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
