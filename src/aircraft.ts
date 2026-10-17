import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Explosions } from './explosions';
import type { Dust } from './dust';
import type { Debris, FloorFn } from './debris';
import { Bomb, type BombDeps } from './bomb';
import { AIRCRAFT, BOMB, WEAPON } from './config';
import { LANE } from './mech';
import { UNIT, box } from './cannonParts';
import { Wreckage } from './wreckage';
import { Blaze } from './blaze';

const std = (color: number, roughness = 0.6, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, ...extra });
// like every enemy, it is white (light greys where a part needs to read as a different part)
const SKIN = std(0xf4f6f8, 0.5, { metalness: 0.15 });
const PANEL = std(0xe0e4e8, 0.55);
const CANOPY = std(0x8e9aa5, 0.2, { metalness: 0.3 });
const DARK = std(0x8a939b, 0.5, { metalness: 0.4 });
const CHAR_SKIN = std(0x1f2120, 0.9);

/** hit box in metres around the middle of the plane, facing +x */
const BOX = { hx: 7.25, hy: 1.5, hz: 1.75 };
/** the two big pieces of a wrecked plane: where each one's centre lies along it (metres) and how big a ball stands in for it */
const PIECES = { front: { x: 0.9, size: 0.69 }, rear: { x: -3.7, size: 0.56 } };
/** the body is built in Spitfire metres (9.1 m long); this scales it to the plane's size, 1.5 truck lengths */
const SCALE = 1.26 * 1.25;

const scratch = new THREE.Vector3();
const cyl = (r0: number, r1: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 14).rotateZ(-Math.PI / 2), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

export interface AircraftSpec {
  /** x it starts from, off screen */
  startX: number;
  /** cruising height and depth */
  y: number;
  z: number;
}

export interface AircraftDeps {
  add: (e: Enemy) => void;
  explosions: Explosions;
  dust: Dust;
  debris: Debris;
  floor: FloorFn;
  bombs: BombDeps;
  /** where the screen is: camera x and half its width at the plane's depth */
  view: () => { x: number; half: number };
}

type State = 'fly' | 'fall' | 'slide' | 'wreck';
/** on the ground it slides on, its speed dying away at this rate (1/s), until it is slower than this (units/s) or has slid this long (s) */
const SLIDE_DRAG = 1.6;
const SLIDE_STOP = 0.25;
const SLIDE_MAX = 2.2;
/** a plane that has lost its power falls under this gravity, losing forward speed at this rate (1/s), its nose never dropping past this angle (rad) */
const FALL_GRAVITY = 6;
const FALL_DRAG = 0.12;
const NOSE_DOWN_MAX = 1.2;

/**
 * A WW2-style bomber, white like everything on the enemy side, about one and a half truck lengths long. It
 * patrols the top of the screen at its own height, turning round off screen, and drops bombs ahead of the mech.
 * Shot down, it blows up in the air, loses its power and falls with its momentum, nose dropping, trailing fire; when
 * it hits the ground it explodes again, twice as big, and breaks up: wings, propeller and wheels are flung off and
 * the two halves of the fuselage stay as burning wrecks.
 */
export class AircraftUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  counted = false;
  retreating = false;
  gone = false;
  /** seconds since it crashed. The manager clears a wreck 8 s after `deadTime` starts counting, so it counts so that this lands when the fire has died down. */
  private burnT = 0;
  get deadTime(): number { return this.burnT * (8 / AIRCRAFT.flameTime); }
  private fallT = 0;
  private slideT = 0;
  private hp: number = AIRCRAFT.hp;
  private state: State = 'fly';
  private readonly dir = 1;
  private readonly body = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly wing = new THREE.Group();
  /** the underwing radiators: flung off in the crash */
  private readonly gear: THREE.Object3D[] = [];
  private readonly pieces = { front: new THREE.Group(), rear: new THREE.Group() };
  private readonly baseY: number;
  private clock = Math.random() * 10;
  private dropT = 1.5;
  private readonly vel = new THREE.Vector3();
  private wreck: Wreckage | null = null;
  private flaming: THREE.Object3D[] = [];
  /** the fires: on the engine while it falls, then on and around the wreck */
  private blazes: { blaze: Blaze; follow: THREE.Object3D | null; dx: number; dz: number }[] = [];
  private engineBlaze: Blaze | null = null;
  private fx: Fx | null = null;

  constructor(spec: AircraftSpec, private readonly deps: AircraftDeps) {
    this.baseY = spec.y;
    this.group.position.set(spec.startX, spec.y, spec.z);
    this.build();
    this.body.scale.setScalar(UNIT * SCALE);
    this.group.add(this.body);
  }

  get alive(): boolean { return this.state === 'fly'; }
  get x(): number { return this.group.position.x; }

  /**
   * Model, facing +x, in Spitfire metres (9.1 m long, 11.2 m span; the body is scaled up to the plane's size): the long
   * tapering nose with its exhaust stacks, a bubble canopy, an elliptical wing with cannon barrels and underwing
   * radiators, a tall rounded fin, an elliptical tailplane and a three-blade propeller on a pointed spinner.
   */
  private build(): void {
    const { front, rear } = this.pieces;
    // fuselage: nose, cockpit section, and a long taper to the tail
    front.add(
      cyl(0.34, 0.53, 3.2, SKIN, -1.2, 0, 0),
      cyl(0.52, 0.4, 3.3, PANEL, 1.85, 0, 0),
    );
    // bubble canopy and the hump behind it
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), CANOPY);
    canopy.scale.set(1.6, 0.85, 0.7);
    canopy.position.set(-0.55, 0.52, 0);
    const hump = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), SKIN);
    hump.scale.set(2.4, 0.55, 0.8);
    hump.position.set(-1.7, 0.32, 0);
    front.add(canopy, hump);
    // exhaust stacks along each side of the nose
    for (const z of [-0.41, 0.41]) {
      for (const x of [2.1, 2.45, 2.8]) front.add(box(0.2, 0.09, 0.06, DARK, x, 0.1, z * 0.96));
    }
    rear.add(
      cyl(0.1, 0.34, 2.5, SKIN, -3.9, 0.02, 0),                            // the tail taper
      this.fin(),
      this.ellipse(0.5, 1.7, -4.8, 0.18, 0.06, SKIN),                      // elliptical tailplane
    );
    this.body.add(front, rear);
    // wing: an ellipse, low on the fuselage, spanning toward the camera, with radiators underneath and cannon barrels
    this.wing.add(this.ellipse(1.25, 5.6, 0.35, -0.3, 0.16, SKIN));
    for (const z of [-1.1, 1.1, -1.55, 1.55]) this.wing.add(cyl(0.03, 0.03, 0.7, DARK, 1.65, -0.3, z));
    this.body.add(this.wing);
    for (const z of [-1.95, 1.95]) {
      const rad = box(0.75, 0.24, 0.42, PANEL, 0.7, -0.55, z);
      this.gear.push(rad);
      this.body.add(rad);
    }
    // propeller: a pointed spinner and three blades
    this.prop.position.set(3.5, 0, 0);
    this.prop.add(cyl(0.4, 0.02, 0.7, PANEL, 0.3, 0, 0));
    for (let i = 0; i < 3; i++) {
      const blade = box(0.05, 1.0, 0.2, PANEL, 0, 0.55, 0);
      const arm = new THREE.Group();
      arm.rotation.x = (i * 2 * Math.PI) / 3;
      arm.add(blade);
      this.prop.add(arm);
    }
    this.body.add(this.prop);
  }

  /** a flat elliptical plate seen from above: chord radius `rx` along the aeroplane, span radius `rz` across it */
  private ellipse(rx: number, rz: number, x: number, y: number, thick: number, mat: THREE.Material): THREE.Mesh {
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 28 });
    geo.translate(0, 0, -thick / 2).rotateX(-Math.PI / 2);        // plan view -> lying flat: shape y becomes depth (z)
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, 0);
    m.castShadow = true;
    return m;
  }

  /** the tall, rounded fin and rudder */
  private fin(): THREE.Mesh {
    const shape = new THREE.Shape();
    shape.moveTo(-3.6, 0.15);
    shape.lineTo(-4.5, 1.4);
    shape.quadraticCurveTo(-4.8, 1.8, -5.2, 1.55);
    shape.lineTo(-5.35, 0.5);
    shape.lineTo(-5.0, 0.12);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    geo.translate(0, 0, -0.04);
    const m = new THREE.Mesh(geo, SKIN);
    m.castShadow = true;
    return m;
  }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    out.min.set(p.x - BOX.hx * UNIT, p.y - BOX.hy * UNIT, p.z - BOX.hz * UNIT);
    out.max.set(p.x + BOX.hx * UNIT, p.y + BOX.hy * UNIT, p.z + BOX.hz * UNIT);
    return out;
  }

  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    if (push) this.vel.x += push.x * WEAPON.pushShare.vehicle;
    this.destroy(fx);
    return true;
  }

  dispose(): void {
    this.engineBlaze?.dispose();
    for (const { blaze } of this.blazes) blaze.dispose();
  }

  update(dt: number, target: THREE.Vector3): void {
    if (this.state === 'fall') { this.fall(dt); return; }
    if (this.state === 'slide') { this.slide(dt); return; }
    if (this.state === 'wreck') {
      this.burnT += dt;
      this.wreck?.update(dt);
      this.burnWreck(dt);
      return;
    }
    const g = this.group;
    this.clock += dt;
    g.position.x += this.dir * AIRCRAFT.speed * dt;
    // a gentle bob and bank, and the propeller a blur
    g.position.y = this.baseY + Math.sin(this.clock * 0.9) * 0.08;
    g.rotation.z = Math.sin(this.clock * 0.7) * 0.03;
    this.prop.rotation.x += dt * 40;
    this.vel.set(this.dir * AIRCRAFT.speed, 0, 0);

    const view = this.deps.view();
    const out = this.dir * (g.position.x - view.x);
    if (this.retreating) {
      if (out > view.half + AIRCRAFT.turnMargin) this.gone = true;     // flies off the way it was going
      return;
    }
    if (out > view.half + AIRCRAFT.turnMargin) g.position.x = view.x - view.half - AIRCRAFT.turnMargin;   // gone off the right: back in from the left
    this.bombRun(dt, target, view);
  }

  /** While over the screen it drops a bomb every second: the plane's speed carries it on, and it comes down at the mech's depth. */
  private bombRun(dt: number, target: THREE.Vector3, view: { x: number; half: number }): void {
    this.dropT -= dt;
    const g = this.group.position;
    if (this.dropT > 0 || Math.abs(g.x - view.x) > view.half) return;
    this.dropT = AIRCRAFT.dropInterval;
    const fall = Math.sqrt((2 * Math.max(0.5, g.y - 0.4)) / BOMB.gravity);
    const aimZ = THREE.MathUtils.clamp(target.z + (Math.random() - 0.5) * 2 * AIRCRAFT.aimSpread, LANE.zMin, LANE.zMax);
    const from = scratch.set(g.x, g.y - 0.5 * UNIT, g.z);
    this.deps.add(new Bomb(from, new THREE.Vector3(this.dir * AIRCRAFT.speed, 0, (aimZ - g.z) / fall), this.deps.bombs));
  }

  /** Shot down: a fiery explosion, and it loses its power. It keeps its momentum and drops toward the ground. */
  private destroy(fx: Fx): void {
    this.fx = fx;
    this.state = 'fall';
    this.fallT = 0;
    this.group.rotation.z = 0;                              // wings level for the dive
    this.engineBlaze = new Blaze(this.group.parent ?? this.group, 1.3, 6);
    this.deps.explosions.wreckBlast(this.group.position.clone(), AIRCRAFT.wreckBlastRadius, AIRCRAFT.wreckBlastScale);
    // scorched
    this.body.traverse((o) => { if (o instanceof THREE.Mesh && (o.material === SKIN || o.material === PANEL)) o.material = CHAR_SKIN; });
  }

  /** Falling dead: the nose dips, it rolls a little, trails fire, and crashes when it meets the ground (or a roof). */
  private fall(dt: number): void {
    const g = this.group;
    this.fallT += dt;
    this.vel.y -= FALL_GRAVITY * dt;
    this.vel.x *= Math.exp(-FALL_DRAG * dt);               // a little air resistance bleeds off the forward speed
    g.position.addScaledVector(this.vel, dt);
    // it points along its path: level at first, the nose dropping as the fall steepens (a bird shot in flight)
    this.body.rotation.z = -Math.min(NOSE_DOWN_MAX, Math.atan2(-this.vel.y, Math.abs(this.vel.x) + 0.01));
    this.prop.rotation.x += dt * 6;                          // the propeller windmills to a stop
    this.burnEngine(dt);
    if (g.position.y <= Math.max(0, this.deps.floor(g.position.x, g.position.z, g.position.y)) + 0.45 * UNIT) this.crash();
  }

  /** Hits the ground: a second explosion twice as big, which throws off the wing, propeller and radiators. The rest slides on. */
  private crash(): void {
    this.state = 'slide';
    this.slideT = 0;
    const { explosions, bombs } = this.deps;
    const g = this.group;
    const at = scratch.set(g.position.x, Math.max(0.3, g.position.y), g.position.z);
    const R = AIRCRAFT.crashBlastRadius;
    explosions.wreckBlast(at, R, AIRCRAFT.crashBlastScale, AIRCRAFT.crashShock);
    bombs.world.forEachBuilding(at.x - R, at.x + R, (b) => b.damage(at.x, at.y, at.z, R));
    for (const c of bombs.colliders) {
      if (at.distanceTo(c.pos) < R + c.r) { bombs.onPlayerHit(BOMB.damage); break; }
    }
    const world = g.parent ?? g;
    const wreck = (this.wreck = new Wreckage(world));
    const r = (a: number, b: number): number => a + Math.random() * (b - a);
    // the wreck keeps the speed of the fall: pieces skid and roll on in the direction it was flying
    const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x + this.vel.x * 0.9, y, z + this.vel.z * 0.9);
    wreck.fling(this.wing, v(r(-1, 1), r(3, 5), r(-1, 1)), new THREE.Vector3(r(-2, 2), r(-1, 1), r(-4, 4)), 0.08 * UNIT, { x: 0, z: 0 });
    wreck.fling(this.prop, v(r(1, 3), r(4, 6), r(-1, 1)), new THREE.Vector3(r(-8, 8), 0, r(-4, 4)), 0.15 * UNIT);
    for (const leg of this.gear) wreck.fling(leg, v(r(-2, 2), r(3, 5), r(-2, 2)), new THREE.Vector3(r(-4, 4), r(-2, 2), r(-4, 4)), 0.15 * UNIT);
    this.vel.y = 0;
  }

  /** Skidding along the ground: the nose comes up level, the speed dies away, sparks and dust fly. It then settles as a burning wreck. */
  private slide(dt: number): void {
    const g = this.group;
    this.slideT += dt;
    this.vel.x *= Math.exp(-SLIDE_DRAG * dt);
    this.vel.z *= Math.exp(-SLIDE_DRAG * dt);
    g.position.x += this.vel.x * dt;
    g.position.z += this.vel.z * dt;
    // it rests on the ground, or a roof, belly down and level
    g.position.y = Math.max(0, this.deps.floor(g.position.x, g.position.z, g.position.y + 0.5)) + 0.5 * UNIT * 1.2;
    this.body.rotation.z += (0 - this.body.rotation.z) * Math.min(1, dt * 6);
    this.burnEngine(dt);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (Math.random() < Math.min(1, speed * dt * 8)) {
      const belly = scratch.set(g.position.x, g.position.y - 0.4 * UNIT, g.position.z);
      this.fx?.sparks(belly, 3, 3, [0xffd080, 0xffa040, 0xffffff]);
      this.deps.dust.puff(belly, 1, 0.5, 1.2, 0.6);
    }
    if (speed < SLIDE_STOP || this.slideT > SLIDE_MAX) this.settle();
  }

  /** It has stopped: the two halves of the fuselage become rigid wrecks (cover, and an obstacle), and the fires carry on. */
  private settle(): void {
    this.state = 'wreck';
    this.burnT = 0;
    const { debris, floor } = this.deps;
    const g = this.group;
    const world = g.parent ?? g;
    this.body.rotation.set(0, 0, 0);
    g.updateMatrixWorld(true);
    for (const [name, piece] of Object.entries(this.pieces) as [keyof typeof PIECES, THREE.Group][]) {
      const { x, size } = PIECES[name];
      const centre = this.body.localToWorld(new THREE.Vector3(x, 0, 0));
      centre.y = Math.max(centre.y, size / 2);
      const pivot = new THREE.Group();
      pivot.position.copy(centre);
      world.add(pivot);
      pivot.attach(piece);
      debris.spawnBody(pivot, size, new THREE.Vector3(0, 0, 0), floor);
      this.flaming.push(pivot);
    }
    // the fires carry on: a big one on each half and a few smaller ones licking up from the ground around them
    this.engineBlaze?.dispose();
    this.engineBlaze = null;
    this.flaming.forEach((o, i) => this.blazes.push({ blaze: new Blaze(world, i === 0 ? 1.5 : 1.2, 6), follow: o, dx: 0, dz: 0 }));
    for (const [follow, dx, dz, size] of [[this.flaming[0], 0.7, 0.35, 0.8], [this.flaming[0], -0.6, -0.3, 0.7], [this.flaming[1], 0.5, -0.3, 0.8], [this.flaming[1], -0.5, 0.3, 0.6]] as const) {
      this.blazes.push({ blaze: new Blaze(world, size, 4), follow, dx, dz });
    }
  }

  /** the air flowing past a fire, as the flames feel it: the wind, and (for something moving) the rush of its own speed */
  private flow(vx: number, vy: number): { x: number; y: number } {
    const w = this.fx?.windSpeed ?? 0;
    return { x: -w * 1.5 - vx, y: 2.2 - vy };
  }

  /** The fire in the engine as the wreck falls: the flames stream back along its path, and a trail of black smoke follows. */
  private burnEngine(dt: number): void {
    const b = this.engineBlaze;
    if (!b) return;
    this.group.updateMatrixWorld(true);
    const at = this.body.localToWorld(scratch.set(3.0, 0.05, 0));
    b.place(at);
    const f = this.flow(this.vel.x, this.vel.y);
    b.update(dt, 1, f.x, f.y);
    this.smoke(at, 1, dt);
  }

  /** Black smoke climbing from a fire; the wind carries it off. */
  private smoke(at: THREE.Vector3, n: number, dt: number): void {
    for (let c = 14 * n * dt; c > 0; c--) if (c >= 1 || Math.random() < c) this.deps.dust.plume(at, 0.55, 3 + Math.random() * 2);
  }

  /** The wreck burns on: several fires with their own smoke, the whole lot dying down slowly. */
  private burnWreck(dt: number): void {
    const k = Math.min(1, (1 - this.burnT / AIRCRAFT.flameTime) * 1.6);       // full strength for a while, then it dies down
    this.wreck?.smoulder(dt, this.burnT, this.flaming[0]?.position ?? this.group.position, this.deps.dust, AIRCRAFT.flameTime);
    const f = this.flow(0, 0);
    for (const { blaze, follow, dx, dz } of this.blazes) {
      if (follow) blaze.place(scratch.set(follow.position.x + dx, Math.max(0.05, follow.position.y - 0.12), follow.position.z + dz));
      blaze.update(dt, Math.max(0, k), f.x, f.y);
      if (k > 0) this.smoke(blaze.group.position, k * 0.5, dt);
    }
  }
}
