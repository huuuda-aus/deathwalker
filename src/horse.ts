import * as THREE from 'three';
import type { Fx } from './fx';
import { FLESH_IMPACT, type Enemy } from './enemies';
import { CANNON } from './config';
import { UNIT, HORSE, MANE, IRON, box } from './cannonParts';

type State = 'pulling' | 'bolting' | 'dead';

/** hit box in metres around the horse's middle (it faces -x) */
const BOX = { cx: -0.4, cy: 1.3, hx: 1.7, hy: 1.3, hz: 0.5 };
const GALLOP_RATE = { pulling: 14, bolting: 18 };

/**
 * The horse that drags a cannon in. Pulling, its owner places it; once released it bolts off to the left
 * on its own. It can be shot in either state. It does not count as a kill.
 */
export class Horse implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = FLESH_IMPACT;
  counted = true;
  retreating = false;
  gone = false;
  deadTime = 0;
  state: State = 'pulling';
  private hp: number = CANNON.horseHp;
  private phase = Math.random() * 6;
  private readonly legs: THREE.Group[] = [];
  private readonly body = new THREE.Group();

  constructor() {
    const { body, legs } = this;
    body.add(box(2.0, 0.85, 0.7, HORSE, 0, 1.35, 0));
    const neck = box(0.9, 0.35, 0.35, HORSE, -1.3, 1.9, 0);
    neck.rotation.z = -0.69;
    const head = box(0.6, 0.3, 0.3, HORSE, -1.8, 2.15, 0);
    head.rotation.z = 0.3;
    const mane = box(0.7, 0.1, 0.1, MANE, -1.15, 2.15, 0);
    mane.rotation.z = -0.69;
    const tail = box(0.12, 0.7, 0.12, MANE, 1.1, 1.3, 0);
    tail.rotation.z = 0.5;
    body.add(neck, head, mane, tail, box(0.25, 0.5, 0.75, IRON, -0.8, 1.4, 0)); // collar
    for (const [x, z] of [[-0.75, -0.25], [-0.75, 0.25], [0.75, -0.25], [0.75, 0.25]]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.95, z);
      leg.add(box(0.14, 0.95, 0.14, HORSE, 0, -0.475, 0));
      body.add(leg);
      legs.push(leg);
    }
    body.scale.setScalar(UNIT);
    this.group.add(body);
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get x(): number { return this.group.position.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    out.min.set(p.x + (BOX.cx - BOX.hx) * UNIT, p.y + (BOX.cy - BOX.hy) * UNIT, p.z - BOX.hz * UNIT);
    out.max.set(p.x + (BOX.cx + BOX.hx) * UNIT, p.y + (BOX.cy + BOX.hy) * UNIT, p.z + BOX.hz * UNIT);
    return out;
  }

  /** while pulling, the cannon decides where the horse is */
  place(x: number, z: number): void { this.group.position.x = x; this.group.position.z = z; }

  /** unhitched: run off to the left */
  release(): void { if (this.state === 'pulling') this.state = 'bolting'; }

  damage(n: number, fx: Fx): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.state = 'dead';
    this.deadTime = 0;
    const p = this.group.position;
    fx.burst(new THREE.Vector3(p.x, p.y + 1.3 * UNIT, p.z), 14, 2.5, [0x8a1010, 0xc02020, 0xffa040]);
    return true;
  }

  dispose(): void {}

  update(dt: number, target: THREE.Vector3): void {
    const g = this.group;
    if (this.state === 'dead') {
      // roll over onto its side
      this.deadTime += dt;
      const k = Math.min(1, this.deadTime / 0.5);
      g.rotation.x = -1.45 * k;
      g.position.y = 0.35 * UNIT * k;
      return;
    }
    if (this.state === 'bolting') {
      g.position.x -= CANNON.rideSpeed * CANNON.horseBoltFactor * dt;
      // far off the left of the screen: gone
      if (g.position.x < target.x - 40) this.gone = true;
    }
    this.phase += dt * GALLOP_RATE[this.state];
    const { legs } = this;
    legs[0].rotation.z = Math.sin(this.phase) * 0.7;
    legs[1].rotation.z = Math.sin(this.phase + 0.5) * 0.7;
    legs[2].rotation.z = Math.sin(this.phase + Math.PI) * 0.7;
    legs[3].rotation.z = Math.sin(this.phase + Math.PI + 0.5) * 0.7;
    g.position.y = Math.abs(Math.sin(this.phase * 0.5)) * 0.12 * UNIT;
  }
}
