import * as THREE from 'three';
import type { Fx } from './fx';
import type { Soldier } from './enemies';
import { castRay, newHit } from './targeting';
import type { World } from './world';
import type { Dust, Debris } from './debris';

const FIRE_RATE = 20;        // shots / second (machine gun)
const HEAT_PER_SHOT = 0.02 / 6; // 5x the previous 0.02/30
const COOL_RATE = 0.25;      // per second while idle
const LOCK_COOL_RATE = 0.4;  // per second while locked out
const UNLOCK_AT = 0.35;
const DAMAGE = 1;
const WALL_RADIUS = 0.3;
const REF_DIST = 24; // camera distance the jitter radii were tuned at
const JITTER = new THREE.Vector3();

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
  private dir = new THREE.Vector3();

  update(
    dt: number,
    firing: boolean,
    muzzles: THREE.Vector3[],
    aim: THREE.Ray,
    enemies: Soldier[],
    fx: Fx,
    world: World,
    dust: Dust,
    debris: Debris,
  ): void {
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
      this.shoot(muzzles[this.side++ % muzzles.length], aim, enemies, fx, world, dust, debris);
      this.heat += HEAT_PER_SHOT;
      if (this.heat >= 1) { this.heat = 1; this.locked = true; break; }
    }
    if (this.cooldown < -0.1) this.cooldown = 0;
  }

  private shoot(muzzle: THREE.Vector3, aim: THREE.Ray, enemies: Soldier[], fx: Fx, world: World, dust: Dust, debris: Debris): void {
    // Tight stream: jitter the screen ray by a small angle that grows with heat.
    const jitter = (0.04 + this.heat * 0.14) / REF_DIST;
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * jitter;
    this.ray.copy(aim);
    this.ray.direction.add(JITTER.set(Math.cos(a) * d, Math.sin(a) * d, 0)).normalize();

    const hit = castRay(this.ray, enemies, world, this.hit);
    this.sinceShot = 0;
    // rubble is cover: if a chunk lies on the line from the gun to the target, the bullet hits that instead
    if (debris.segmentHit(muzzle, hit.point, this.cover)) {
      fx.sparks(this.cover, 2, 2.5, [0xffd080, 0xffffff]);
      debris.kick(this.cover, this.dir.subVectors(hit.point, muzzle).normalize(), 1.5);
      return;
    }
    if (hit.kind === 'enemy' && hit.enemy) {
      fx.sparks(hit.point, 2, 2.5, [0xff3020, 0xff8040]);
      hit.enemy.damage(DAMAGE, fx);
      return;
    }
    fx.sparks(hit.point, 2, 2.5, [0xffd080, 0xffa040, 0xffffff]);
    if (hit.kind === 'wall') {
      hit.building?.damage(hit.point.x, hit.point.y, WALL_RADIUS);
      if (Math.random() < 0.25) dust.puff(hit.point, 1, 0.3, 0.6);
    } else if (hit.kind === 'ground') {
      if (Math.random() < 0.25) dust.puff(hit.point, 1, 0.3, 0.5);
    }
  }

  reset(): void { this.heat = 0; this.locked = false; this.cooldown = 0; }
}
