import * as THREE from 'three';
import type { Enemy } from './enemies';
import type { Hit } from './targeting';
import { ndcToPx } from './view';

/** how close (screen pixels) the reticle has to be to a target's centre to lock it when it is not exactly on it */
const PICK_RADIUS_PX = 70;
/** a locked target further than this beyond the screen edge (in NDC) is lost */
const LOSE_BEYOND = 1.15;

const box = new THREE.Box3();
const centre = new THREE.Vector3();

/**
 * Lock-on, as in the original: press and hold the lock button over an enemy and the reticle stays glued to the
 * middle of it, wherever it goes, until it is destroyed or the button is let go. The fire button works as usual
 * meanwhile (both can be held at once). The reticle follows the target: this just says where it is on screen.
 */
export class TargetLock {
  target: Enemy | null = null;
  private readonly ndc = new THREE.Vector2();
  private readonly px = new THREE.Vector2();

  /** Lock button pressed: lock the enemy under the reticle, or else the one nearest to it (nothing, if none is close). */
  acquire(enemies: Enemy[], camera: THREE.Camera, mousePx: { x: number; y: number }, aimed: Hit): void {
    this.target = aimed.kind === 'enemy' && aimed.enemy?.alive ? aimed.enemy : this.nearest(enemies, camera, mousePx);
  }

  /** The locked target turned into something else (a silo's missile leaving it): keep the lock, on the new one. */
  handOff(from: Enemy, to: Enemy): void { if (this.target === from) this.target = to; }

  /** Lock button let go (or the game restarted). */
  release(): void { this.target = null; }

  /**
   * Per frame: drop a target that is dead, gone or off the screen.
   * @returns where the reticle is while locked (NDC), or null when there is no lock
   */
  update(enemies: Enemy[], camera: THREE.Camera): THREE.Vector2 | null {
    const t = this.target;
    if (!t) return null;
    if (!t.alive || t.gone || !enemies.includes(t) || !this.project(t, camera) ||
        (!t.lockAnywhere && (Math.abs(this.ndc.x) > LOSE_BEYOND || Math.abs(this.ndc.y) > LOSE_BEYOND))) {
      this.target = null;
      return null;
    }
    return this.ndc;
  }

  /** the locked reticle in CSS pixels (valid after `update` returned a position); a target off the screen shows it at the edge */
  get reticlePx(): { x: number; y: number } {
    const edge = 12;
    this.px.set(
      THREE.MathUtils.clamp(ndcToPx(this.ndc.x, innerWidth), edge, innerWidth - edge),
      THREE.MathUtils.clamp((1 - this.ndc.y) / 2 * innerHeight, edge, innerHeight - edge),
    );
    return this.px;
  }

  /** the middle of an enemy, on the screen (NDC); false if it is behind the camera */
  private project(e: Enemy, camera: THREE.Camera): boolean {
    e.getBox(box).getCenter(centre).project(camera);
    if (centre.z > 1) return false;
    this.ndc.set(centre.x, centre.y);
    return true;
  }

  private nearest(enemies: Enemy[], camera: THREE.Camera, mousePx: { x: number; y: number }): Enemy | null {
    let best: Enemy | null = null, bestD = PICK_RADIUS_PX;
    for (const e of enemies) {
      if (!e.alive || !this.project(e, camera)) continue;
      const d = Math.hypot(ndcToPx(this.ndc.x, innerWidth) - mousePx.x, (1 - this.ndc.y) / 2 * innerHeight - mousePx.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }
}
