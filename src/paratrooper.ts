import * as THREE from 'three';
import type { Fx } from './fx';
import { Soldier, type Enemy, type ImpactFx, type ShotFn, type SoldierEnv } from './enemies';
import { glowTexture } from './fireTextures';
import { PARATROOPER } from './config';

const CANOPY = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.9, side: THREE.DoubleSide });
const STRIPE = new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.9, side: THREE.DoubleSide });
const LINES = new THREE.LineBasicMaterial({ color: 0xd8dde2 });
const CHAR = new THREE.Color(0x151515);
const FIRE = [0xfff2c0, 0xffa030, 0xff5a10];
const SMOKE = [0x222222, 0x333333, 0x444444];
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
/** what a bullet strike on cloth throws up: a few pale specks and a hot ember or two */
const FABRIC_IMPACT: ImpactFx = { colors: [0xffffff, 0xffd9a0], sparks: 3, embers: 1, sound: 'flesh' };
/** a freed canopy: how long it burns (s), how fast it sinks (accelerating, units/s) */
const BURN_LIFE = 4;
const SINK = { from: 1.2, to: 5, accel: 4 };

type Phase = 'free' | 'chute' | 'down';

/** A canopy that has come off its paratrooper: it deflates and sinks, burning if it was shot, and is gone after a few seconds. */
interface FreeChute { group: THREE.Group; age: number; vy: number; burning: boolean; sprites: THREE.Sprite[]; mats: THREE.MeshStandardMaterial[]; landed: boolean; ember: number }

/**
 * A paratrooper: out of the zeppelin, a short free fall, then the canopy opens and he floats down, swaying and drifting with the wind.
 * He has two targets: himself, and his parachute (a `ParachuteTarget` of its own). Shoot the canopy and it deflates and burns while he
 * plunges to his death, screaming. He does not fire until he is on the ground, where he is an ordinary infantryman: he cuts the chute
 * and runs to a spot of his own.
 */
export class Paratrooper extends Soldier {
  private fall: Phase = 'free';
  private fallT = 0;
  private vy = 0;
  private vz: number;
  private chute = new THREE.Group();
  private chuteMats: THREE.MeshStandardMaterial[] = [];
  private readonly swayPhase = Math.random() * 6;
  /** how fast he floats down (units/s) */
  private readonly floatSpeed: number;
  /** the canopy once it has come off */
  private freed: FreeChute | null = null;

  /** @param laneZ the depth he is heading for: he drifts toward it as he falls */
  constructor(x: number, y: number, z: number, laneZ: number, env: SoldierEnv, speed = 1) {
    super(x, z, env);
    this.floatSpeed = PARATROOPER.descent * speed;
    this.group.position.y = y;
    this.plan = 'scatter';
    // time to the ground at the floating speed (the free fall is short), and so the sideways speed that gets him to his lane
    this.vz = (laneZ - z) / Math.max(1, y / this.floatSpeed);
    const canopyMat = CANOPY.clone(), stripeMat = STRIPE.clone();
    this.chuteMats = [canopyMat, stripeMat];
    const canopy = new THREE.Mesh(CANOPY_GEO, canopyMat);
    canopy.scale.set(CANOPY_R, CANOPY_R * 0.62, CANOPY_R);
    canopy.position.y = CANOPY_Y;
    canopy.castShadow = true;
    const stripe = new THREE.Mesh(CANOPY_GEO, stripeMat);
    stripe.scale.set(CANOPY_R * 1.005, CANOPY_R * 0.625, CANOPY_R * 0.35);
    stripe.position.y = CANOPY_Y;
    this.chute.add(canopy, stripe, new THREE.LineSegments(LINE_GEO, LINES));
    this.chute.visible = false;
    this.chute.scale.setScalar(0.01);
    this.group.add(this.chute);
    this.gun.visible = false;                      // he does not shoot on the way down
  }

  /** is he still in the air? */
  get airborne(): boolean { return this.alive && this.fall !== 'down'; }

  /** is there a canopy over him to shoot at (open enough, and still on him)? */
  get hasCanopy(): boolean { return this.alive && this.fall === 'chute' && this.fallT > PARATROOPER.open * 0.5 && !this.freed; }

  /** where the middle of his canopy is, in the world */
  canopyAt(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.x, this.group.position.y + CANOPY_Y * 0.95, this.z);
  }

  /**
   * His canopy was shot: it deflates and burns, and he, with nothing to hold him up, plunges to his death, screaming.
   */
  cutChute(fx: Fx): void {
    if (!this.hasCanopy) return;
    this.freeChute(true);
    this.forcePlunge = true;
    this.damage(9999, fx);
    this.deadVy = 0;                               // he simply drops (the usual death hop would send him up)
  }

  /** the canopy comes off him (burning or just limp) and sinks away by itself */
  private freeChute(burning: boolean): void {
    if (this.freed) return;
    const scene = this.group.parent;
    if (!scene) return;
    scene.attach(this.chute);
    this.chute.visible = true;
    const sprites: THREE.Sprite[] = [];
    if (burning) {
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture(), color: new THREE.Color(3.4, 1.5, 0.4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
        }));
        s.position.set((Math.random() - 0.5) * CANOPY_R * 1.4, CANOPY_Y + Math.random() * 0.1, (Math.random() - 0.5) * CANOPY_R * 1.4);
        s.scale.setScalar(0.3);
        this.chute.add(s);
        sprites.push(s);
      }
    }
    this.freed = { group: this.chute, age: 0, vy: -SINK.from, burning, sprites, mats: this.chuteMats, landed: false, ember: 0 };
  }

  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    if (this.airborne && this.hp - n <= 0) { this.cause = 'air'; this.freeChute(false); }      // killed himself: the canopy is left to drift down
    return super.damage(n, fx, push);
  }

  /** the freed canopy: it crumples and sinks, on fire if it was shot, then burns out and is gone */
  private stepFreed(dt: number, fx: Fx): void {
    const f = this.freed;
    if (!f) return;
    const g = f.group;
    f.age += dt;
    const k = Math.min(1, f.age / 0.6);
    g.scale.set(1 - 0.3 * k, 1 - 0.82 * k, 1 - 0.3 * k);             // it goes limp
    g.rotation.z = Math.sin(f.age * 3 + this.swayPhase) * 0.25;
    if (!f.landed) {
      f.vy = Math.max(-SINK.to, f.vy - SINK.accel * dt);
      g.position.y += f.vy * dt;
      g.position.x -= 0.15 * dt;
      if (g.position.y <= 0.02) { g.position.y = 0.02; f.landed = true; }
    }
    if (f.burning) {
      const heat = Math.min(1, f.age / 1.2);
      for (const m of f.mats) m.color.lerp(CHAR, dt * 3.5);
      f.ember -= dt;
      if (f.ember <= 0) {
        f.ember = 0.06;
        const at = new THREE.Vector3(g.position.x + (Math.random() - 0.5) * 0.2, g.position.y + CANOPY_Y * g.scale.y * 0.9, g.position.z + (Math.random() - 0.5) * 0.2);
        fx.burst(at, 3, 1.4, FIRE, false, 1.2);
        if (Math.random() < 0.6) fx.burst(at, 2, 0.7, SMOKE, false, 1.8);          // smoke
      }
      for (const s of f.sprites) {
        s.scale.setScalar((0.28 + 0.2 * Math.random()) * (0.6 + 0.8 * heat));
        (s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - f.age / BURN_LIFE);
      }
    }
    if (f.age > (f.burning ? BURN_LIFE : 2.5)) {
      g.removeFromParent();
      for (const s of f.sprites) (s.material as THREE.Material).dispose();
      this.freed = null;
    }
  }

  dispose(): void {
    this.chute.removeFromParent();
    for (const s of this.freed?.sprites ?? []) (s.material as THREE.Material).dispose();
    this.freed = null;
  }

  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: ShotFn): void {
    this.stepFreed(dt, fx);
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
      this.vy += (-this.floatSpeed - this.vy) * Math.min(1, dt * (open < 1 ? 7 : 3));
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
      this.body.rotation.z = 0;
      this.resetPose();
      fx.burst(new THREE.Vector3(this.x, 0.05, this.z), 6, 1.2, [0x6b5a45, 0x4a3a28], true, 0.7);
      this.post = null;
      this.holding = false;
    }
  }
}

/**
 * A paratrooper's parachute as a target of its own. It is as big as the canopy, and a hit on it cuts the paratrooper away from it:
 * the canopy burns and he falls. It is never part of the kill count.
 */
export class ParachuteTarget implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = FABRIC_IMPACT;
  counted = true;
  retreating = false;
  gone = false;
  deadTime = 0;
  private readonly at = new THREE.Vector3();

  constructor(private readonly trooper: Paratrooper) {}

  get alive(): boolean { return this.trooper.hasCanopy; }
  get x(): number { return this.trooper.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const c = this.trooper.canopyAt(this.at);
    out.min.set(c.x - CANOPY_R * 1.1, c.y - CANOPY_R * 0.3, c.z - CANOPY_R * 1.1);
    out.max.set(c.x + CANOPY_R * 1.1, c.y + CANOPY_R * 0.62, c.z + CANOPY_R * 1.1);
    return out;
  }

  damage(_n: number, fx: Fx): boolean {
    if (!this.alive) return false;
    this.trooper.cutChute(fx);
    return true;
  }

  update(): void {
    // it goes when the paratrooper does: landed, killed, or cut away from it
    if (!this.trooper.airborne || this.trooper.state === 'dead') this.gone = true;
  }

  dispose(): void {}
}
