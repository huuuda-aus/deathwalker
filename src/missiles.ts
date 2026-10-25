import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Dust } from './dust';
import type { World } from './world';
import type { Collider } from './debris';
import type { Explosions } from './explosions';
import { glowTexture } from './fireTextures';
import { MISSILE } from './config';

/** What sets one kind of rocket apart from another: how tough, how high it climbs, how long it flies, how hard it hits, how big it is. */
export interface RocketProfile {
  hp: number; climbSpeed: number; climbAccel: number; apexMin: number; apexMax: number; flightMin: number; flightMax: number; gravity: number;
  spreadX: number; spreadZ: number; blastRadius: number; blastScale: number; damage: number; shake: number; scale: number;
}
import { sfx } from './sfx';

const BODY_LEN = 1.6;
const RADIUS = 0.2;
/** the engine bell sticks out of the tail by this much */
const BELL_LEN = 0.22;
const GEO = {
  body: new THREE.CylinderGeometry(RADIUS, RADIUS, BODY_LEN, 10),
  nose: new THREE.ConeGeometry(RADIUS, BODY_LEN * 0.4, 10).translate(0, BODY_LEN * 0.7, 0),
  fin: new THREE.BoxGeometry(RADIUS * 3.2, BODY_LEN * 0.22, 0.02).translate(0, -BODY_LEN * 0.4, 0),
  /** the engine bell on the tail, and the exhaust flame: a cone pointing down from its mouth */
  bell: new THREE.CylinderGeometry(RADIUS * 0.55, RADIUS * 0.8, BELL_LEN, 12, 1, true).translate(0, -BODY_LEN * 0.5 - BELL_LEN / 2, 0),
  flame: new THREE.ConeGeometry(RADIUS * 0.75, 1, 10, 1, true).rotateX(Math.PI).translate(0, -0.5, 0),
};
const WHITE = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.5, metalness: 0.2 });
const RED = new THREE.MeshStandardMaterial({ color: 0xc23a2a, roughness: 0.5 });
const flameMat = (color: THREE.Color): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({
  color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
});
const DARK = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.6, metalness: 0.6, side: THREE.DoubleSide });
const FLAME_OUTER = flameMat(new THREE.Color(2.2, 0.8, 0.2));
const FLAME_INNER = flameMat(new THREE.Color(3.5, 3, 2));
const SPARK_COLORS = [0xffd080, 0xff7020, 0xffffff, 0x884422];
/** seconds between exhaust smoke puffs / sparks along the path */
const TRAIL_STEP = 0.03;
const UP = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();
const tail = new THREE.Vector3();
const puffAt = new THREE.Vector3();

/** The nose-up missile model shared by the flying missile and the one standing in its silo. */
export function makeMissileModel(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GEO.body, WHITE), nose = new THREE.Mesh(GEO.nose, RED);
  body.castShadow = nose.castShadow = true;
  g.add(body, nose, new THREE.Mesh(GEO.bell, DARK));
  for (const a of [0, Math.PI / 2]) {
    const fin = new THREE.Mesh(GEO.fin, RED);
    fin.rotation.y = a;
    g.add(fin);
  }
  return g;
}
/** the model's length from tail to tip, and how far its origin is above the tail */
export const MISSILE_LEN = BODY_LEN * 1.4 + BELL_LEN;
export const MISSILE_BELOW = BODY_LEN * 0.5 + BELL_LEN;

export interface MissileDeps {
  fx: Fx;
  dust: Dust;
  world: World;
  explosions: Explosions;
  /** the player's hit spheres */
  colliders: Collider[];
  onPlayerHit: (damage: number) => void;
  /** put it among the enemies, where bullets and the target lock can find it */
  add: (e: Enemy) => void;
  /** a missile has left `from`: whoever had that locked now has the missile locked */
  handOff: (from: Enemy, to: Enemy) => void;
  /** the screen shakes for a blast at `at` of this strength */
  shake: (at: THREE.Vector3, amount: number) => void;
}

/**
 * A silo's missile. It climbs straight up, far above the top of the view, turns over and comes back down onto
 * where the mech was at that moment, taking a few seconds to do it, so the mech can walk out from under. It is an
 * enemy for the whole flight: it can be locked on to and shot down (it goes off where it is). It is not scored.
 */
export class Rocket implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  readonly lockAnywhere = true;
  /** never scored */
  counted = true;
  retreating = false;
  gone = false;
  deadTime = 0;
  private dead = false;
  private hp: number;
  private state: 'climb' | 'dive' = 'climb';
  private readonly vel = new THREE.Vector3();
  private readonly flame = new THREE.Group();
  private readonly glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: new THREE.Color(2.4, 1.2, 0.4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
  }));
  private trail = 0;
  /** the way it leaves (a unit vector: straight up from a silo, along the tube from a launcher), and keeps accelerating until it turns over */
  private readonly climbDir = new THREE.Vector3(0, 1, 0);

  constructor(from: THREE.Vector3, private readonly apexY: number, private readonly deps: MissileDeps, private readonly profile: RocketProfile = MISSILE, launchDir?: THREE.Vector3) {
    this.hp = profile.hp;
    if (launchDir) this.climbDir.copy(launchDir).normalize();
    this.vel.copy(this.climbDir).multiplyScalar(profile.climbSpeed);
    this.group.quaternion.setFromUnitVectors(UP, this.climbDir);
    this.group.scale.setScalar(profile.scale);
    this.group.add(makeMissileModel());
    const outer = new THREE.Mesh(GEO.flame, FLAME_OUTER), inner = new THREE.Mesh(GEO.flame, FLAME_INNER);
    inner.scale.set(0.5, 0.7, 0.5);
    this.flame.add(outer, inner);
    // the flame starts at the mouth of the bell; its glow sits just below it, clear of the body
    this.flame.position.y = -BODY_LEN * 0.5 - BELL_LEN;
    this.glow.position.y = -BODY_LEN * 0.5 - BELL_LEN - 0.3;
    this.glow.renderOrder = 5;
    this.group.add(this.flame, this.glow);
    this.group.position.copy(from);
    const { fx, dust } = deps;
    const s = Math.max(0.35, profile.scale);          // the sparks and smoke of a small rocket are small
    sfx.rocketLaunch(from);
    fx.burst(from, 24, 3.5, SPARK_COLORS, false, 1.2 * s);
    fx.muzzleFlash(from);
    dust.puff(from, 12, 0.9 * s, 2.5 * s, 0.2);
  }

  get alive(): boolean { return !this.dead; }
  get x(): number { return this.group.position.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position, r = 0.9 * Math.max(0.5, this.profile.scale);       // generous: it is thin and moving
    out.min.set(p.x - r, p.y - r, p.z - r);
    out.max.set(p.x + r, p.y + r, p.z + r);
    return out;
  }

  /** Shot to pieces: it goes off where it is. Returns true if the hit destroyed it. */
  damage(n: number): boolean {
    if (this.dead) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.explode();
    return true;
  }

  dispose(): void {}

  /** @param mech where the mech is: the descent is aimed at it the moment the missile turns over */
  update(dt: number, mech: THREE.Vector3): void {
    if (this.dead) return;
    // the scene is over: it burns out harmlessly
    if (this.retreating) { this.dead = true; this.gone = true; this.group.visible = false; return; }
    const { world, colliders } = this.deps;
    const p = this.group.position;
    if (this.state === 'climb') {
      this.vel.addScaledVector(this.climbDir, this.profile.climbAccel * dt);
      if (p.y >= this.apexY) this.turnOver(mech);
    } else {
      this.vel.y -= this.profile.gravity * dt;
    }
    p.addScaledVector(this.vel, dt);
    this.group.quaternion.setFromUnitVectors(UP, dir.copy(this.vel).normalize());
    this.exhaust(dt);
    sfx.hold(this, 'rocketFlight', { x: p.x, rate: this.state === 'dive' ? 1.15 : 0.9 + Math.min(0.4, p.y / 40) }, 0.15);

    let hit = this.state === 'dive' && (world.solidAt(p.x, p.y, p.z) || p.y <= world.surfaceTop(p.x, p.z, p.y + 0.1));
    if (!hit) for (const c of colliders) if (p.distanceTo(c.pos) < c.r + RADIUS) { hit = true; break; }
    if (hit) this.explode();
  }

  /** at the top of the climb: aim at the mech where it is now (plus a miss) and start the lob down */
  private turnOver(mech: THREE.Vector3): void {
    const p = this.group.position;
    const flight = this.profile.flightMin + Math.random() * (this.profile.flightMax - this.profile.flightMin);
    const ax = mech.x + (Math.random() - 0.5) * 2 * this.profile.spreadX;
    const az = mech.z + (Math.random() - 0.5) * 2 * this.profile.spreadZ;
    this.state = 'dive';
    this.vel.set((ax - p.x) / flight, (0.3 - p.y) / flight + 0.5 * this.profile.gravity * flight, (az - p.z) / flight);
  }

  /** a flickering flame from the tail, sparks thrown off it, and a thick smoke trail behind */
  private exhaust(dt: number): void {
    const { fx, dust } = this.deps;
    const flick = 0.8 + Math.random() * 0.5;
    this.flame.scale.set(1, 1.6 * flick, 1);
    this.glow.scale.setScalar(0.9 * flick);
    this.trail -= dt;
    if (this.trail > 0) return;
    this.trail = TRAIL_STEP;
    const s = this.profile.scale, ps = Math.max(0.4, s);
    tail.copy(this.group.position).addScaledVector(dir, -(BODY_LEN * 0.5 + BELL_LEN + 0.1) * s);
    fx.burst(tail, 2, 2.5, SPARK_COLORS, false, 0.9 * ps);
    dust.puff(tail, 3, 0.55 * ps, 0.7 * ps, 0.3);
    if (Math.random() < 0.5) dust.plume(puffAt.copy(tail).addScaledVector(dir, -0.6 * s), 0.55 * ps, 2.2);
  }

  /** a big fireball with a column of smoke, and the screen shakes */
  private explode(): void {
    const { explosions, dust, world, colliders, onPlayerHit, shake } = this.deps;
    const at = this.group.position.clone();
    this.dead = true;
    this.gone = true;
    this.group.visible = false;
    const R = this.profile.blastRadius;
    explosions.detonate(at, R, this.profile.blastScale, 1.5);
    dust.puff(at, 16, 1.8, 3.5, 0.5);
    for (let i = 0; i < 8; i++) {
      puffAt.set(at.x + (Math.random() - 0.5) * R, at.y + Math.random() * 0.5, at.z + (Math.random() - 0.5) * R * 0.6);
      dust.plume(puffAt, 1.5, 3.5 + Math.random() * 2.5);
    }
    shake(at, this.profile.shake);
    world.forEachBuilding(at.x - R, at.x + R, (b) => b.damage(at.x, at.y, at.z, R));
    for (const c of colliders) {
      if (at.distanceTo(c.pos) < R + c.r) { onPlayerHit(this.profile.damage); break; }
    }
  }
}

/** Launches the silos' missiles. */
export class Missiles {
  constructor(private readonly deps: MissileDeps) {}

  /** Send a missile up from `from`, out of `by`; it climbs to a random height well above the view before it turns over. */
  launch(from: THREE.Vector3, by: Enemy, profile: RocketProfile = MISSILE, dir?: THREE.Vector3): void {
    const apex = profile.apexMin + Math.random() * (profile.apexMax - profile.apexMin);
    const rocket = new Rocket(from, apex, this.deps, profile, dir);
    this.deps.add(rocket);
    this.deps.handOff(by, rocket);
  }
}
