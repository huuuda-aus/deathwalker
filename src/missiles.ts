import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Dust } from './dust';
import type { World } from './world';
import type { Collider } from './debris';
import type { Explosions } from './explosions';
import { glowTexture } from './fireTextures';
import { MISSILE } from './config';

const BODY_LEN = 1.6;
const RADIUS = 0.2;
const GEO = {
  body: new THREE.CylinderGeometry(RADIUS, RADIUS, BODY_LEN, 10),
  nose: new THREE.ConeGeometry(RADIUS, BODY_LEN * 0.4, 10).translate(0, BODY_LEN * 0.7, 0),
  fin: new THREE.BoxGeometry(RADIUS * 3.2, BODY_LEN * 0.22, 0.02).translate(0, -BODY_LEN * 0.4, 0),
  /** the exhaust flame: a cone pointing down from the tail */
  flame: new THREE.ConeGeometry(RADIUS * 0.9, 1, 10, 1, true).rotateX(Math.PI).translate(0, -0.5, 0),
};
const WHITE = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.5, metalness: 0.2 });
const RED = new THREE.MeshStandardMaterial({ color: 0xc23a2a, roughness: 0.5 });
const flameMat = (color: THREE.Color): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({
  color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
});
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
  g.add(body, nose);
  for (const a of [0, Math.PI / 2]) {
    const fin = new THREE.Mesh(GEO.fin, RED);
    fin.rotation.y = a;
    g.add(fin);
  }
  return g;
}
/** the model's length from tail to tip, and how far its origin is above the tail */
export const MISSILE_LEN = BODY_LEN * 1.4;
export const MISSILE_BELOW = BODY_LEN * 0.5;

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
  /** never scored */
  counted = true;
  retreating = false;
  gone = false;
  deadTime = 0;
  private dead = false;
  private hp: number = MISSILE.hp;
  private state: 'climb' | 'dive' = 'climb';
  private readonly vel = new THREE.Vector3(0, MISSILE.climbSpeed, 0);
  private readonly flame = new THREE.Group();
  private readonly glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: new THREE.Color(2.4, 1.2, 0.4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
  }));
  private trail = 0;

  constructor(from: THREE.Vector3, private readonly apexY: number, private readonly deps: MissileDeps) {
    this.group.add(makeMissileModel());
    const outer = new THREE.Mesh(GEO.flame, FLAME_OUTER), inner = new THREE.Mesh(GEO.flame, FLAME_INNER);
    inner.scale.set(0.5, 0.7, 0.5);
    this.flame.add(outer, inner);
    this.flame.position.y = -BODY_LEN * 0.5;
    this.glow.position.y = -BODY_LEN * 0.5;
    this.glow.renderOrder = 5;
    this.group.add(this.flame, this.glow);
    this.group.position.copy(from);
    const { fx, dust } = deps;
    fx.burst(from, 24, 3.5, SPARK_COLORS, false, 1.2);
    fx.muzzleFlash(from);
    dust.puff(from, 12, 0.9, 2.5, 0.2);
  }

  get alive(): boolean { return !this.dead; }
  get x(): number { return this.group.position.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position, r = 0.7;       // generous: it is thin and moving
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
      this.vel.y += MISSILE.climbAccel * dt;
      if (p.y >= this.apexY) this.turnOver(mech);
    } else {
      this.vel.y -= MISSILE.gravity * dt;
    }
    p.addScaledVector(this.vel, dt);
    this.group.quaternion.setFromUnitVectors(UP, dir.copy(this.vel).normalize());
    this.exhaust(dt);

    let hit = this.state === 'dive' && (world.solidAt(p.x, p.y, p.z) || p.y <= Math.max(0, world.surfaceTop(p.x, p.z, p.y + 0.1)));
    if (!hit) for (const c of colliders) if (p.distanceTo(c.pos) < c.r + RADIUS) { hit = true; break; }
    if (hit) this.explode();
  }

  /** at the top of the climb: aim at the mech where it is now (plus a miss) and start the lob down */
  private turnOver(mech: THREE.Vector3): void {
    const p = this.group.position;
    const flight = MISSILE.flightMin + Math.random() * (MISSILE.flightMax - MISSILE.flightMin);
    const ax = mech.x + (Math.random() - 0.5) * 2 * MISSILE.spreadX;
    const az = mech.z + (Math.random() - 0.5) * 2 * MISSILE.spreadZ;
    this.state = 'dive';
    this.vel.set((ax - p.x) / flight, (0.3 - p.y) / flight + 0.5 * MISSILE.gravity * flight, (az - p.z) / flight);
  }

  /** a flickering flame from the tail, sparks thrown off it, and a thick smoke trail behind */
  private exhaust(dt: number): void {
    const { fx, dust } = this.deps;
    const flick = 0.8 + Math.random() * 0.5;
    this.flame.scale.set(1, 1.6 * flick, 1);
    this.glow.scale.setScalar(1.3 * flick);
    this.trail -= dt;
    if (this.trail > 0) return;
    this.trail = TRAIL_STEP;
    tail.copy(this.group.position).addScaledVector(dir, -BODY_LEN * 0.55);
    fx.burst(tail, 2, 2.5, SPARK_COLORS, false, 0.9);
    dust.puff(tail, 3, 0.55, 0.7, 0.3);
    if (Math.random() < 0.5) dust.plume(puffAt.copy(tail).addScaledVector(dir, -0.6), 0.55, 2.2);
  }

  /** a big fireball with a column of smoke, and the screen shakes */
  private explode(): void {
    const { explosions, dust, world, colliders, onPlayerHit, shake } = this.deps;
    const at = this.group.position.clone();
    this.dead = true;
    this.gone = true;
    this.group.visible = false;
    const R = MISSILE.blastRadius;
    explosions.detonate(at, R, MISSILE.blastScale, 1.5);
    dust.puff(at, 16, 1.8, 3.5, 0.5);
    for (let i = 0; i < 8; i++) {
      puffAt.set(at.x + (Math.random() - 0.5) * R, at.y + Math.random() * 0.5, at.z + (Math.random() - 0.5) * R * 0.6);
      dust.plume(puffAt, 1.5, 3.5 + Math.random() * 2.5);
    }
    shake(at, MISSILE.shake);
    world.forEachBuilding(at.x - R, at.x + R, (b) => b.damage(at.x, at.y, at.z, R));
    for (const c of colliders) {
      if (at.distanceTo(c.pos) < R + c.r) { onPlayerHit(MISSILE.damage); break; }
    }
  }
}

/** Launches the silos' missiles. */
export class Missiles {
  constructor(private readonly deps: MissileDeps) {}

  /** Send a missile up from `from`; it climbs to a random height well above the view before it turns over. */
  launch(from: THREE.Vector3): void {
    const apex = MISSILE.apexMin + Math.random() * (MISSILE.apexMax - MISSILE.apexMin);
    this.deps.add(new Rocket(from, apex, this.deps));
  }
}
