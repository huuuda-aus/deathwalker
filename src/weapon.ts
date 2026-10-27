import * as THREE from 'three';
import type { Fx } from './fx';
import type { Enemy } from './enemies';
import { castRay, newHit } from './targeting';
import type { World } from './world';
import type { Debris } from './debris';
import type { Dust } from './dust';
import { WEAPON, BLAST_DOOR } from './config';
import { sfx } from './sfx';
import { terrain } from './terrain';

/** Everything a shot can hit or leave marks on. */
export interface WeaponDeps {
  fx: Fx;
  world: World;
  dust: Dust;
  debris: Debris;
  enemies: Enemy[];
  /** a round was fired from gun `index` */
  onShot?: (index: number) => void;
}

const { fireRate: FIRE_RATE, heatPerShot: HEAT_PER_SHOT, coolRate: COOL_RATE, lockCoolRate: LOCK_COOL_RATE,
  unlockAt: UNLOCK_AT, damage: DAMAGE, wallRadius: WALL_RADIUS, refDist: REF_DIST } = WEAPON;
const JITTER = new THREE.Vector3();
const PUSH = new THREE.Vector3();
const KILL_PUSH = WEAPON.killPush;
/** wet earth, dark to light */
const MUD = [0x3a2c1e, 0x4a3a28, 0x5c4630, 0x6b5a45];
/** chips off a dry-stone wall */
const STONE_CHIPS = [0x8a7a66, 0x9c8a70, 0x7a6a58, 0xa89478];
/** the desert's sand, light to dark */
const SAND = [0xe5bd86, 0xd7a76a, 0xc4905a, 0xb07c48];
const GEYSER_VEL = new THREE.Vector3();
/** chips knocked off a wall, concrete grey */
const CHIPS = [0x8a8f96, 0x6b7077, 0x4a4f55, 0xa8adb2];
/** how many times the sparks of an enemy's impact are multiplied: every hit throws sparks and a spray of chips in the same colours */
const HIT_SPARKS = 2;
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
    if (this.firing) sfx.gun(this.heat);

    // the cooldown only counts down to "ready": left to run on while idle, the first press would fire every round it
    // had "missed" in one frame (a tap after two idle seconds is forty bullets in the same spot)
    if (this.locked) {
      this.cooldown = Math.max(0, this.cooldown);
      this.heat = Math.max(0, this.heat - LOCK_COOL_RATE * dt);
      if (this.heat <= UNLOCK_AT) this.locked = false;
      return;
    }
    if (!firing) {
      this.cooldown = Math.max(0, this.cooldown);
      this.heat = Math.max(0, this.heat - COOL_RATE * dt);
      return;
    }

    while (this.cooldown <= 0) {
      this.cooldown += 1 / FIRE_RATE;
      const gun = this.side++ % muzzles.length;
      this.deps.onShot?.(gun);
      this.shoot(muzzles[gun], aim);
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
        hit.explosive = undefined;
      }
    }
    // rubble is cover: if a chunk lies on the line from the gun to the target, the bullet hits that instead
    // a wall of stones between the gun and what it is aimed at takes the bullet instead
    if (hit.kind !== 'rockwall' && world.wallSegmentHit(muzzle, hit.point, this.cover)) { hit.kind = 'rockwall'; hit.point.copy(this.cover); hit.enemy = undefined; hit.building = undefined; hit.barrel = undefined; hit.explosive = undefined; hit.scenery = undefined; }
    if (hit.kind === 'door') {
      // a vault door: sparks, a ricochet's whine, and a scratch
      fx.sparks(hit.point, 8, 3.5, [0xffd080, 0xffffff]);
      sfx.impact('metal', hit.point);
      world.damageDoor(BLAST_DOOR.bulletDamage, hit.point);
      return;
    }
    if (hit.kind === 'hall') {
      // concrete and steel: sparks, chips of plaster, a ring of dust
      fx.sparks(hit.point, 8, 3.2, [0xffd080, 0xffffff]);
      fx.burst(hit.point, 6, 2, STONE_CHIPS, true, 0.5);
      if (Math.random() < 0.5) dust.puff(hit.point, 1, 0.1, 0.5);
      sfx.impact('rubble', hit.point);
      return;
    }
    if (hit.kind === 'lamp') {
      // a tube bursts: glass, a shower of sparks, and the light goes out
      const at = world.corridor?.breakHit();
      fx.sparks(hit.point, 18, 4, [0xffffff, 0xcfe4ff, 0xffd080]);
      fx.burst(hit.point, 6, 2, [0xcfe4ff, 0xffffff], true, 0.6);
      if (at) sfx.impact('metal', hit.point);
      return;
    }
    if (hit.kind === 'rockwall') {
      fx.sparks(hit.point, 6, 3, [0xffd080, 0xffffff]);
      fx.burst(hit.point, 8, 2.2, STONE_CHIPS, true, 0.6);
      sfx.impact('rubble', hit.point);
      world.damageWalls(hit.point, DAMAGE);
      return;
    }
    if (debris.segmentHit(muzzle, hit.point, this.cover)) {
      fx.sparks(this.cover, 5, 3, [0xffd080, 0xffffff]);
      fx.burst(this.cover, 6, 2.4, CHIPS, true, 0.6);
      debris.kick(this.cover, this.dir.subVectors(hit.point, muzzle).normalize(), 1.5);
      sfx.impact('rubble', this.cover);
      return;
    }
    if (hit.kind === 'barrel' && hit.barrel) {
      // knocked over along the bullet's path (gun to impact), spilling hot coals
      hit.barrel.shoot(this.dir.subVectors(hit.point, muzzle).normalize(), { coals: world.coals, fx, dust, solid: (x, y, z) => world.solidAt(x, y, z) });
      fx.sparks(hit.point, 8, 3.2, [0xffd080, 0xffffff]);
      sfx.impact('metal', hit.point);
      return;
    }
    if (hit.kind === 'explosive' && hit.explosive) {
      hit.explosive.ignite();
      fx.sparks(hit.point, 12, 3.8, [0xffd080, 0xffa040, 0xffffff]);
      sfx.impact('metal', hit.point);
      return;
    }
    if (hit.kind === 'prop' && hit.scenery) {
      // a fence, a sign, a roadblock: it takes the hit (a bullet does little to concrete, but it chips)
      fx.sparks(hit.point, 5, 3, [0xffd080, 0xffffff]);
      fx.burst(hit.point, 5, 2.4, CHIPS, true, 0.6);
      sfx.impact('metal', hit.point);
      hit.scenery.damage(DAMAGE, this.dir.subVectors(hit.point, muzzle).normalize().multiplyScalar(-1).add(hit.point));
      return;
    }
    if (hit.kind === 'enemy' && hit.enemy) {
      const { colors, sparks, embers } = hit.enemy.impact;
      fx.sparks(hit.point, sparks * HIT_SPARKS, 2.5 + 0.4 * sparks, colors);
      fx.burst(hit.point, sparks * 2, 2.8, colors, true, 0.6);
      sfx.impact(hit.enemy.impact.sound, hit.point);
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
      if (terrain.on) {
        // loose sand: a tall, narrow spout of grains thrown well above the mech's own height, and a plume of dust climbing with it
        fx.geyser(hit.point, 22, SAND, 0.5);
        for (let i = 0; i < 4; i++) {
          GEYSER_VEL.set((Math.random() - 0.5) * 0.3, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 0.25);
          dust.billow(hit.point, GEYSER_VEL, 0.06 + Math.random() * 0.06, 0.9 + Math.random() * 0.7, 1.5, 0, 0.45);
        }
        if (Math.random() < 0.3) fx.sparks(hit.point, 3, 3.5, [0xffd080, 0xffa040, 0xffffff]);
      } else {
        fx.burst(hit.point, 20, 3.2, MUD, true, 0.8);
        if (Math.random() < 0.5) fx.sparks(hit.point, 5, 3.5, [0xffd080, 0xffa040, 0xffffff]);
        if (Math.random() < 0.7) dust.puff(hit.point, 2, 0.1, 0.8);
      }
      sfx.impact('ground', hit.point);
      return;
    }
    fx.sparks(hit.point, 6, 3, [0xffd080, 0xffa040, 0xffffff]);
    if (hit.kind === 'wall') {
      hit.building?.damage(hit.point.x, hit.point.y, hit.point.z, WALL_RADIUS);
      sfx.impact('wall', hit.point);
      fx.burst(hit.point, 14, 2.8, CHIPS, true, 0.7);
      if (Math.random() < 0.6) dust.puff(hit.point, 2, 0.35, 0.8);
    }
  }

  reset(): void { this.heat = 0; this.locked = false; this.cooldown = 0; }
}
