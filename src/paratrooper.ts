import * as THREE from 'three';
import type { Fx } from './fx';
import { Soldier, type ShotFn, type SoldierEnv } from './enemies';
import { PARATROOPER } from './config';

const CANOPY = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.9, side: THREE.DoubleSide });
const STRIPE = new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.9, side: THREE.DoubleSide });
const LINES = new THREE.LineBasicMaterial({ color: 0xd8dde2 });
/** canopy: its radius, and its height over his feet (world units) */
const CANOPY_R = 0.22;
const CANOPY_Y = 0.6;
const CANOPY_GEO = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
/** the suspension lines, from points round the canopy's rim to his shoulders */
const LINE_GEO = (() => {
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(Math.cos(a) * CANOPY_R, CANOPY_Y, Math.sin(a) * CANOPY_R, 0, 0.3, 0);
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
})();

type Phase = 'free' | 'chute' | 'down';

/**
 * A paratrooper: out of the zeppelin, a short free fall, then the canopy opens and he floats down, swaying and drifting with the wind,
 * a good target the whole way (the canopy counts as him). He does not fire until he is on the ground, where he is an ordinary
 * infantryman: he cuts the chute and runs to a spot of his own.
 */
export class Paratrooper extends Soldier {
  private fall: Phase = 'free';
  private fallT = 0;
  private vy = 0;
  private vz: number;
  private readonly chute = new THREE.Group();
  private readonly swayPhase = Math.random() * 6;

  /** @param laneZ the depth he is heading for: he drifts toward it as he falls */
  constructor(x: number, y: number, z: number, laneZ: number, env: SoldierEnv) {
    super(x, z, env);
    this.group.position.y = y;
    this.plan = 'scatter';
    // time to the ground at the floating speed (the free fall is short), and so the sideways speed that gets him to his lane
    this.vz = (laneZ - z) / Math.max(1, y / PARATROOPER.descent);
    const canopy = new THREE.Mesh(CANOPY_GEO, CANOPY);
    canopy.scale.set(CANOPY_R, CANOPY_R * 0.62, CANOPY_R);
    canopy.position.y = CANOPY_Y;
    canopy.castShadow = true;
    const stripe = new THREE.Mesh(CANOPY_GEO, STRIPE);
    stripe.scale.set(CANOPY_R * 1.005, CANOPY_R * 0.625, CANOPY_R * 0.35);
    stripe.position.y = CANOPY_Y;
    this.chute.add(canopy, stripe, new THREE.LineSegments(LINE_GEO, LINES));
    this.chute.visible = false;
    this.chute.scale.setScalar(0.01);
    this.group.add(this.chute);
    this.gun.visible = false;                      // he does not shoot on the way down
    this.setBox(true);
  }

  /** While he hangs under the canopy the box takes in the canopy, so shooting it hits him. */
  private setBox(hanging: boolean): void {
    if (hanging) { this.centerY = 0.3; this.half.y = 0.34; } else { this.centerY = this.stand.centerY; this.half.y = this.stand.halfY; }
  }

  /** is he still in the air? */
  get airborne(): boolean { return this.alive && this.fall !== 'down'; }

  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    if (this.airborne && this.hp - n <= 0) { this.cause = 'air'; this.chute.visible = false; }
    return super.damage(n, fx, push);
  }

  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: ShotFn): void {
    if (this.state !== 'walk' || this.fall === 'down') { super.update(dt, target, fx, onShoot); return; }
    const g = this.group.position;
    this.fallT += dt;
    const dir = Math.sign(target.x - this.x) || 1;
    this.fallDir = dir;
    this.body.scale.x = dir * this.k;
    if (this.fall === 'free') {
      // out of the hatch: he falls, tumbling a little
      this.vy -= 12 * dt;
      this.body.rotation.z = Math.sin(this.fallT * 9 + this.swayPhase) * 0.5;
      if (this.fallT >= PARATROOPER.freeFall) { this.fall = 'chute'; this.fallT = 0; this.chute.visible = true; }
    } else {
      // the canopy opens with a jerk, and slows him to a steady float
      const open = Math.min(1, this.fallT / PARATROOPER.open);
      this.chute.scale.setScalar(0.01 + 0.99 * open);
      this.vy += (-PARATROOPER.descent - this.vy) * Math.min(1, dt * (open < 1 ? 7 : 3));
      const sway = Math.sin(this.fallT * 1.7 + this.swayPhase);
      this.body.rotation.z = sway * 0.08;
      this.chute.rotation.z = -sway * 0.12;
      g.x += (PARATROOPER.drift + sway * PARATROOPER.sway) * dt;
      g.z += this.vz * dt;
      for (const l of this.legs) l.rotation.z = 0.12 + sway * 0.1;                 // legs hanging
    }
    g.y += this.vy * dt;
    const ground = Math.max(0, this.env.surface(this.x, this.z, g.y + 0.5));
    if (g.y <= ground) {
      g.y = ground;
      this.fall = 'down';
      this.chute.visible = false;                    // he cuts the chute and it is left behind
      this.setBox(false);
      this.body.rotation.z = 0;
      this.resetPose();
      fx.burst(new THREE.Vector3(this.x, 0.05, this.z), 6, 1.2, [0x6b5a45, 0x4a3a28], true, 0.7);
      this.post = null;
      this.holding = false;
    }
  }
}
