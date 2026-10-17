import * as THREE from 'three';
import type { Fx } from './fx';
import type { World } from './world';
import type { Collider, Debris } from './debris';
import { ENEMY_FIRE } from './config';

const MAX = 96;
const BULLET_R = 0.03;
/** a bullet that has not hit anything after this long is dropped */
const LIFE = 6;
/** the tracer: a short bright streak along the line of flight (HDR, so it blooms) */
const GEO = new THREE.BoxGeometry(0.014, 0.014, 0.18);
const MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.6, 1.4), toneMapped: false });
const SPARKS = [0xffd080, 0xffffff];
const Z = new THREE.Vector3(0, 0, 1);

interface Bullet { pos: THREE.Vector3; vel: THREE.Vector3; age: number }

export interface BulletDeps {
  scene: THREE.Scene;
  fx: Fx;
  world: World;
  debris: Debris;
  /** the player's hit spheres */
  colliders: Collider[];
  onPlayerHit: () => void;
}

const prev = new THREE.Vector3();
const seg = new THREE.Vector3();
const hitAt = new THREE.Vector3();
const ray = new THREE.Ray();
const dummy = new THREE.Object3D();

/**
 * Enemy rifle bullets: straight, fast but not instant (see `ENEMY_FIRE.bulletSpeed`), stopped by the first wall,
 * rubble, the ground or the mech. A bullet that was aimed well hits unless the mech has stepped aside.
 */
export class Bullets {
  private live: Bullet[] = [];
  private readonly mesh = new THREE.InstancedMesh(GEO, MAT, MAX);

  constructor(private readonly deps: BulletDeps) {
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    deps.scene.add(this.mesh);
  }

  /** Send a bullet from `from` toward `aim`. */
  fire(from: THREE.Vector3, aim: THREE.Vector3): void {
    if (this.live.length >= MAX) return;
    const vel = new THREE.Vector3().subVectors(aim, from).normalize().multiplyScalar(ENEMY_FIRE.bulletSpeed);
    this.live.push({ pos: from.clone(), vel, age: 0 });
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.age += dt;
      prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      if (b.age > LIFE || this.collide(prev, b.pos)) { this.live.splice(i, 1); }
    }
    this.draw();
  }

  clear(): void {
    this.live.length = 0;
    this.draw();
  }

  /** Did the bullet hit something on its way from a to b this step? (b is moved back to the impact point) */
  private collide(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const { world, debris, colliders, fx, onPlayerHit } = this.deps;
    seg.subVectors(b, a);
    const len = seg.length();
    if (len < 1e-6) return false;
    // the mech: closest approach of the path to each hit sphere
    for (const c of colliders) {
      const t = THREE.MathUtils.clamp(((c.pos.x - a.x) * seg.x + (c.pos.y - a.y) * seg.y + (c.pos.z - a.z) * seg.z) / (len * len), 0, 1);
      hitAt.copy(a).addScaledVector(seg, t);
      if (hitAt.distanceTo(c.pos) < c.r + BULLET_R) {
        fx.sparks(hitAt, 3, 2.5, [0xffa040, 0xffffff]);
        onPlayerHit();
        return true;
      }
    }
    // rubble and walls
    if (debris.segmentHit(a, b, hitAt)) return this.impact(hitAt);
    ray.set(a, seg.divideScalar(len));
    if (world.raycast(ray, hitAt) < len) return this.impact(hitAt);
    // the ground, or a floor
    if (b.y <= Math.max(0, world.surfaceTop(b.x, b.z, b.y + 0.1))) return this.impact(b);
    return false;
  }

  private impact(at: THREE.Vector3): boolean {
    this.deps.fx.sparks(at, 3, 2.5, SPARKS);
    return true;
  }

  private draw(): void {
    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const b = this.live[i];
      dummy.position.copy(b.pos);
      dummy.quaternion.setFromUnitVectors(Z, seg.copy(b.vel).normalize());
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
