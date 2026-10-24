import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Explosions } from './explosions';
import type { Debris, FloorFn } from './debris';
import type { Dust } from './dust';
import { makeMissileModel, MISSILE_BELOW, MISSILE_LEN, type Missiles } from './missiles';
import { Wreckage } from './wreckage';
import { SILO } from './config';
import { box } from './cannonParts';

const CONCRETE = new THREE.MeshStandardMaterial({ color: 0xd6dade, roughness: 0.9 });
const STEEL = new THREE.MeshStandardMaterial({ color: 0xcfd4d9, roughness: 0.5, metalness: 0.3 });
const PIT = new THREE.MeshStandardMaterial({ color: 0x0a0b0c, roughness: 1 });
const CHAR_CONCRETE = new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 1 });
const CHAR_STEEL = new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.7, metalness: 0.3 });
const WRECK_FIRE = [0xffd080, 0xff7020, 0x553311, 0x333333];
const WRECK_COLORS = [new THREE.Color(0xd6dade), new THREE.Color(0xa8adb2), new THREE.Color(0x6b6f73)];
const WRECK_PIECES = 22;
/** seconds a wreck smoulders (it is still burning when the level ends) */
const SMOULDER = 120;

/** footprint half-extents of the frame and of the pit inside it, and the frame's height */
const HALF = { x: 1.5, z: 1.1 };
const PIT_HALF = { x: 1.05, z: 0.7 };
const FRAME_H = 0.3;
/** each door covers half the pit and slides this far apart when open */
const DOOR_W = PIT_HALF.x;
const DOOR_SLIDE = DOOR_W * 0.95;
/** the missile standing up in the open pit: tail height, and the tip */
const MISSILE_TAIL = 0.3;
const MISSILE_TIP = MISSILE_TAIL + MISSILE_LEN;
/** half-width of the hit box over the exposed missile */
const CORE_HALF = 0.3;

export type SiloState = 'closed' | 'opening' | 'exposed' | 'firing' | 'closing' | 'dead';

export interface SiloDeps {
  explosions: Explosions;
  debris: Debris;
  dust: Dust;
  missiles: Missiles;
  /** surface height for falling wreckage */
  floor: FloorFn;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const tmp = new THREE.Vector3();

/**
 * One of the level boss's two silos. Shut, it is a flat slab that spits sparks and takes no damage; open, the
 * missile standing in it is a tall narrow target, and the silo counts down to launching it. The boss tells it
 * when to open (so both go together); the rest of the cycle, closed -> opening -> exposed -> firing -> closing,
 * is its own. A destroyed silo is a smoking wreck that stays for the rest of the level.
 */
export class SiloUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  counted = false;
  retreating = false;
  gone = false;
  /** stays 0: the wreck is part of the scene until the level ends, and the manager clears dead things after a while */
  readonly deadTime = 0;
  readonly maxHp: number = SILO.hp;
  hp: number = SILO.hp;
  state: SiloState = 'closed';
  /** how fast its whole cycle runs; the boss raises it when the other silo is gone */
  speed = 1;
  /** seconds spent shut so far: the boss opens both once each has waited long enough */
  rest = 0;
  private t = 0;
  /** the doors' travel, 0 shut .. 1 open */
  private door = 0;
  private burn = 0;
  private wreck: Wreckage | null = null;
  private readonly doors = [
    box(DOOR_W, 0.12, PIT_HALF.z * 2, STEEL, -DOOR_W / 2, FRAME_H - 0.06, 0),
    box(DOOR_W, 0.12, PIT_HALF.z * 2, STEEL, DOOR_W / 2, FRAME_H - 0.06, 0),
  ];
  private readonly missile = makeMissileModel();

  /** @param armTime seconds it sits open before it launches */
  constructor(x: number, z: number, private readonly armTime: number, private readonly deps: SiloDeps) {
    const g = this.group;
    g.position.set(x, 0, z);
    // a frame of four slabs round an open pit, with a black floor
    const bx = HALF.x - PIT_HALF.x, bz = HALF.z - PIT_HALF.z;
    g.add(
      box(HALF.x * 2, FRAME_H, bz, CONCRETE, 0, FRAME_H / 2, -(HALF.z - bz / 2)),
      box(HALF.x * 2, FRAME_H, bz, CONCRETE, 0, FRAME_H / 2, HALF.z - bz / 2),
      box(bx, FRAME_H, PIT_HALF.z * 2, CONCRETE, -(HALF.x - bx / 2), FRAME_H / 2, 0),
      box(bx, FRAME_H, PIT_HALF.z * 2, CONCRETE, HALF.x - bx / 2, FRAME_H / 2, 0),
      box(PIT_HALF.x * 2, 0.02, PIT_HALF.z * 2, PIT, 0, 0.02, 0),
      ...this.doors,
    );
    this.missile.visible = false;
    g.add(this.missile);
    this.pose();
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get x(): number { return this.group.position.x; }
  /** only an open silo can be hurt: the missile is exposed while it waits to launch */
  get vulnerable(): boolean { return this.state === 'exposed'; }
  get hpFraction(): number { return Math.max(0, this.hp / this.maxHp); }

  /** The boss opens it (only a shut silo does anything). */
  open(): void {
    if (this.state !== 'closed') return;
    this.state = 'opening';
    this.t = 0;
    this.missile.visible = true;
  }

  /** the slab while shut or moving; the narrow vertical column over the missile once it stands exposed */
  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    if (this.vulnerable) {
      out.min.set(p.x - CORE_HALF, 0, p.z - CORE_HALF);
      out.max.set(p.x + CORE_HALF, MISSILE_TIP, p.z + CORE_HALF);
    } else {
      out.min.set(p.x - HALF.x, 0, p.z - HALF.z);
      out.max.set(p.x + HALF.x, FRAME_H, p.z + HALF.z);
    }
    return out;
  }

  /** Hits on shut doors (and the frame) do nothing: the bullet's sparks are all there is. Returns true if the hit destroyed it. */
  damage(n: number, fx: Fx): boolean {
    if (!this.vulnerable) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.destroy(fx);
    return true;
  }

  private destroy(fx: Fx): void {
    this.state = 'dead';
    this.missile.visible = false;
    const { explosions, dust, debris, floor } = this.deps;
    const p = this.group.position;
    const at = tmp.set(p.x, FRAME_H, p.z);
    explosions.wreckBlast(at, SILO.wreckBlastRadius, SILO.wreckBlastScale);
    fx.burst(at, 40, 5, WRECK_FIRE);
    fx.muzzleFlash(at);
    dust.puff(at, 8, 0.6, 2);
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (o.material === CONCRETE) o.material = CHAR_CONCRETE;
      else if (o.material === STEEL) o.material = CHAR_STEEL;
    });
    // the doors are blown off and land on the ground
    const wreck = (this.wreck = new Wreckage(this.group.parent ?? this.group));
    this.doors.forEach((d, i) => {
      const side = i === 0 ? -1 : 1;
      wreck.fling(d, new THREE.Vector3(side * (1.5 + Math.random()), 4 + Math.random() * 2, (Math.random() - 0.5) * 2), new THREE.Vector3(Math.random() * 3, 0, side * 4), 0.06);
    });
    const vel = new THREE.Vector3();
    for (let i = 0; i < WRECK_PIECES; i++) {
      const a = Math.random() * Math.PI * 2, out = 1 + Math.random() * 3;
      vel.set(Math.cos(a) * out, 3 + Math.random() * 4, Math.sin(a) * out * 0.6);
      debris.spawn(at, WRECK_COLORS[i % WRECK_COLORS.length], 0.06 + Math.random() * 0.1, vel, floor);
    }
  }

  dispose(): void { this.wreck?.dispose(); }

  update(dt: number): void {
    if (this.state === 'dead') {
      this.burn += dt;
      this.wreck?.update(dt);
      this.wreck?.smoulder(dt, this.burn, tmp.set(this.group.position.x, FRAME_H, this.group.position.z), this.deps.dust, SMOULDER);
      return;
    }
    // the scene is over: it stops where it is
    const step = this.retreating ? 0 : dt * this.speed;
    this.t += step;
    switch (this.state) {
      case 'closed':
        this.rest += step;
        break;
      case 'opening':
        this.door = Math.min(1, this.t / SILO.openTime);
        if (this.door >= 1) { this.state = 'exposed'; this.t = 0; }
        break;
      case 'exposed':
        if (this.t >= this.armTime) this.launch();
        break;
      case 'firing':
        if (this.t >= SILO.fireTime) { this.state = 'closing'; this.t = 0; }
        break;
      case 'closing':
        this.door = 1 - Math.min(1, this.t / SILO.closeTime);
        if (this.door <= 0) { this.state = 'closed'; this.t = 0; this.rest = 0; this.missile.visible = false; }
        break;
    }
    this.pose();
  }

  private launch(): void {
    this.state = 'firing';
    this.t = 0;
    this.missile.visible = false;
    const p = this.group.position;
    this.deps.missiles.launch(tmp.set(p.x, MISSILE_TIP, p.z), this);
  }

  /** doors apart by how far open; the missile rises out of the pit with them */
  private pose(): void {
    const k = smooth(this.door);
    this.doors[0].position.x = -DOOR_W / 2 - DOOR_SLIDE * k;
    this.doors[1].position.x = DOOR_W / 2 + DOOR_SLIDE * k;
    this.missile.position.set(0, MISSILE_TAIL + MISSILE_BELOW - (1 - k) * (MISSILE_LEN + MISSILE_TAIL), 0);
  }
}
