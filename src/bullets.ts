import * as THREE from 'three';
import type { Fx } from './fx';
import type { World } from './world';
import type { Collider, Debris } from './debris';
import { ENEMY_FIRE } from './config';
import { PointPool } from './pointpool';
import { sfx } from './sfx';

const MAX = 96;
const BULLET_R = 0.03;
/** a bullet that has not hit anything after this long is dropped */
const LIFE = 6;
/** a bullet is a bright dot this many screen pixels across (HDR, so it blooms a little) */
const DOT_PX = 2.5;
const SPARKS = [0xffd080, 0xffffff];

interface Bullet { pos: THREE.Vector3; vel: THREE.Vector3; age: number }

const material = (): THREE.ShaderMaterial => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uPixelRatio: { value: 1 }, uSize: { value: DOT_PX } },
  vertexShader: /* glsl */ `
    uniform float uPixelRatio, uSize;
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize * uPixelRatio;
    }`,
  fragmentShader: /* glsl */ `
    void main() { gl_FragColor = vec4(3.0, 2.6, 1.4, 1.0); }`,
});

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

/**
 * Enemy rifle bullets: straight, fast but not instant (see `ENEMY_FIRE.bulletSpeed`), stopped by the first wall,
 * rubble, the ground or the mech. A bullet that was aimed well hits unless the mech has stepped aside.
 */
export class Bullets {
  private readonly mat = material();
  private readonly pool: PointPool<Bullet>;

  constructor(private readonly deps: BulletDeps) {
    this.pool = new PointPool(deps.scene, MAX, this.mat, { position: 3 });
  }

  setPixelRatio(r: number): void { this.mat.uniforms.uPixelRatio.value = r; }

  /** Send a bullet from `from` toward `aim`. */
  fire(from: THREE.Vector3, aim: THREE.Vector3, speed: number = ENEMY_FIRE.bulletSpeed, heavy = false): void {
    if (this.pool.full) return;
    if (heavy) sfx.gunnerShot(from); else sfx.enemyShot(from);
    const vel = new THREE.Vector3().subVectors(aim, from).normalize().multiplyScalar(speed);
    this.pool.push({ pos: from.clone(), vel, age: 0 });
  }

  update(dt: number): void {
    const { items } = this.pool;
    for (let i = items.length - 1; i >= 0; i--) {
      const b = items[i];
      b.age += dt;
      prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      if (b.age > LIFE || this.collide(prev, b.pos)) this.pool.removeAt(i);
    }
    this.draw();
  }

  clear(): void {
    this.pool.items.length = 0;
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
        fx.sparks(hitAt, 8, 3, [0xffa040, 0xffffff]);
        sfx.impact('metal', hitAt);
        onPlayerHit();
        return true;
      }
    }
    // rubble and walls
    if (debris.segmentHit(a, b, hitAt) || world.wallSegmentHit(a, b, hitAt)) return this.impact(hitAt);
    ray.set(a, seg.divideScalar(len));
    if (world.raycast(ray, hitAt) < len) return this.impact(hitAt);
    // the ground, or a floor
    if (b.y <= world.surfaceTop(b.x, b.z, b.y + 0.1)) return this.impact(b);
    return false;
  }

  private impact(at: THREE.Vector3): boolean {
    this.deps.fx.sparks(at, 7, 3, SPARKS);
    return true;
  }

  private draw(): void {
    this.pool.upload((b, i, a) => a.position.setXYZ(i, b.pos.x, b.pos.y, b.pos.z));
  }
}
