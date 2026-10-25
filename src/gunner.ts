import * as THREE from 'three';
import type { Fx } from './fx';
import { Soldier, type ShotFn, type SoldierEnv } from './enemies';
import { LANE } from './mech';
import { GUNNER, SOLDIER } from './config';

// the gun is white, like everything else on the enemy side: two close shades of light grey, so its parts still read
const GUN_DARK = new THREE.MeshStandardMaterial({ color: 0xd9dde1, roughness: 0.6, metalness: 0.15 });
const GUN_STEEL = new THREE.MeshStandardMaterial({ color: 0xf6f7f8, roughness: 0.5, metalness: 0.2 });
const STRAP = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.9 });
/** a gunner is a little bigger than a rifleman */
const SIZE = 1.1;
const SPARKS = [0xffd080, 0xffa040, 0xffffff];
const DIRT = [0x6b5a45, 0x4a3a28, 0x857a68];

/** the gun at rest over his shoulder and set up on the ground in front of him (model units, before the soldier's scale) */
const CARRY = { x: 0.12, y: 1.34, z: 0.2, tilt: 0.08 };
const DOWN = { x: 0.95, y: 0.3, z: 0.05, tilt: 0.0 };
/** how far from the gun's middle its muzzle is */
const GUN_HALF = 0.78;
/** lying down: how far back from his own spot his body lies (so his head is behind the gun's stock) and how far it is raised off the ground (model units) */
const PRONE_BACK = 1.6;
const PRONE_RAISE = 0.27;

type Phase = 'run' | 'plop' | 'rest' | 'fire' | 'pack';

const ease = (t: number): number => t * t * (3 - 2 * t);

const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

/**
 * A heavy machine gunner. He runs in from off screen with the gun carried over his shoulder, picks a spot a good way from the
 * mech where there is a clear line of fire, drops to the ground and sets the gun up, and then fires long bursts at the mech,
 * resting between them. His aim is much better than a rifleman's and his bullets are faster. If the line of fire is lost (rubble
 * in the way) he picks the gun up and moves. He is a Soldier otherwise: he can be shot, crushed or stomped like one.
 */
export class MachineGunner extends Soldier {
  private mode: Phase = 'run';
  /** how far the gun is set up and he is sitting behind it: 0 = running, 1 = down */
  private deploy = 0;
  private phaseT = 0;
  private roundsLeft = 0;
  private roundT = 0;
  private noSightT = 0;
  private readonly mg = new THREE.Group();
  private readonly bipod = new THREE.Group();
  private pace = GUNNER.runSpeed;
  /** where the leap began (x), and whether he has landed from it */
  private diveFrom = 0;
  private landed = false;
  /** how far the gun has bucked back from the last round (model units), settling again */
  private recoil = 0;

  constructor(x: number, z: number, env: SoldierEnv) {
    super(x, z, env);
    this.hp = GUNNER.hp;
    this.plan = 'scatter';
    // a bigger man: everything that goes with his size grows too
    this.k *= SIZE;
    this.half.multiplyScalar(SIZE);
    this.centerY *= SIZE;
    this.stand.centerY *= SIZE;
    this.stand.halfY *= SIZE;
    this.body.scale.setScalar(this.k);
    this.gun.visible = false;                         // not a rifle

    // the gun: receiver and stock, a jacketed barrel, an ammunition box, a carrying handle, and a bipod that folds down
    const mg = this.mg;
    mg.add(
      box(0.55, 0.2, 0.16, GUN_DARK, 0, 0, 0),
      box(0.28, 0.15, 0.13, GUN_DARK, -0.4, -0.04, 0),
      box(0.5, 0.11, 0.11, GUN_STEEL, 0.5, 0.02, 0),
      box(0.45, 0.045, 0.045, GUN_STEEL, 0.95, 0.02, 0),
      box(0.09, 0.09, 0.09, GUN_DARK, 1.2, 0.02, 0),
      box(0.22, 0.22, 0.15, GUN_DARK, 0.08, -0.2, 0),
      box(0.2, 0.05, 0.05, GUN_STEEL, 0.05, 0.14, 0),
    );
    for (const dz of [-0.1, 0.1]) {
      const leg = box(0.04, 0.34, 0.04, GUN_STEEL, 0, -0.17, 0);
      const pivot = new THREE.Group();
      pivot.position.set(0.72, -0.04, dz);
      pivot.rotation.set(dz * 3, 0, -0.35);          // splayed forward and out
      pivot.add(leg);
      this.bipod.add(pivot);
    }
    mg.add(this.bipod);
    this.group.add(mg);
    // an ammunition belt across the chest
    const belt = box(0.07, 0.95, 0.38, STRAP, 0.02, 1.1, 0);
    belt.rotation.x = 0.0;
    belt.rotation.z = 0.5;
    this.body.add(belt);
    this.poseGun(1);
  }

  /**
   * Where the gun is, between carried (0) and set up (1): it swings down in an arc. It is the gunner's own (not part of his body, which
   * tips over to lie down), so it is placed in the world round him: facing `dir`, at a height that follows his stride while he carries it.
   */
  private poseGun(dir: number): void {
    const d = ease(this.deploy), k = this.k;
    const carryBob = this.body.position.y * (1 - d);
    this.mg.scale.set(dir * k, k, k);
    this.mg.position.set(
      dir * (CARRY.x + (DOWN.x - CARRY.x) * d - this.recoil) * k,
      (CARRY.y + (DOWN.y - CARRY.y) * d + Math.sin(Math.PI * d) * 0.45) * k + carryBob,
      (CARRY.z + (DOWN.z - CARRY.z) * d) * k,
    );
    this.mg.rotation.z = dir * (CARRY.tilt + (DOWN.tilt - CARRY.tilt) * d);
    this.bipod.visible = d > 0.55;
  }

  /**
   * Down on the ground: he drops to his belly behind the gun, head to its stock, legs stretched out behind him, arms forward on the gun,
   * and a low, narrow target. `deploy` takes him from standing (0) to lying (1).
   */
  private pronePose(dir: number): void {
    const d = ease(this.deploy), k = this.k;
    this.body.rotation.z = -dir * (Math.PI / 2) * d;                 // tipped forward until he is lying along the ground
    this.body.position.x = -dir * PRONE_BACK * k * d;
    this.body.position.y = PRONE_RAISE * k * d;
    // lying on his belly, only his head upright (and held a little off the ground)
    this.head.rotation.z = dir * (Math.PI / 2) * d;
    this.helmet.rotation.z = dir * (Math.PI / 2) * d;
    this.head.position.x = -0.14 * d;
    this.helmet.position.x = -0.14 * d;
    this.legs[0].rotation.z = 0.12 * d;
    this.legs[1].rotation.z = -0.1 * d;
    for (const a of this.arms) { a.visible = d > 0.4; a.rotation.z = Math.PI * 0.92 * d; a.rotation.x = 0; }
    // what the sight checks treat as the height of his gun: low, like it is
    this.kneel = 1.9 * d;
    this.centerY = this.stand.centerY * (1 - 0.5 * d);
    this.half.y = this.stand.halfY * (1 - 0.6 * d);
  }

  /** In the leap: `dist` forward of where it began, `height` above the ground. */
  private hop(dir: number, dist: number, height: number): void {
    this.group.position.x = this.diveFrom + dir * dist;
    this.group.position.y = height;
  }

  /** where the muzzle is, in the world (he faces `dir`) */
  private muzzleAt(dir: number): THREE.Vector3 {
    const g = this.group.position;
    return this.muzzleTmp.set(
      g.x + this.mg.position.x + dir * GUN_HALF * this.k * Math.cos(this.mg.rotation.z),
      g.y + this.mg.position.y + 0.02 * this.k,
      g.z + this.mg.position.z,
    );
  }

  /** A spot on screen, left of the mech if there is room, with a clear line of fire and not where another soldier is going. */
  private pickPost(target: THREE.Vector3): { x: number; z: number } {
    let spot = { x: this.x, z: this.z };
    for (let tries = 0; tries < 12; tries++) {
      const standoff = GUNNER.standoffMin + Math.random() * (GUNNER.standoffMax - GUNNER.standoffMin);
      // the mech can only shoot to the left: set up there, and only if that will not fit on screen, in front of it
      const side = tries < 8 ? -1 : 1;
      spot = this.onScreenSpot({ x: target.x + side * standoff, z: LANE.zMin + Math.random() * (LANE.zMax - LANE.zMin) });
      if (this.spotTaken(spot.x, spot.z, SOLDIER.spotGap * 2)) continue;
      if (Math.abs(spot.x - target.x) >= 4 && this.hasLOS(target, spot.x, spot.z)) return spot;
    }
    return spot;
  }

  /** one round: a flash, and a bullet aimed at the mech with a gunner's accuracy */
  private fireRound(fx: Fx, dir: number, onShoot: ShotFn): void {
    const muzzle = this.muzzleAt(dir);
    fx.sparks(muzzle, 3, 2.5, SPARKS);
    if (Math.random() < 0.5) fx.muzzleFlash(muzzle);
    onShoot(muzzle, this.missTmp.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1),
      { precision: GUNNER.precision, speed: GUNNER.bulletSpeed, heavy: true });
    this.recoil = 0.05 + Math.random() * 0.04;                    // the gun bucks
  }

  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    // killed lying down: he is put back upright for the death fall (the soldier's), and the gun is left where it was
    if (this.deploy > 0 && this.hp - n <= 0) {
      this.body.position.x = 0;
      this.head.rotation.z = this.helmet.rotation.z = 0;
      this.head.position.x = this.helmet.position.x = 0;
      for (const a of this.arms) a.visible = false;
    }
    return super.damage(n, fx, push);
  }

  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: ShotFn): void {
    // dying, riding a floor down, retreating: the soldier's business (the gun goes down with him, or is left behind)
    if (this.state !== 'walk' || this.retreating) {
      if (this.state !== 'dead' && this.deploy > 0) { this.deploy = 0; this.recoil = 0; this.poseGun(1); this.pronePose(1); this.setKneel(0); }
      super.update(dt, target, fx, onShoot);
      return;
    }
    const g = this.group;
    const dxT = target.x - this.x;
    const dir = Math.sign(dxT) || 1;
    this.fallDir = dir;
    this.body.scale.x = dir * this.k;
    this.phaseT += dt;
    this.recoil *= Math.exp(-dt * 18);

    switch (this.mode) {
      case 'run': {
        this.keepApart(dt);
        if (!this.post) { this.post = this.pickPost(target); this.postT = 0; this.holding = false; }
        const moved = !this.onScreen() ? this.hurryIn(dt) : this.runToPost(dt, target);
        if (this.holding) { this.mode = 'plop'; this.phaseT = 0; this.landed = false; this.diveFrom = this.x; this.runCycle(dt, 0, dir); this.poseGun(dir); break; }
        if (moved) this.runCycle(dt, this.pace * 6.2, dir); else this.standPose(dt);
        this.poseGun(dir);
        break;
      }
      case 'plop': {
        // he leaps forward, tipping over in the air, lands on his belly with the gun in front of him and slides a little
        const air = GUNNER.diveTime, total = air + GUNNER.landTime;
        const t = this.phaseT;
        if (t < air) {
          const u = t / air;
          this.deploy = 0.9 * ease(u);
          this.hop(dir, GUNNER.diveDist * 0.85 * u, GUNNER.diveHeight * 4 * u * (1 - u));
        } else {
          const v = Math.min(1, (t - air) / GUNNER.landTime);
          this.deploy = 0.9 + 0.1 * ease(v);
          this.hop(dir, GUNNER.diveDist * (0.85 + 0.15 * ease(v)), 0);
          if (!this.landed) {
            this.landed = true;
            fx.burst(new THREE.Vector3(this.x, g.position.y + 0.04, this.z), 10, 1.6, DIRT, true, 0.9);   // dust where he hits the ground
          }
        }
        this.poseGun(dir);
        this.pronePose(dir);
        if (t >= total) { this.mode = 'rest'; this.phaseT = 0; this.roundT = GUNNER.firstDelay; this.noSightT = 0; }
        break;
      }
      case 'rest': {
        this.poseGun(dir);
        this.pronePose(dir);
        this.roundT -= dt;
        // no line of fire (rubble in the way): after a while he picks up the gun and finds another spot
        const sight = this.hasLOS(target);
        this.noSightT = sight ? 0 : this.noSightT + dt;
        if (this.noSightT > GUNNER.noSightLimit) { this.mode = 'pack'; this.phaseT = 0; break; }
        if (this.roundT <= 0 && sight) {
          this.roundsLeft = GUNNER.burst[0] + Math.floor(Math.random() * (GUNNER.burst[1] - GUNNER.burst[0] + 1));
          this.roundT = 0;
          this.mode = 'fire';
          this.phaseT = 0;
        }
        break;
      }
      case 'fire': {
        this.poseGun(dir);
        this.pronePose(dir);
        this.roundT -= dt;
        // the rate holds even on a slow frame: every round that is due is fired
        while (this.roundT <= 0 && this.roundsLeft > 0) {
          this.fireRound(fx, dir, onShoot);
          this.roundsLeft--;
          this.roundT += 1 / GUNNER.rate;
        }
        if (this.roundsLeft <= 0) {
          this.mode = 'rest';
          this.phaseT = 0;
          this.roundT = GUNNER.rest[0] + Math.random() * (GUNNER.rest[1] - GUNNER.rest[0]);
        } else if (!this.hasLOS(target)) {
          // something has moved into the line: stop firing into it
          this.roundsLeft = 0;
        }
        break;
      }
      case 'pack': {
        this.deploy = Math.max(0, 1 - this.phaseT / GUNNER.packTime);
        this.poseGun(dir);
        this.pronePose(dir);
        if (this.deploy <= 0) {
          this.setKneel(0);
          this.group.position.y = 0;
          this.mode = 'run';
          this.phaseT = 0;
          this.post = null;
          this.holding = false;
          this.noSightT = 0;
          this.runCycle(dt, 0, dir);
        }
        break;
      }
    }
  }
}
