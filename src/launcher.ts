import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Explosions } from './explosions';
import type { Dust } from './dust';
import type { Debris, FloorFn } from './debris';
import { MISSILE_LEN, type Missiles } from './missiles';
import { Wreckage } from './wreckage';
import { LAUNCHER } from './config';
import { UNIT as METRE, box } from './cannonParts';
import { sfx } from './sfx';

/** a pale hull and darker tracks, like everything on the enemy side */
const HULL = new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.7, metalness: 0.2 });
const TRACK = new THREE.MeshStandardMaterial({ color: 0xb0b5ba, roughness: 0.6, metalness: 0.4 });
const CLEAT = new THREE.MeshStandardMaterial({ color: 0x8e949a, roughness: 0.7, metalness: 0.3 });
const TUBE = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.5, metalness: 0.3 });
const NOSE = new THREE.MeshStandardMaterial({ color: 0xc8cdd2, roughness: 0.5, metalness: 0.3 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0x4a5a68, roughness: 0.3, metalness: 0.5 });
const CHAR_HULL = new THREE.MeshStandardMaterial({ color: 0x2b2c2e, roughness: 1 });
const CHAR_STEEL = new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.7, metalness: 0.3 });
const WRECK_FIRE = [0xffd080, 0xff7020, 0x553311, 0x333333];
const WRECK_COLORS = [new THREE.Color(0xe8eaec), new THREE.Color(0xcfd4d9), new THREE.Color(0x6b6f73)];

/** a metre of the launcher's model, in the world: the launcher is drawn a fifth bigger than a metre of the cannon or truck */
const UNIT = METRE * LAUNCHER.size;

/** model size, in metres */
const LEN = 4.4;
const TRACK_W = 0.6;
const TRACK_Z = 1.2;
const WHEEL_R = 0.34;
const CLEAT_PITCH = 0.3;
/** the rack hangs on a pivot at the rear of the hull: where it is, how it lies at rest and how far it tips up (rad) */
const RACK_AT = { x: -1.4, y: 1.55 };
const REST = 0.1;
const RAISED = 1.2;
const TUBE_LEN = 3.6;
/** hit box (metres from the hull's middle) */
const BOX = { hx: 2.4, hy: 1.5, hz: 1.4, cy: 1.4 };

export interface LauncherDeps {
  missiles: Missiles;
  explosions: Explosions;
  dust: Dust;
  debris: Debris;
  floor: FloorFn;
}

type Phase = 'wait' | 'raise' | 'fire' | 'hold' | 'lower';
const smooth = (t: number): number => t * t * (3 - 2 * t);
const tmp = new THREE.Vector3();
const dir = new THREE.Vector3();
const quat = new THREE.Quaternion();
/** how long one of its rockets is, in the world: what the model is, at the size they are drawn */
const ROCKET_LEN = MISSILE_LEN * LAUNCHER.rocket.scale;

/**
 * A tracked rocket launcher: a hull on tracks with a rack of rockets on its back. It rolls in from the left, stops a good way from
 * the mech, tips the rack up, fires a salvo (the rockets climb, turn over and come down on where the mech stood), lowers it, reloads,
 * and does it again. Its rockets can be shot down; the launcher itself takes a lot of fire, and blows up with its rockets aboard.
 */
export class LauncherUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  counted = false;
  retreating = false;
  gone = false;
  deadTime = 0;
  private hp: number = LAUNCHER.hp;
  private dead = false;
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly cleats: { m: THREE.Mesh; top: boolean }[] = [];
  private readonly rack = new THREE.Group();
  private readonly noses: THREE.Mesh[] = [];
  private readonly tips: THREE.Object3D[] = [];
  private readonly hullParts: THREE.Mesh[] = [];
  private phase: Phase = 'wait';
  private phaseT = 0;
  private waitT: number = LAUNCHER.firstDelay;
  private fired = 0;
  private gapT = 0;
  private tilt = REST;
  /** how far the tracks have turned (m): the wheels and the cleats follow it */
  private travel = 0;
  private speed = 0;
  private wreck: Wreckage | null = null;
  private burn = 0;
  /** seconds until each of the rockets still aboard goes off */
  private cookOff: number[] = [];

  /** @param stopX where it comes to rest */
  constructor(x: number, z: number, private readonly stopX: number, private readonly deps: LauncherDeps) {
    this.group.position.set(x, 0, z);
    this.body.scale.setScalar(UNIT);
    this.group.add(this.body);
    this.build();
  }

  private build(): void {
    const b = this.body;
    const part = (m: THREE.Mesh): THREE.Mesh => { this.hullParts.push(m); return m; };
    // the hull, with a sloped nose, and a small cab with a window slit
    b.add(part(box(LEN - 0.5, 0.8, 2.3, HULL, -0.1, 1.15, 0)));
    const slope = part(box(0.9, 0.7, 2.3, HULL, LEN / 2 - 0.3, 1.0, 0));
    slope.rotation.z = -0.5;
    b.add(slope);
    b.add(part(box(1.1, 0.65, 1.5, HULL, 1.2, 1.88, 0)), box(0.05, 0.22, 1.2, GLASS, 1.77, 1.95, 0));
    // the tracks: two skirts, road wheels that turn, and cleats that run round the top and the bottom
    for (const side of [-1, 1]) {
      const z = side * TRACK_Z;
      b.add(part(box(LEN, 0.34, TRACK_W, TRACK, 0, 0.88, z)));
      for (let i = 0; i < 7; i++) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, TRACK_W * 0.8, 12).rotateX(Math.PI / 2), TRACK);
        wheel.position.set(-1.8 + i * 0.6, WHEEL_R + 0.04, z);
        wheel.add(box(WHEEL_R * 1.5, 0.05, TRACK_W * 0.85, CLEAT));      // a spoke, so the turning shows
        wheel.castShadow = true;
        this.wheels.push(wheel);
        b.add(wheel);
      }
      const n = Math.round(LEN / CLEAT_PITCH);
      for (let i = 0; i < n; i++) {
        for (const top of [true, false]) {
          const c = box(0.12, 0.06, TRACK_W + 0.04, CLEAT, 0, top ? 1.07 : 0.01, z);
          this.cleats.push({ m: c, top });
          b.add(c);
        }
      }
    }
    // the rack: a frame carrying four tubes (two by two), each with a rocket's nose showing at the mouth
    b.add(this.rack);
    this.rack.position.set(RACK_AT.x, RACK_AT.y, 0);
    this.rack.add(part(box(TUBE_LEN * 0.9, 0.18, 1.5, HULL, TUBE_LEN * 0.45, -0.25, 0)));
    for (const [dy, dz] of [[0, -0.42], [0, 0.42], [0.62, -0.42], [0.62, 0.42]] as const) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, TUBE_LEN, 12).rotateZ(-Math.PI / 2), TUBE);
      tube.position.set(TUBE_LEN / 2, dy, dz);
      tube.castShadow = true;
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.23, 0.55, 12).rotateZ(-Math.PI / 2), NOSE);
      nose.position.set(TUBE_LEN / 2 - 0.15, 0, 0);
      tube.add(nose);
      // the mouth of the tube
      const tip = new THREE.Object3D();
      tip.position.set(TUBE_LEN / 2, 0, 0);
      tube.add(tip);
      this.noses.push(nose);
      this.tips.push(tip);
      this.rack.add(tube);
    }
    this.rack.rotation.z = REST;
  }

  get alive(): boolean { return !this.dead; }
  get x(): number { return this.group.position.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    out.min.set(p.x - BOX.hx * UNIT, (BOX.cy - BOX.hy) * UNIT, p.z - BOX.hz * UNIT);
    out.max.set(p.x + BOX.hx * UNIT, (BOX.cy + BOX.hy) * UNIT, p.z + BOX.hz * UNIT);
    return out;
  }

  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    if (this.dead) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    void push;
    this.destroy(fx);
    return true;
  }

  /** It blows up: a blast, the hull scorched, the rack thrown clear, and whatever rockets were still on it going off. */
  private destroy(fx: Fx): void {
    this.dead = true;
    this.deadTime = 0;
    const { explosions, dust, debris, floor } = this.deps;
    const p = this.group.position;
    const at = tmp.set(p.x, BOX.cy * UNIT * 0.7, p.z);
    explosions.wreckBlast(at, LAUNCHER.wreckBlastRadius, LAUNCHER.wreckBlastScale);
    fx.burst(at, 40, 5, WRECK_FIRE);
    fx.muzzleFlash(at);
    dust.puff(at, 6, 0.6, 1.8);
    for (const m of this.hullParts) m.material = m.material === TRACK ? CHAR_STEEL : CHAR_HULL;
    for (const w of this.wheels) w.material = CHAR_STEEL;
    for (const c of this.cleats) c.m.material = CHAR_STEEL;
    // the rack is thrown clear, rockets and all
    const wreck = (this.wreck = new Wreckage(this.group.parent ?? this.group));
    this.rack.position.y += 0.2;
    wreck.fling(this.rack, new THREE.Vector3((Math.random() - 0.5) * 2, 4.5, (Math.random() - 0.5) * 2), new THREE.Vector3(1, 0.3, 3 * (Math.random() < 0.5 ? -1 : 1)), 0.16, { z: 0.4 });
    // the rockets still aboard cook off: a few more blasts a moment apart, in the air over it
    const loaded = this.noses.filter((n) => n.visible).length;
    for (let i = 0; i < loaded; i++) this.cookOff.push(0.15 + i * 0.22);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, out = 1 + Math.random() * 2.5;
      debris.spawn(at, WRECK_COLORS[i % WRECK_COLORS.length], 0.05 + Math.random() * 0.09, new THREE.Vector3(Math.cos(a) * out, 2 + Math.random() * 3, Math.sin(a) * out * 0.6), floor);
    }
  }

  dispose(): void { this.wreck?.dispose(); }

  update(dt: number, target: THREE.Vector3): void {
    const g = this.group.position;
    if (this.dead) {
      this.deadTime += dt;
      this.burn += dt;
      this.wreck?.update(dt);
      this.wreck?.smoulder(dt, this.burn, tmp.set(g.x, 0.5 * UNIT, g.z), this.deps.dust, 10);
      for (let i = this.cookOff.length - 1; i >= 0; i--) {
        if ((this.cookOff[i] -= dt) > 0) continue;
        this.cookOff.splice(i, 1);
        tmp.set(g.x + (Math.random() - 0.5) * 1.2, 0.8 + Math.random() * 1.2, g.z + (Math.random() - 0.5));
        this.deps.explosions.detonate(tmp, 1.2, 1.5, 1, false);
      }
      return;
    }
    // where it is going: to its stop mark, or, with the scene over, away to the left
    let want = 0;
    if (this.retreating) want = -LAUNCHER.speed * 1.5;
    else if (g.x < this.stopX - 0.05) want = LAUNCHER.speed;
    else if (g.x > this.stopX + 0.05) want = -LAUNCHER.speed;
    this.speed += (want - this.speed) * Math.min(1, dt * 3);
    if (Math.abs(this.speed) > 0.01) g.x += this.speed * dt;
    this.travel += this.speed * dt;
    sfx.hold(this, 'launcherTracks', { x: g.x, gain: 0.35 + 0.65 * Math.min(1, Math.abs(this.speed) / LAUNCHER.speed), rate: 0.8 + 0.3 * Math.min(1, Math.abs(this.speed) / LAUNCHER.speed) }, 0.15);
    this.animateTracks();

    if (this.retreating) { this.tilt += (REST - this.tilt) * Math.min(1, dt * 5); this.rack.rotation.z = this.tilt; return; }
    // it only works the rack once it has stopped
    if (Math.abs(g.x - this.stopX) > 0.4) return;
    this.work(dt, target);
  }

  /** the wheels turn and the cleats run round: along the top with the hull's motion, back along the bottom */
  private animateTracks(): void {
    for (const w of this.wheels) w.rotation.z = -this.travel / (WHEEL_R * UNIT);
    const span = LEN;
    const shift = (this.travel / UNIT) % CLEAT_PITCH;
    const n = this.cleats.length / 4;
    let i = 0;
    for (const c of this.cleats) {
      const k = Math.floor(i / 2) % n;
      const base = (k * CLEAT_PITCH + (c.top ? shift : -shift)) % span;
      c.m.position.x = ((base + span) % span) - span / 2;
      i++;
    }
  }

  /** the firing cycle: wait (reloading), tip the rack up, fire the salvo a rocket at a time, hold, tip it down */
  private work(dt: number, target: THREE.Vector3): void {
    this.phaseT += dt;
    switch (this.phase) {
      case 'wait':
        this.waitT -= dt;
        if (this.waitT <= 0) { this.phase = 'raise'; this.phaseT = 0; sfx.rack(this.x); }
        break;
      case 'raise': {
        this.tilt = REST + (RAISED - REST) * smooth(Math.min(1, this.phaseT / LAUNCHER.raiseTime));
        if (this.phaseT >= LAUNCHER.raiseTime) { this.phase = 'fire'; this.phaseT = 0; this.fired = 0; this.gapT = 0.15; }
        break;
      }
      case 'fire':
        this.gapT -= dt;
        if (this.gapT <= 0 && this.fired < LAUNCHER.salvo) { this.launch(target); this.fired++; this.gapT = LAUNCHER.gap; }
        if (this.fired >= LAUNCHER.salvo && this.gapT <= 0) { this.phase = 'hold'; this.phaseT = 0; }
        break;
      case 'hold':
        if (this.phaseT >= LAUNCHER.hold) { this.phase = 'lower'; this.phaseT = 0; sfx.rack(this.x); }
        break;
      case 'lower':
        this.tilt = RAISED + (REST - RAISED) * smooth(Math.min(1, this.phaseT / LAUNCHER.raiseTime));
        if (this.phaseT >= LAUNCHER.raiseTime) {
          this.phase = 'wait';
          this.phaseT = 0;
          this.waitT = LAUNCHER.reload[0] + Math.random() * (LAUNCHER.reload[1] - LAUNCHER.reload[0]);
          for (const n of this.noses) n.visible = true;       // loaded again
        }
        break;
    }
    this.rack.rotation.z = this.tilt;
  }

  /** one rocket off the next loaded tube */
  private launch(target: THREE.Vector3): void {
    void target;
    const i = this.noses.findIndex((n) => n.visible);
    if (i < 0) return;
    this.noses[i].visible = false;
    this.group.updateMatrixWorld(true);
    // it leaves along the tube: pointing the way the tube points, with most of its length still inside it
    this.rack.getWorldQuaternion(quat);
    const along = dir.set(1, 0, 0).applyQuaternion(quat);
    this.tips[i].getWorldPosition(tmp);
    tmp.addScaledVector(along, -ROCKET_LEN * 0.35);
    this.deps.missiles.launch(tmp, this, LAUNCHER.rocket, along);
  }
}
