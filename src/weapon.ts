import * as THREE from 'three';
import type { Fx } from './fx';
import type { Enemy } from './enemies';
import { castRay, newHit } from './targeting';
import type { World } from './world';
import type { Debris } from './debris';
import type { Dust } from './dust';
import { WEAPON } from './config';

/** Everything a shot can hit or leave marks on. */
export interface WeaponDeps {
  fx: Fx;
  world: World;
  dust: Dust;
  debris: Debris;
  enemies: Enemy[];
}

const { fireRate: FIRE_RATE, heatPerShot: HEAT_PER_SHOT, coolRate: COOL_RATE, lockCoolRate: LOCK_COOL_RATE,
  unlockAt: UNLOCK_AT, damage: DAMAGE, wallRadius: WALL_RADIUS, refDist: REF_DIST } = WEAPON;
const JITTER = new THREE.Vector3();
const PUSH = new THREE.Vector3();
const KILL_PUSH = WEAPON.killPush;
/** wet earth, dark to light */
const MUD = [0x3a2c1e, 0x4a3a28, 0x5c4630, 0x6b5a45];
const EMBER_VEL = new THREE.Vector3();

/** Hitscan machine gun: ray ends at the reticle (+ heat jitter); damage resolved there. */
export class Weapon {
  heat = 0;
  /** true while shots are leaving the barrels (a short grace so the fire is continuous between shots) */
  get firing(): boolean { return this.sinceShot < 0.09; }
  private sinceShot = 1;
  locked = false;
  private cooldown = 0;
  private side = 0;
  private ray = new THREE.Ray();
  private hit = newHit();
  private cover = new THREE.Vector3();
  private wallPt = new THREE.Vector3();
  private seg = new THREE.Vector3();
  private segRay = new THREE.Ray();
  private dir = new THREE.Vector3();

  constructor(private readonly deps: WeaponDeps) {}

  update(dt: number, firing: boolean, muzzles: THREE.Vector3[], aim: THREE.Ray): void {
    this.cooldown -= dt;
    this.sinceShot += dt;

    if (this.locked) {
      this.heat = Math.max(0, this.heat - LOCK_COOL_RATE * dt);
      if (this.heat <= UNLOCK_AT) this.locked = false;
      return;
    }
    if (!firing) {
      this.heat = Math.max(0, this.heat - COOL_RATE * dt);
      return;
    }

    while (this.cooldown <= 0) {
      this.cooldown += 1 / FIRE_RATE;
      this.shoot(muzzles[this.side++ % muzzles.length], aim);
      this.heat += HEAT_PER_SHOT;
      if (this.heat >= 1) { this.heat = 1; this.locked = true; break; }
    }
    if (this.cooldown < -0.1) this.cooldown = 0;
  }

  private shoot(muzzle: THREE.Vector3, aim: THREE.Ray): void {
    const { fx, world, dust, debris, enemies } = this.deps;
    // Tight stream: jitter the screen ray by a small angle that grows with heat.
    const jitter = (0.04 + this.heat * 0.14) / REF_DIST;
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * jitter;
    this.ray.copy(aim);
    this.ray.direction.add(JITTER.set(Math.cos(a) * d, Math.sin(a) * d, 0)).normalize();

    const hit = castRay(this.ray, enemies, world, this.hit);
    this.sinceShot = 0;
    // Walls are cover too, and the bullet flies from the gun, not from the camera: the sight line from the
    // barrel to the impact point may cross a pillar or wall that the camera sees past. Whichever is
    // nearer along that line takes the hit.
    this.seg.subVectors(hit.point, muzzle);
    const range = this.seg.length();
    if (range > 0.05) {
      this.segRay.set(muzzle, this.seg.divideScalar(range));
      const tw = world.raycast(this.segRay, this.wallPt);
      if (tw < range - 0.03) {
        hit.kind = 'wall';
        hit.point.copy(this.wallPt);
        hit.building = world.lastBuilding ?? undefined;
        hit.enemy = undefined;
        hit.barrel = undefined;
      }
    }
    // rubble is cover: if a chunk lies on the line from the gun to the target, the bullet hits that instead
    if (debris.segmentHit(muzzle, hit.point, this.cover)) {
      fx.sparks(this.cover, 2, 2.5, [0xffd080, 0xffffff]);
      debris.kick(this.cover, this.dir.subVectors(hit.point, muzzle).normalize(), 1.5);
      return;
    }
    if (hit.kind === 'barrel' && hit.barrel) {
      // knocked over along the bullet's path (gun to impact), spilling hot coals
      hit.barrel.shoot(this.dir.subVectors(hit.point, muzzle).normalize(), { coals: world.coals, fx, dust, solid: (x, y, z) => world.solidAt(x, y, z) });
      fx.sparks(hit.point, 3, 3, [0xffd080, 0xffffff]);
      return;
    }
    if (hit.kind === 'enemy' && hit.enemy) {
      const { colors, sparks, embers } = hit.enemy.impact;
      fx.sparks(hit.point, sparks, 2.5 + 0.4 * sparks, colors);
      for (let i = 0; i < embers; i++) {
        // thrown back toward the viewer and up, then they fall, bounce and cool on whatever is below
        EMBER_VEL.set((Math.random() - 0.5) * 3, 1 + Math.random() * 2.5, 0.5 + Math.random() * 2);
        world.coals.emit(hit.point, EMBER_VEL, 0.6 + Math.random() * 0.9);
      }
      // a kill is flung along the bullet's path
      hit.enemy.damage(DAMAGE, fx, PUSH.copy(this.ray.direction).multiplyScalar(KILL_PUSH));
      return;
    }
    if (hit.kind === 'ground') {
      // a spray of mud that falls back and splatters, now and then a spark off a stone, and some dust
      fx.burst(hit.point, 9, 2.8, MUD, true, 0.7);
      if (Math.random() < 0.35) fx.sparks(hit.point, 3, 3.5, [0xffd080, 0xffa040, 0xffffff]);
      if (Math.random() < 0.4) dust.puff(hit.point, 1, 0.35, 0.6);
      return;
    }
    fx.sparks(hit.point, 2, 2.5, [0xffd080, 0xffa040, 0xffffff]);
    if (hit.kind === 'wall') {
      hit.building?.damage(hit.point.x, hit.point.y, hit.point.z, WALL_RADIUS);
      if (Math.random() < 0.25) dust.puff(hit.point, 1, 0.3, 0.6);
    }
  }

  reset(): void { this.heat = 0; this.locked = false; this.cooldown = 0; }
}
