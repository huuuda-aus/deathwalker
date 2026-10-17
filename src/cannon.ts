import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy, type Soldier } from './enemies';
import type { Horse } from './horse';
import type { Explosions } from './explosions';
import type { Shells } from './shells';
import type { Debris, FloorFn } from './debris';
import type { Dust } from './dust';
import { LANE } from './mech';
import { CANNON, WEAPON } from './config';
import { UNIT, WOOD, IRON, box } from './cannonParts';
import { HpBar } from './hpBar';
import { Wreckage } from './wreckage';

/** horse sits this far ahead (-x) of the axle while hitched */
const HORSE_OFFSET = 3.4;
const WHEEL_R = 0.7;
const AXLE_Y = WHEEL_R;
const DECK_Y = 0.95;
const BARREL_LEN = 2.2;
const POLE_LEN = 3;
/** pole angle (about z) with its far end up on the horse's harness / down on the ground */
const POLE_HITCHED = -0.2;
const POLE_GROUNDED = 0.22;
/** seconds the cannon takes to roll to a stop and drop its trail once unhitched */
const DEPLOY_TIME = 0.9;
/** distance the cannon coasts while deploying (speed falls off quadratically), so it comes to rest on its stop mark */
const DEPLOY_GLIDE = (CANNON.rideSpeed * DEPLOY_TIME) / 3;
/** hit box (metres, relative to the axle, barrel toward +x): the carriage and barrel only */
const BOX = { cx: 0.75, hx: 1.65, cy: 1.6, hy: 1.6, hz: 0.9 };
/** the barrel at rest, how fast it elevates (rad/s), and how long before the round it starts laying on its target (s) */
const REST_PITCH = 0.12;
const ELEVATE_RATE = 0.9;
const LAY_TIME = 1.4;
/** crew spots in metres, carriage-local with the barrel toward +x: standing on the deck, and at the gun */
const DECK_SLOTS = [{ x: -0.9, z: -0.35 }, { x: -0.3, z: 0.35 }];
const POST_SLOTS = [{ x: -1.3, z: -0.9 }, { x: -1.3, z: 0.9 }];
/** a soldier this close to his place at the gun climbs in (world units) */
const MAN_REACH = 0.3;

/** What the cannon needs from the world: shells to fire, and debris/smoke for when it blows up. */
export interface CannonDeps {
  shells: Shells;
  debris: Debris;
  dust: Dust;
  explosions: Explosions;
  /** surface height for falling wreckage */
  floor: FloorFn;
}

const WRECK_COLORS = [new THREE.Color(0xe8eaec), new THREE.Color(0xcfd4d9), new THREE.Color(0xf4f6f8)];
const WRECK_PIECES = 16;
/** scorched materials swapped in when the cannon is destroyed */
const CHAR_WOOD = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 1 });
const CHAR_IRON = new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.7, metalness: 0.3 });
const WRECK_FIRE = [0xffd080, 0xff7020, 0x553311, 0x333333];

type State = 'ride' | 'deploy' | 'fire' | 'dead';

function makeWheel(z: number): THREE.Group {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R, 0.08, 6, 20), WOOD);
  rim.castShadow = true;
  g.add(rim, box(2 * WHEEL_R, 0.1, 0.1, WOOD), box(0.1, 2 * WHEEL_R, 0.1, WOOD), box(0.2, 0.2, 0.2, IRON));
  g.position.set(0, AXLE_Y, z);
  return g;
}

const tmpTarget = new THREE.Vector3();
const tmpMuzzle = new THREE.Vector3();
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * A horse-drawn cannon with two soldiers riding on its deck: it comes in from the right, rolls to a stop
 * somewhere on screen, drops its trail and unhitches; the horse bolts off to the left while the crew climb
 * down and man the gun, which lobs slow shells at the mech. Crew and horse are separate enemies that can be
 * shot on their own; with the crew dead the gun falls silent, and if the gun is destroyed the crew fight on foot.
 */
export class CannonUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  counted = false;
  retreating = false;
  gone = false;
  deadTime = 0;
  private hp: number = CANNON.hp;
  private readonly hpBar = new HpBar((BOX.cy + BOX.hy) * UNIT + 0.4);
  private state: State = 'ride';
  private t = 0;
  private fireTimer: number = CANNON.firstShotDelay;
  private recoil = 0;
  /** the gun always points to the right (+1) and never turns */
  private readonly facing = 1;
  private readonly yaw = 0;
  /** barrel elevation now, and the round being laid on (flight time and landing point) once the barrel starts to rise */
  private pitch = REST_PITCH;
  private laid: { flight: number; aim: THREE.Vector3; pitch: number } | null = null;
  private work = Math.random() * 6;
  private readonly carriage = new THREE.Group();
  private readonly wheels = [makeWheel(-0.65), makeWheel(0.65)];
  private readonly pole = new THREE.Group();
  private readonly barrelPivot = new THREE.Group();
  private readonly barrel = new THREE.Group();
  private wreck: Wreckage | null = null;
  /** its velocity along x right now (rolling in, or coasting to a stop): pieces thrown off a wreck carry it */
  private vx = 0;
  /** street infantry on their way to take over an unmanned gun, each with the crew slot it was given */
  private claims: { soldier: Soldier; slot: number }[] = [];

  constructor(
    x: number, z: number,
    private readonly stopX: number,
    private readonly crew: Soldier[],
    private readonly horse: Horse,
    private readonly deps: CannonDeps,
  ) {
    this.group.position.set(x, 0, z);
    this.carriage.scale.setScalar(UNIT);

    const { carriage, pole, barrelPivot, barrel } = this;
    pole.position.set(0, AXLE_Y, 0);
    pole.rotation.z = POLE_HITCHED;
    pole.add(box(POLE_LEN, 0.12, 0.2, WOOD, -POLE_LEN / 2, 0, 0));
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, BARREL_LEN, 12).rotateZ(-Math.PI / 2), IRON);
    tube.castShadow = true;
    tube.position.x = BARREL_LEN / 2;
    barrel.add(tube);
    barrelPivot.position.set(0.1, AXLE_Y + 0.45, 0);
    barrelPivot.add(barrel, new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), IRON));
    carriage.add(...this.wheels, pole, barrelPivot, box(1.5, 0.1, 1.1, WOOD, -0.5, DECK_Y - 0.05, 0));
    this.group.add(carriage, this.hpBar.group);

    for (const c of crew) c.mount();
    this.placeHorse();
    this.placeCrew(0);
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get x(): number { return this.group.position.x; }

  /** alive and still has someone to fire it */
  get operational(): boolean { return this.alive && this.crewAboard().length > 0; }

  /** Deployed and intact, with a crew slot nobody holds or is heading for. */
  get needsCrew(): boolean {
    return this.state === 'fire' && !this.retreating && this.crewAboard().length + this.claims.length < CANNON.crew;
  }

  /** carriage-local (x toward the barrel, z across) in metres to world x, z, given the gun's turn */
  private local(lx: number, lz: number, gx: number, gz: number): { x: number; z: number } {
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    return { x: gx + (lx * c + lz * sn) * UNIT, z: gz + (-lx * sn + lz * c) * UNIT };
  }

  /** Where this slot's gunner stands, on the ground beside the gun. */
  private slotWorld(slot: number): { x: number; z: number } {
    const g = this.group.position, s = POST_SLOTS[slot];
    return this.local(s.x, s.z, g.x, g.z);
  }

  /** Send a soldier to take a free crew slot. Returns false if there is none. */
  claim(soldier: Soldier): boolean {
    if (!this.needsCrew) return false;
    const taken = new Set(this.claims.map((c) => c.slot));
    const slot = this.crew.findIndex((c, i) => c.state !== 'mounted' && !taken.has(i));
    if (slot < 0) return false;
    const at = this.slotWorld(slot);
    soldier.rushTo(at.x, at.z);
    this.claims.push({ soldier, slot });
    return true;
  }

  /** Soldiers on their way: the ones that arrive man the gun; the ones that die or give up are forgotten. */
  private stepClaims(): void {
    for (let i = this.claims.length - 1; i >= 0; i--) {
      const { soldier: s, slot } = this.claims[i];
      const at = this.slotWorld(slot);
      const d = Math.hypot(s.x - at.x, s.group.position.z - at.z);
      if (!s.alive || this.retreating || this.state !== 'fire') {
        if (s.alive) s.standDown();
        this.claims.splice(i, 1);
      } else if (d < MAN_REACH) {
        const first = this.crewAboard().length === 0;
        this.crew[slot] = s;          // replaces whoever died there
        s.crewUp();
        if (first) this.fireTimer = CANNON.firstShotDelay;   // the new gunner loads before the first round
        this.claims.splice(i, 1);
      } else if (s.settled) {
        s.standDown();                // stuck or distracted: it will not get there
        this.claims.splice(i, 1);
      }
    }
  }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    const cx = p.x + BOX.cx * Math.cos(this.yaw) * UNIT;
    out.min.set(cx - BOX.hx * UNIT, (BOX.cy - BOX.hy) * UNIT, p.z - BOX.hz * UNIT);
    out.max.set(cx + BOX.hx * UNIT, (BOX.cy + BOX.hy) * UNIT, p.z + BOX.hz * UNIT);
    return out;
  }

  damage(n: number, fx: Fx, push?: THREE.Vector3): boolean {
    if (!this.alive) return false;
    if (n > WEAPON.damage) console.log(`[hp] cannon -${n.toFixed(1)}`, new Error().stack?.split('\n')[2]?.trim());   // TEMP
    this.hp -= n;
    if (this.hp > 0) return false;
    if (push) this.vx += push.x * WEAPON.pushShare.vehicle;     // the pieces carry a little of the bullet's push
    this.state = 'dead';
    this.deadTime = 0;
    this.releaseCrew();
    this.horse.release();
    this.explode(fx);
    this.breakApart();
    return true;
  }

  /**
   * The wreck: everything scorched, the barrel and the near wheel blown off, the carriage slumped on the
   * side that lost its wheel, the trail snapped short and a spoke missing from the other wheel.
   */
  private breakApart(): void {
    const { carriage, pole, barrelPivot } = this;
    carriage.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (o.material === WOOD) o.material = CHAR_WOOD;
      else if (o.material === IRON) o.material = CHAR_IRON;
    });
    const lost = this.wheels[1], kept = this.wheels[0];
    kept.children[1].visible = false;
    pole.rotation.z = POLE_GROUNDED;
    pole.scale.x = 0.45;
    carriage.rotation.x = 0.28;
    carriage.position.y = -0.1 * UNIT;
    carriage.add(box(0.5, 0.5, 0.5, CHAR_IRON, 0.1, AXLE_Y + 0.45)); // the broken mount
    const side = Math.random() < 0.5 ? -1 : 1;
    const wreck = (this.wreck = new Wreckage(this.group.parent ?? this.group));
    wreck.fling(barrelPivot, new THREE.Vector3(side * (0.4 + 0.4 * Math.random()) + this.vx, 3.2, 0.3 + 0.3 * Math.random()), new THREE.Vector3(1, 0.5, side * 4), 0.24 * UNIT, { z: 0 });
    wreck.fling(lost, new THREE.Vector3(-side * (0.4 + 0.4 * Math.random()) + this.vx, 2.8, 0.4), new THREE.Vector3(0.5, 0, -side * 5), 0.1 * UNIT, { x: Math.PI / 2 });
  }

  /** a small blast: sparks and smoke, plus splinters and scrap that tumble, bounce and settle like real rubble */
  private explode(fx: Fx): void {
    const { debris, dust, floor, explosions } = this.deps;
    const p = this.group.position;
    const at = tmpTarget.set(p.x + 0.3 * this.facing * UNIT, BOX.cy * UNIT * 0.6, p.z);
    explosions.wreckBlast(at, CANNON.wreckBlastRadius, CANNON.wreckBlastScale);
    fx.burst(at, 30, 4, WRECK_FIRE);
    fx.muzzleFlash(at);
    dust.puff(at, 5, 0.5, 1.5);
    for (let i = 0; i < WRECK_PIECES; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 1 + Math.random() * 2.5;
      tmpMuzzle.set(Math.cos(a) * out, 2 + Math.random() * 3, Math.sin(a) * out * 0.6);
      debris.spawn(at, WRECK_COLORS[i % WRECK_COLORS.length], 0.05 + Math.random() * 0.09, tmpMuzzle, floor);
    }
  }

  dispose(): void { this.wreck?.dispose(); }

  private crewAboard(): Soldier[] { return this.crew.filter((c) => c.state === 'mounted'); }

  private releaseCrew(): void { for (const c of this.crew) c.release(); }

  update(dt: number, target: THREE.Vector3): void {
    const g = this.group;
    this.hpBar.set(this.hp / CANNON.hp, this.alive);
    // the scene is over: the crew abandon the gun and walk off with everyone else
    if (this.retreating && this.alive) { this.releaseCrew(); this.horse.release(); }
    switch (this.state) {
      case 'ride':
        g.position.x -= CANNON.rideSpeed * dt;
        this.vx = -CANNON.rideSpeed;
        this.roll(CANNON.rideSpeed, dt);
        // at its stop mark, or the horse is gone (shot dead), the cannon starts to deploy
        if (g.position.x <= this.stopX + DEPLOY_GLIDE || this.horse.state !== 'pulling') {
          this.state = 'deploy';
          this.t = 0;
          this.horse.release();
        }
        break;
      case 'deploy': {
        // roll to a stop while the trail drops to the ground and the crew climb down
        this.t += dt;
        const k = Math.min(1, this.t / DEPLOY_TIME);
        const speed = CANNON.rideSpeed * (1 - k) * (1 - k);
        g.position.x -= speed * dt;
        this.vx = -speed;
        this.roll(speed, dt);
        this.pole.rotation.z = POLE_HITCHED + (POLE_GROUNDED - POLE_HITCHED) * k;
        if (k >= 1) { this.state = 'fire'; this.vx = 0; }
        break;
      }
      case 'fire':
        this.stepClaims();
        this.aim(dt, target);
        break;
      case 'dead':
        this.deadTime += dt;
        this.wreck?.update(dt);
        this.wreck?.smoulder(dt, this.deadTime, tmpTarget.set(this.group.position.x, 0.5 * UNIT, this.group.position.z), this.deps.dust);
        break;
    }
    if (this.horse.state === 'pulling') this.placeHorse();
    if (this.alive) this.placeCrew(this.state === 'ride' ? 0 : this.state === 'deploy' ? smooth(Math.min(1, this.t / DEPLOY_TIME)) : 1, dt);
  }

  /**
   * Lay the barrel on the next round smoothly while it loads, and fire once it is on target.
   */
  private aim(dt: number, target: THREE.Vector3): void {
    this.recoil = Math.max(0, this.recoil - dt * 3);
    this.barrel.position.x = -0.3 * this.recoil;

    // nobody left to work it: the gun just sits there
    const crew = this.crewAboard().length;
    if (crew === 0) return;

    // the gun always points to the right, whatever the mech does
    // fewer hands load more slowly
    this.fireTimer -= (dt * crew) / CANNON.crew;
    // shortly before the round is ready, pick where it will land and bring the barrel up to the angle for it
    if (!this.laid && this.fireTimer <= LAY_TIME) this.laid = this.lay(target);
    const goalPitch = this.laid ? this.laid.pitch : REST_PITCH;
    this.pitch += THREE.MathUtils.clamp(goalPitch - this.pitch, -ELEVATE_RATE * dt, ELEVATE_RATE * dt);
    this.barrelPivot.rotation.z = this.pitch;
    if (this.fireTimer <= 0) {
      if (this.laid && Math.abs(this.pitch - this.laid.pitch) < 0.03) this.shoot(this.laid);
      else this.fireTimer = 0;                                 // not on target yet: it fires the moment it is
    }
  }

  /** Work out a round that lands roughly where the mech is now: no lead, plus a random miss. */
  private lay(mech: THREE.Vector3): { flight: number; aim: THREE.Vector3; pitch: number } {
    const flight = CANNON.flightMin + Math.random() * (CANNON.flightMax - CANNON.flightMin);
    const z = THREE.MathUtils.clamp(mech.z + (Math.random() - 0.5) * 2 * CANNON.spreadZ, LANE.zMin, LANE.zMax);
    const aim = new THREE.Vector3(mech.x + (Math.random() - 0.5) * 2 * CANNON.spreadX, 0.3, z);
    const g = this.group.position;
    const rise = 0.5 * CANNON.shellGravity * flight;
    return { flight, aim, pitch: Math.atan2(rise, Math.hypot(aim.x - g.x, aim.z - g.z) / flight) };
  }

  /** Fire the laid round from the barrel's mouth. */
  private shoot(round: { flight: number; aim: THREE.Vector3 }): void {
    this.fireTimer = CANNON.fireInterval;
    this.laid = null;
    this.group.updateMatrixWorld(true);
    this.barrelPivot.localToWorld(tmpMuzzle.set(BARREL_LEN, 0, 0));
    this.deps.shells.launch(tmpMuzzle, round.aim, round.flight);
    this.recoil = 1;
  }

  private roll(speed: number, dt: number): void {
    for (const w of this.wheels) w.rotation.z += (speed * dt) / (WHEEL_R * UNIT);
  }

  private placeHorse(): void {
    this.horse.place(this.group.position.x - HORSE_OFFSET * UNIT, this.group.position.z);
  }

  /** crew position between the deck (0) and the gun (1); they face the way of travel until deployed, then the mech */
  private placeCrew(k: number, dt = 0): void {
    const g = this.group.position;
    this.work += dt * 4;
    this.crew.forEach((c, i) => {
      if (c.state !== 'mounted') return;
      const a = DECK_SLOTS[i], b = POST_SLOTS[i];
      const lx = a.x + (b.x - a.x) * k, lz = a.z + (b.z - a.z) * k;
      const y = DECK_Y * (1 - k) * UNIT;
      const facing = k >= 1 ? (this.facing || 1) : -1;
      const sway = k >= 1 ? Math.sin(this.work + i * 2) * 0.08 : 0;
      const at = this.local(lx, lz, g.x, g.z);
      c.station(at.x, y, at.z, facing, sway);
    });
  }
}
