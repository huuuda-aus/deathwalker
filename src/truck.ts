import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, Soldier, type Enemy, type SoldierEnv } from './enemies';
import type { Explosions } from './explosions';
import type { Dust } from './dust';
import type { Debris, FloorFn } from './debris';
import { TRUCK } from './config';
import { UNIT, box } from './cannonParts';
import { Wreckage } from './wreckage';

/** a wrecked truck's four big sections: where each one's centre lies along the truck (metres) and how big a ball stands in for it */
const SECTIONS = {
  cab: { x: 1.9, size: 0.6 },
  bedFront: { x: -0.065, size: 0.56 },
  bedMid: { x: -1.8, size: 0.56 },
  bedRear: { x: -3.535, size: 0.56 },
};

const std = (color: number, roughness = 0.85, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, ...extra });
// like every enemy, it is white (light greys where a part needs to read as a different part)
const OLIVE = std(0xf4f6f8);
const TARP = std(0xe8eaec, 0.95);
const FRAME = std(0xd6dade, 0.7);
const GLASS = std(0x8e9aa5, 0.2, { metalness: 0.3 });
const CANVAS_WINDOW = std(0xaab4bd, 0.6);
const TYRE = std(0xb4bac0, 1);
const LIGHT = std(0xfff4c4, 0.4, { emissive: 0xfff4c4, emissiveIntensity: 0.8 });
/** scorched replacements swapped in when it is destroyed */
const CHAR = new Map<THREE.Material, THREE.Material>([
  [OLIVE, std(0x1f2120, 0.9)], [TARP, std(0x1a1b19, 1)], [FRAME, std(0x151616, 0.8)],
  [GLASS, std(0x101414, 0.8)], [CANVAS_WINDOW, std(0x1a1b19, 1)], [LIGHT, std(0x151616, 0.8)],
  [TYRE, std(0x141414, 1)],
]);

/** where the cab sits along the truck (metres) */
const FRAME_CAB_X = 1.9;
const scratch = new THREE.Vector3();
const WHEEL_R = 0.55;
const FRONT_AXLE = 1.9;
/** the bed rides on a pair of rear axles */
const REAR_AXLES = [-1.4, -3.0];
/** back end of the bed, where the troops jump out (metres) */
const TAILGATE_X = -4.4;
/** top of the cargo bed, where troops stand (metres) */
const BED_Y = 1.4;
/** hit box in metres around the truck's middle, facing +x */
const BOX = { cx: -0.78, hx: 3.85, hy: 1.6, hz: 1.1 };
const TURN_STEPS = 60;
const smooth = (t: number): number => t * t * (3 - 2 * t);

interface PathPoint { x: number; z: number; yaw: number; speed: number }

/** The swing from the approach heading to the final heading: where it goes, and how fast, as a function of progress. */
function turnPath(yaw0: number, yaw1: number): PathPoint[] {
  const dt = TRUCK.turnTime / TURN_STEPS;
  const pts: PathPoint[] = [{ x: 0, z: 0, yaw: yaw0, speed: TRUCK.speed }];
  let x = 0, z = 0;
  for (let i = 1; i <= TURN_STEPS; i++) {
    const k = i / TURN_STEPS;
    const speed = TRUCK.speed * (1 - k * k);                // it brakes to a stop as it comes round
    const yaw = yaw0 + (yaw1 - yaw0) * smooth(k);
    x += Math.cos(yaw) * speed * dt;
    z -= Math.sin(yaw) * speed * dt;
    pts.push({ x, z, yaw, speed });
  }
  return pts;
}

/** headings: model faces +x, so yaw 0 drives right and PI drives left; -PI/2 faces the camera (+z) */
const yawFrom = (fromRight: boolean): number => (fromRight ? Math.PI : 0);
const yawFacingCamera = (fromRight: boolean, jitter: number): number => (fromRight ? 1.5 * Math.PI : -0.5 * Math.PI) + jitter;

const nominalShift = new Map<boolean, { dx: number; dz: number }>();

type State = 'drive' | 'turn' | 'unload' | 'idle' | 'dead';

export interface TruckSpec {
  fromRight: boolean;
  /** x it starts from, well off screen */
  edgeX: number;
  /** lane (z) it drives in along, and the x where it begins its turn */
  zDrive: number;
  turnStartX: number;
  /** soldiers aboard */
  troops: number;
}

export interface TruckDeps {
  env: SoldierEnv;
  /** put a new enemy into the game */
  add: (e: Enemy) => void;
  explosions: Explosions;
  dust: Dust;
  /** the wreck's big sections become rigid bodies in here, to be shoved about and used as cover */
  debris: Debris;
  floor: FloorFn;
}

/**
 * A personnel carrier. It drives in from either side, swings through about 90 degrees to face the camera
 * and brakes to a stop, then unloads its troops over the sides, either as a stream or in groups of three or
 * four. Shot, it throws sparks; destroyed, it blows apart into flung parts, fire and smoke, and any troops
 * still aboard are thrown out of the wreck (some do not survive it).
 */
export class TruckUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  counted = false;
  retreating = false;
  gone = false;
  deadTime = 0;
  private hp: number = TRUCK.hp;
  private state: State = 'drive';
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  private readonly roof = new THREE.Group();
  private readonly sections = { cab: new THREE.Group(), bedFront: new THREE.Group(), bedMid: new THREE.Group(), bedRear: new THREE.Group() };
  private readonly doors: THREE.Group[] = [];
  private readonly bumper: THREE.Mesh;
  private readonly yaw0: number;
  private readonly path: PathPoint[];
  private readonly dirX: number;
  private t = 0;
  private clock = 0;
  /** times (since unloading began) at which each soldier gets out */
  private schedule: number[] = [];
  private unloaded = 0;
  private wreck: Wreckage | null = null;

  /** How far a truck coming from this side travels while turning, with the nominal final heading. */
  static turnShift(fromRight: boolean): { dx: number; dz: number } {
    let s = nominalShift.get(fromRight);
    if (!s) {
      const end = turnPath(yawFrom(fromRight), yawFacingCamera(fromRight, 0)).at(-1)!;
      s = { dx: end.x, dz: end.z };
      nominalShift.set(fromRight, s);
    }
    return s;
  }

  constructor(private readonly spec: TruckSpec, private readonly deps: TruckDeps) {
    this.yaw0 = yawFrom(spec.fromRight);
    this.dirX = spec.fromRight ? -1 : 1;
    const jitter = THREE.MathUtils.degToRad((Math.random() * 2 - 1) * TRUCK.facingJitterDeg);
    this.path = turnPath(this.yaw0, yawFacingCamera(spec.fromRight, jitter));
    this.group.position.set(spec.edgeX, 0, spec.zDrive);
    this.group.rotation.y = this.yaw0;
    this.bumper = this.build();
    this.body.scale.setScalar(UNIT);
    this.group.add(this.body);
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get x(): number { return this.group.position.x; }
  /** still driving in or unloading: a second truck waits for this one */
  get busy(): boolean { return this.state === 'drive' || this.state === 'turn' || this.state === 'unload'; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    const yaw = this.group.rotation.y;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // the box rotated about y, then its axis-aligned bounds
    const hx = Math.abs(c) * BOX.hx + Math.abs(s) * BOX.hz;
    const hz = Math.abs(s) * BOX.hx + Math.abs(c) * BOX.hz;
    const cx = p.x + (c * BOX.cx) * UNIT;
    const cz = p.z - (s * BOX.cx) * UNIT;
    out.min.set(cx - hx * UNIT, 0, cz - hz * UNIT);
    out.max.set(cx + hx * UNIT, 2 * BOX.hy * UNIT, cz + hz * UNIT);
    return out;
  }

  damage(n: number, fx: Fx): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.destroy(fx);
    return true;
  }

  /** the wreck's flung parts and rigid sections stay where they fell */
  dispose(): void {}

  update(dt: number): void {
    const g = this.group.position;
    switch (this.state) {
      case 'drive':
        g.x += this.dirX * TRUCK.speed * dt;
        this.roll(TRUCK.speed, dt);
        if (this.dirX * (g.x - this.spec.turnStartX) >= 0) { this.state = 'turn'; this.t = 0; }
        break;
      case 'turn': {
        this.t += dt;
        const k = Math.min(1, this.t / TRUCK.turnTime);
        const f = k * TURN_STEPS, i = Math.min(TURN_STEPS - 1, Math.floor(f));
        const a = this.path[i], b = this.path[i + 1], u = f - i;
        g.x = this.spec.turnStartX + a.x + (b.x - a.x) * u;
        g.z = this.spec.zDrive + a.z + (b.z - a.z) * u;
        this.group.rotation.y = a.yaw + (b.yaw - a.yaw) * u;
        this.roll(a.speed + (b.speed - a.speed) * u, dt);
        if (k >= 1) { this.state = 'unload'; this.clock = 0; this.planUnloading(); }
        break;
      }
      case 'unload':
        this.clock += dt;
        while (this.unloaded < this.schedule.length && this.schedule[this.unloaded] <= this.clock) {
          this.unloadOne();
          this.unloaded++;
        }
        if (this.unloaded >= this.spec.troops) this.state = 'idle';
        break;
      case 'dead':
        this.deadTime += dt;
        this.wreck?.update(dt);
        this.wreck?.smoulder(dt, this.deadTime, scratch.set(g.x, BED_Y * UNIT, g.z), this.deps.dust);
        break;
      case 'idle':
        break;
    }
  }

  /** As a stream (one every fraction of a second) or in groups of three or four, a pause apart. */
  private planUnloading(): void {
    const n = this.spec.troops;
    const times: number[] = [];
    if (Math.random() < 0.5) {
      for (let i = 0; i < n; i++) times.push(i * TRUCK.streamInterval * (0.8 + 0.4 * Math.random()));
    } else {
      let left = n, at = 0;
      while (left > 0) {
        const size = Math.min(left, TRUCK.groupMin + Math.floor(Math.random() * (TRUCK.groupMax - TRUCK.groupMin + 1)));
        for (let j = 0; j < size; j++) times.push(at + j * 0.12);
        left -= size;
        at += TRUCK.groupGap;
      }
    }
    this.schedule = times;
  }

  /** a soldier jumps down off the tailgate and lands running */
  private unloadOne(): void {
    const s = this.makeSoldier(true);
    s.plan = Math.random() < TRUCK.coverChance ? 'cover' : 'scatter';
    this.deps.add(s);
    s.launch(this.leapVelocity(true, 1.0 + Math.random() * 1.2));
  }

  /**
   * A new soldier standing on the bed: at the tailgate when unloading, or anywhere along the bed when thrown out of
   * a wreck.
   */
  private makeSoldier(atTailgate: boolean): Soldier {
    const s = new Soldier(0, 0, this.deps.env);
    this.group.updateMatrixWorld(true);
    const lx = atTailgate ? TAILGATE_X + 0.1 : -4 + Math.random() * 4.5;
    this.body.localToWorld(s.group.position.set(lx, BED_Y, (Math.random() - 0.5) * (atTailgate ? 1.5 : 2.2)));
    return s;
  }

  /** out of the back (-x, the way the truck faces away from) with a little sideways drift, or in any direction from a wreck, plus a hop */
  private leapVelocity(rear: boolean, speed: number): THREE.Vector3 {
    const origin = this.body.localToWorld(scratch.set(0, 0, 0)).clone();
    const dir = rear
      ? scratch.set(-1, 0, (Math.random() - 0.5) * 0.9)
      : scratch.set(-0.5 + Math.random() * 0.2, 0, Math.random() * 2 - 1);
    const v = this.body.localToWorld(dir).sub(origin);
    v.y = 0;
    v.normalize().multiplyScalar(speed);
    v.y = 1.2 + Math.random();
    return v;
  }

  private roll(speed: number, dt: number): void {
    for (const w of this.wheels) w.rotation.z -= (speed * dt) / (WHEEL_R * UNIT);
  }

  private destroy(fx: Fx): void {
    this.state = 'dead';
    this.deadTime = 0;
    const p = this.group.position;
    const at = scratch.set(p.x, 1.2 * UNIT, p.z);
    this.deps.explosions.detonate(at, TRUCK.blastRadius, TRUCK.blastScale);
    fx.burst(at, 20, 4, [0x8a1010, 0xffa040]);
    this.breakApart();
    // whoever was still aboard is thrown out of the wreck: about half do not survive it
    for (let i = this.unloaded; i < this.spec.troops; i++) {
      const s = this.makeSoldier(false);
      s.plan = Math.random() < TRUCK.coverChance ? 'cover' : 'scatter';
      this.deps.add(s);
      s.launch(this.leapVelocity(false, 2 + Math.random() * 2));
      if (Math.random() < 0.5) s.damage(99, fx);
    }
    this.unloaded = this.spec.troops;
  }

  /** scorched, with the wheels, roof canvas, doors and bumper blown off and the hulk sagging */
  private breakApart(): void {
    const { body } = this;
    body.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const charred = CHAR.get(o.material);
      if (charred) o.material = charred;
    });
    const wreck = (this.wreck = new Wreckage(this.group.parent ?? this.group));
    const r = (a: number, b: number): number => a + Math.random() * (b - a);
    for (const w of this.wheels) {
      wreck.fling(w, new THREE.Vector3(r(-2, 2), r(2.5, 4), r(-1.5, 2)), new THREE.Vector3(r(-3, 3), 0, r(-6, 6)), 0.225 * UNIT, { x: Math.PI / 2 });
    }
    wreck.fling(this.roof, new THREE.Vector3(r(-1.2, 1.2), r(4, 5.5), r(0, 1.5)), new THREE.Vector3(r(-2, 2), r(-1, 1), r(-2, 2)), 0.6 * UNIT, { x: 0, z: 0 });
    for (const d of this.doors) {
      wreck.fling(d, new THREE.Vector3(r(-2.5, 2.5), r(3, 4.5), r(-1, 2.5)), new THREE.Vector3(r(-5, 5), r(-3, 3), r(-5, 5)), 0.03 * UNIT, { x: Math.PI / 2, y: 0, z: 0 });
    }
    wreck.fling(this.bumper, new THREE.Vector3(r(-2, 2), r(2.5, 3.5), r(0.5, 2)), new THREE.Vector3(r(-4, 4), r(-2, 2), r(-4, 4)), 0.15 * UNIT, { x: 0, z: 0 });
    this.hulkToRubble();
  }

  /**
   * What is left becomes three rigid sections (cab and two halves of the bed): the same physics as rubble, so the
   * mech shoves them and slows down wading through them, soldiers take cover behind them and bullets stop on them.
   */
  private hulkToRubble(): void {
    const { debris, floor } = this.deps;
    const world = this.group.parent ?? this.group;
    this.group.updateMatrixWorld(true);
    for (const [name, section] of Object.entries(this.sections) as [keyof typeof SECTIONS, THREE.Group][]) {
      const { x, size } = SECTIONS[name];
      const centre = this.body.localToWorld(new THREE.Vector3(x, 0, 0));
      const pivot = new THREE.Group();
      pivot.position.set(centre.x, size / 2, centre.z);
      world.add(pivot);
      pivot.attach(section);                     // keeps where it is: the model now hangs from the ball's centre
      debris.spawnBody(pivot, size, new THREE.Vector3((Math.random() - 0.5) * 1.2, 1 + Math.random(), (Math.random() - 0.3) * 0.8), floor);
    }
  }

  /** build the model (metres, facing +x, origin on the ground under the middle); returns the bumper */
  private build(): THREE.Mesh {
    const { body } = this;
    const { cab, bedFront, bedMid, bedRear } = this.sections;
    body.add(cab, bedFront, bedMid, bedRear);
    // chassis and a long cargo bed, in sections that come apart when it is destroyed
    cab.add(box(2.15, 0.35, 1.5, FRAME, 1.675, 0.85, 0));
    bedFront.add(box(1.53, 0.35, 1.5, FRAME, -0.165, 0.85, 0), box(1.73, 0.2, 2.1, FRAME, -0.065, 1.2, 0), box(0.08, 0.5, 2.0, OLIVE, 0.8, 1.6, 0));
    bedMid.add(box(1.73, 0.35, 1.5, FRAME, -1.8, 0.85, 0), box(1.73, 0.2, 2.1, FRAME, -1.8, 1.2, 0));
    bedRear.add(box(1.73, 0.35, 1.5, FRAME, -3.535, 0.85, 0), box(1.73, 0.2, 2.1, FRAME, -3.535, 1.2, 0), box(0.08, 0.5, 2.0, OLIVE, TAILGATE_X, 1.6, 0));
    for (const z of [-1.02, 1.02]) {
      bedFront.add(box(1.73, 0.5, 0.08, OLIVE, -0.065, 1.6, z));
      bedMid.add(box(1.73, 0.5, 0.08, OLIVE, -1.8, 1.6, z));
      bedRear.add(box(1.73, 0.5, 0.08, OLIVE, -3.535, 1.6, z));
    }
    // cab
    cab.add(box(1.7, 1.55, 2.1, OLIVE, FRAME_CAB_X, 1.95, 0));
    cab.add(box(1.85, 0.1, 2.2, OLIVE, FRAME_CAB_X, 2.78, 0));
    cab.add(box(0.06, 0.7, 1.7, GLASS, FRAME_CAB_X + 0.86, 2.3, 0));
    cab.add(box(0.05, 0.55, 1.3, FRAME, FRAME_CAB_X + 0.86, 1.5, 0));
    for (const z of [-0.75, 0.75]) cab.add(box(0.08, 0.2, 0.3, LIGHT, FRAME_CAB_X + 0.86, 1.5, z));
    for (const z of [-1.06, 1.06]) {
      const door = new THREE.Group();
      door.add(box(0.95, 1.2, 0.06, OLIVE, 0, 0, 0), box(0.8, 0.5, 0.07, GLASS, 0, 0.3, 0));
      door.position.set(FRAME_CAB_X - 0.1, 2.0, z);
      body.add(door);
      this.doors.push(door);
    }
    const bumper = box(0.3, 0.3, 2.2, FRAME, FRAME_CAB_X + 1.0, 1.0, 0);
    body.add(bumper);
    // fenders over the front wheels
    for (const z of [-1.0, 1.0]) cab.add(box(1.3, 0.1, 0.55, OLIVE, FRONT_AXLE, 1.2, z));
    // canvas tilt over the whole bed, open at the back, with two windows each side
    const roofLen = 0.8 - TAILGATE_X;
    this.roof.position.set((0.8 + TAILGATE_X) / 2, 0, 0);
    this.roof.add(box(roofLen, 1.25, 2.0, TARP, 0, 2.4, 0), box(roofLen, 0.15, 1.7, TARP, 0, 3.05, 0));
    for (const z of [-1.01, 1.01]) for (const x of [-1.3, 0.8]) this.roof.add(box(0.9, 0.5, 0.03, CANVAS_WINDOW, x, 2.7, z));
    body.add(this.roof);
    // six big tyres: one axle in front, a pair behind
    for (const x of [FRONT_AXLE, ...REAR_AXLES]) {
      for (const z of [-1.0, 1.0]) {
        const wheel = new THREE.Group();
        const tyre = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.45, 18).rotateX(Math.PI / 2), TYRE);
        tyre.castShadow = true;
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.48, 12).rotateX(Math.PI / 2), OLIVE);
        wheel.add(tyre, hub, box(0.1, 0.5, 0.5, FRAME, 0, 0.15, 0));
        wheel.position.set(x, WHEEL_R, z);
        body.add(wheel);
        this.wheels.push(wheel);
      }
    }
    return bumper;
  }
}

