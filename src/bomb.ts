import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Explosions } from './explosions';
import type { World } from './world';
import type { Collider } from './debris';
import { BOMB } from './config';

const WHITE = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.5, metalness: 0.2 });
const FIN = new THREE.MeshStandardMaterial({ color: 0xd6dade, roughness: 0.6 });
/** bomb size: about a soldier tall (a soldier is ~0.3 units) */
const LEN = 0.3;
const RADIUS = 0.055;
const GEO = {
  body: new THREE.CylinderGeometry(RADIUS, RADIUS, LEN * 0.7, 10).rotateZ(-Math.PI / 2),
  nose: new THREE.ConeGeometry(RADIUS, LEN * 0.3, 10).rotateZ(-Math.PI / 2).translate(LEN * 0.5, 0, 0),
  fin: new THREE.BoxGeometry(LEN * 0.18, RADIUS * 3.4, 0.012),
};
const FWD = new THREE.Vector3(1, 0, 0);
const dir = new THREE.Vector3();

export interface BombDeps {
  world: World;
  explosions: Explosions;
  /** the player's hit spheres */
  colliders: Collider[];
  onPlayerHit: (damage: number) => void;
}

/**
 * A bomb dropped from a plane. It is an enemy so bullets (and the target lock) can find it: one hit sets it off
 * in the air. It is not part of the kill count.
 */
export class Bomb implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  /** never scored */
  counted = true;
  retreating = false;
  gone = false;
  deadTime = 0;
  private dead = false;
  private readonly vel = new THREE.Vector3();

  constructor(from: THREE.Vector3, vel: THREE.Vector3, private readonly deps: BombDeps) {
    const body = new THREE.Mesh(GEO.body, WHITE), nose = new THREE.Mesh(GEO.nose, WHITE);
    body.castShadow = nose.castShadow = true;
    this.group.add(body, nose);
    for (const a of [0, Math.PI / 2]) {
      const fin = new THREE.Mesh(GEO.fin, FIN);
      fin.position.x = -LEN * 0.38;
      fin.rotation.x = a;
      this.group.add(fin);
    }
    this.group.position.copy(from);
    this.vel.copy(vel);
    this.point();
  }

  get alive(): boolean { return !this.dead; }
  get x(): number { return this.group.position.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position, r = 0.2;      // a little generous: it is small and falling
    out.min.set(p.x - r, p.y - r, p.z - r);
    out.max.set(p.x + r, p.y + r, p.z + r);
    return out;
  }

  /** Any hit sets it off where it is. */
  damage(_n: number, _fx: Fx): boolean {
    if (this.dead) return false;
    this.explode();
    return true;
  }

  dispose(): void {}

  update(dt: number): void {
    if (this.dead) return;
    const { world, colliders } = this.deps;
    const p = this.group.position;
    this.vel.y -= BOMB.gravity * dt;
    p.addScaledVector(this.vel, dt);
    this.point();
    let hit = world.solidAt(p.x, p.y, p.z) || p.y <= Math.max(0, world.surfaceTop(p.x, p.z, p.y + 0.1));
    if (!hit) for (const c of colliders) if (p.distanceTo(c.pos) < c.r + RADIUS) { hit = true; break; }
    if (hit) this.explode();
  }

  /** nose along the way it is travelling */
  private point(): void {
    if (this.vel.lengthSq() < 1e-6) return;
    this.group.quaternion.setFromUnitVectors(FWD, dir.copy(this.vel).normalize());
  }

  private explode(): void {
    const { explosions, world, colliders, onPlayerHit } = this.deps;
    const at = this.group.position.clone();
    this.dead = true;
    this.gone = true;
    this.group.visible = false;
    const R = BOMB.blastRadius;
    explosions.detonate(at, R, BOMB.blastScale);
    world.forEachBuilding(at.x - R, at.x + R, (b) => b.damage(at.x, at.y, at.z, R));
    for (const c of colliders) {
      if (at.distanceTo(c.pos) < R + c.r) { onPlayerHit(BOMB.damage); break; }
    }
  }
}
