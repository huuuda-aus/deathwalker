import * as THREE from 'three';
import type { Dust } from './dust';
import { terrainHeight } from './terrain';

const GRAVITY = 8;
/** sliding along the ground slows a piece at this rate (1/s) */
const GROUND_DRAG = 3;
/** landing faster than this (units/s) is a bounce; slower is just resting contact */
const BOUNCE_MIN = 1;

/** A piece blown off a wreck: it flies, tumbles and bounces until it comes to rest in the `rest` orientation. */
interface Flung {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  restY: number;
  rest: Partial<Record<'x' | 'y' | 'z', number>>;
  settled: boolean;
}

const tmp = new THREE.Vector3();

/** The parts thrown off a destroyed vehicle or gun (with their physics), and the smoke the wreck gives off. */
export class Wreckage {
  private parts: Flung[] = [];
  private smoke = 0;

  /** @param world where flung parts end up (the scene): they are detached from their vehicle into it */
  constructor(private readonly world: THREE.Object3D) {}

  /**
   * Detach `obj` (keeping where it is) and let it fly.
   * @param restY height of its centre when lying on the ground
   * @param rest rotation to settle into once it stops bouncing
   */
  fling(obj: THREE.Object3D, vel: THREE.Vector3, spin: THREE.Vector3, restY: number, rest: Flung['rest'] = {}): void {
    this.world.attach(obj);
    this.parts.push({ obj, vel, spin, restY, rest, settled: false });
  }

  update(dt: number): void {
    for (const f of this.parts) {
      if (f.settled) continue;
      const { obj, vel, spin } = f;
      vel.y -= GRAVITY * dt;
      obj.position.addScaledVector(vel, dt);
      obj.rotation.x += spin.x * dt;
      obj.rotation.y += spin.y * dt;
      obj.rotation.z += spin.z * dt;
      const floor = f.restY + terrainHeight(obj.position.x, obj.position.z);       // the dunes are not flat
      if (obj.position.y > floor) continue;
      obj.position.y = floor;
      const impact = -vel.y;
      if (impact > BOUNCE_MIN) {
        // a real bounce: it rebounds a little and loses some speed and spin
        vel.y = impact * 0.3;
        vel.x *= 0.6; vel.z *= 0.6;
        spin.multiplyScalar(0.6);
      } else {
        vel.y = 0;
      }
      // on the ground it slides on and slows gradually rather than stopping dead
      const drag = Math.exp(-GROUND_DRAG * dt);
      vel.x *= drag; vel.z *= drag;
      if (vel.y === 0) spin.multiplyScalar(Math.exp(-6 * dt));
      if (vel.y === 0 && Math.hypot(vel.x, vel.z) < 0.15) {
        f.settled = true;
        if (f.rest.x !== undefined) obj.rotation.x = f.rest.x;
        if (f.rest.y !== undefined) obj.rotation.y = f.rest.y;
        if (f.rest.z !== undefined) obj.rotation.z = f.rest.z;
      }
    }
  }

  /** thin smoke rising from `at` for `duration` seconds since the wreck formed (`age`) */
  smoulder(dt: number, age: number, at: THREE.Vector3, dust: Dust, duration = 6): void {
    if (age > duration) return;
    this.smoke -= dt;
    if (this.smoke > 0) return;
    this.smoke = 0.12;
    dust.puff(tmp.copy(at), 1, 0.2, 0.3);
  }

  dispose(): void {
    for (const f of this.parts) f.obj.removeFromParent();
    this.parts.length = 0;
  }
}
