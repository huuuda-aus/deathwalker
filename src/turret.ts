import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy, type ShotFn } from './enemies';
import type { Explosions } from './explosions';
import type { Dust } from './dust';
import type { Debris } from './debris';
import { Wreckage } from './wreckage';
import { TURRET } from './config';
import { sfx } from './sfx';

/** pale armour and a dark gun, like everything on the enemy side, on a concrete pad */
const ARMOUR = new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.65, metalness: 0.25 });
const ARMOUR_DARK = new THREE.MeshStandardMaterial({ color: 0xaab0b6, roughness: 0.6, metalness: 0.35 });
const GUN = new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.45, metalness: 0.7 });
const PAD = new THREE.MeshStandardMaterial({ color: 0xb8b3a6, roughness: 0.95 });
const SLIT = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.3, metalness: 0.4 });
const CHAR = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 1 });
const CHAR_GUN = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.7, metalness: 0.3 });
const WRECK_FIRE = [0xffd080, 0xff7020, 0x553311, 0x333333];
const WRECK_COLORS = [new THREE.Color(0xe8eaec), new THREE.Color(0xaab0b6), new THREE.Color(0x6b6f73)];

export interface TurretDeps { explosions: Explosions; dust: Dust; debris: Debris }

const tmp = new THREE.Vector3();
const miss = new THREE.Vector3();

type Phase = 'idle' | 'burst' | 'rest';

/**
 * A heavy machine-gun turret guarding the bunker: two barrels on a head that swings round and tips up to follow the mech, in an armoured
 * housing with a sloped shield, on a concrete pad. When the mech comes within range it opens fire in long, accurate bursts, the two guns
 * taking it in turns, and rests between them. It takes a lot of bullets to silence one, and it blows up when it is.
 */
export class TurretUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  readonly lockAnywhere = false;
  counted = true;
  gone = false;
  deadTime = 0;
  hp: number = TURRET.hp;
  private dead = false;
  private readonly head = new THREE.Group();
  private readonly barrels = new THREE.Group();
  private readonly guns: THREE.Group[] = [];
  private readonly tips: THREE.Object3D[] = [];
  private readonly parts: THREE.Mesh[] = [];
  private yaw = Math.PI;
  private pitch = 0;
  private phase: Phase = 'idle';
  private phaseT = 0;
  private roundsLeft = 0;
  private shotT = 0;
  private side = 0;
  private wreck: Wreckage | null = null;
  private burn = 0;

  constructor(x: number, y: number, z: number, private readonly deps: TurretDeps) {
    this.group.position.set(x, y, z);
    const part = (w: number, h: number, d: number, mat: THREE.Material, px: number, py: number, pz: number, into: THREE.Object3D): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(px, py, pz);
      m.castShadow = m.receiveShadow = true;
      into.add(m);
      if (mat !== PAD) this.parts.push(m);
      return m;
    };
    // the pad and the ring the head turns on
    part(2.6, 0.35, 2.6, PAD, 0, 0.175, 0, this.group);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.2, 20), ARMOUR_DARK);
    ring.position.y = 0.45;
    ring.castShadow = true;
    this.group.add(ring);
    this.parts.push(ring);
    // the head: the housing, a sloped shield in front, ammunition boxes either side, a sighting slit
    this.head.position.y = 0.55;
    this.group.add(this.head);
    part(1.3, 0.62, 1.1, ARMOUR, -0.1, 0.38, 0, this.head);
    const shield = part(0.2, 0.85, 1.35, ARMOUR_DARK, 0.62, 0.5, 0, this.head);
    shield.rotation.z = -0.25;
    for (const s of [-1, 1]) part(0.6, 0.34, 0.3, GUN, -0.2, 0.28, s * 0.7, this.head);
    part(0.05, 0.14, 0.5, SLIT, 0.58, 0.72, 0, this.head);
    // the two barrels, on a cradle that tips up and down
    this.barrels.position.set(0.5, 0.62, 0);
    this.head.add(this.barrels);
    for (const s of [-1, 1]) {
      const gun = new THREE.Group();
      gun.position.z = s * 0.26;
      const jacket = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.9, 12).rotateZ(Math.PI / 2), GUN);
      jacket.position.x = 0.45;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 1.35, 10).rotateZ(Math.PI / 2), GUN);
      barrel.position.x = 1.0;
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 10).rotateZ(Math.PI / 2), GUN);
      brake.position.x = 1.62;
      for (const m of [jacket, barrel, brake]) { m.castShadow = true; gun.add(m); this.parts.push(m); }
      const tip = new THREE.Object3D();
      tip.position.x = 1.74;
      gun.add(tip);
      this.barrels.add(gun);
      this.guns.push(gun);
      this.tips.push(tip);
    }
    this.head.rotation.y = this.yaw;
  }

  /** a turret does not leave when the scene is over: it is bolted down (and nothing is to send it away) */
  get retreating(): boolean { return false; }
  set retreating(v: boolean) { void v; }
  get alive(): boolean { return !this.dead; }
  get x(): number { return this.group.position.x; }

  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    out.min.set(p.x - 1.1, p.y, p.z - 1.1);
    out.max.set(p.x + 1.1, p.y + 1.7, p.z + 1.1);
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

  private destroy(fx: Fx): void {
    this.dead = true;
    this.deadTime = 0;
    const { explosions, dust, debris } = this.deps;
    const p = this.group.position;
    const at = tmp.set(p.x, p.y + 0.9, p.z);
    explosions.wreckBlast(at, TURRET.wreckBlastRadius, TURRET.wreckBlastScale);
    fx.burst(at, 36, 5, WRECK_FIRE);
    fx.muzzleFlash(at);
    dust.puff(at, 6, 0.6, 1.8);
    for (const m of this.parts) m.material = m.material === GUN ? CHAR_GUN : CHAR;
    // the barrels are thrown clear
    const wreck = (this.wreck = new Wreckage(this.group.parent ?? this.group));
    this.barrels.position.y += 0.1;
    wreck.fling(this.barrels, new THREE.Vector3(2 + Math.random() * 2, 4.5, (Math.random() - 0.5) * 3), new THREE.Vector3(0.5, 1.2, 3), 0.25);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, out = 1 + Math.random() * 3;
      debris.spawn(at, WRECK_COLORS[i % WRECK_COLORS.length], 0.05 + Math.random() * 0.1, new THREE.Vector3(Math.cos(a) * out, 2 + Math.random() * 3.5, Math.sin(a) * out * 0.6));
    }
  }

  dispose(): void { this.wreck?.dispose(); }

  update(dt: number, target: THREE.Vector3, fx: Fx, onShoot: ShotFn): void {
    const p = this.group.position;
    if (this.dead) {
      this.deadTime += dt;
      this.burn += dt;
      this.wreck?.update(dt);
      this.wreck?.smoulder(dt, this.burn, tmp.set(p.x, p.y + 0.5, p.z), this.deps.dust, 8);
      return;
    }
    // the head follows the mech, quickly but not instantly
    const dx = target.x - p.x, dz = target.z - p.z, dy = target.y - (p.y + 1.2);
    const wantYaw = Math.atan2(-dz, dx), wantPitch = THREE.MathUtils.clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.25, 0.7);
    const turn = Math.atan2(Math.sin(wantYaw - this.yaw), Math.cos(wantYaw - this.yaw));
    this.yaw += THREE.MathUtils.clamp(turn, -3.5 * dt, 3.5 * dt);
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 4);
    this.head.rotation.y = this.yaw;
    this.barrels.rotation.z = this.pitch;
    // the guns ease back out after each kick
    for (const g of this.guns) g.position.x += (0 - g.position.x) * Math.min(1, dt * 18);

    const inRange = Math.abs(dx) < TURRET.range;
    this.phaseT += dt;
    switch (this.phase) {
      case 'idle':
        if (inRange) { this.phase = 'rest'; this.phaseT = 0; this.shotT = TURRET.firstDelay; }
        break;
      case 'rest':
        this.shotT -= dt;
        if (!inRange) { this.phase = 'idle'; break; }
        if (this.shotT <= 0) {
          this.phase = 'burst';
          this.phaseT = 0;
          this.roundsLeft = TURRET.burst[0] + Math.floor(Math.random() * (TURRET.burst[1] - TURRET.burst[0] + 1));
          this.shotT = 0;
        }
        break;
      case 'burst':
        this.shotT -= dt;
        while (this.shotT <= 0 && this.roundsLeft > 0) {
          this.fire(fx, onShoot);
          this.roundsLeft--;
          this.shotT += 1 / TURRET.rate;
        }
        if (this.roundsLeft <= 0) { this.phase = 'rest'; this.phaseT = 0; this.shotT = TURRET.rest[0] + Math.random() * (TURRET.rest[1] - TURRET.rest[0]); }
        break;
    }
  }

  /** one round from the next barrel (they take turns) */
  private fire(fx: Fx, onShoot: ShotFn): void {
    const i = this.side;
    this.side = 1 - this.side;
    this.group.updateMatrixWorld(true);
    this.tips[i].getWorldPosition(tmp);
    this.guns[i].position.x = -0.16;                       // the kick
    fx.sparks(tmp, 3, 3, [0xffd080, 0xffa040, 0xffffff]);
    fx.muzzleFlash(tmp);
    sfx.gunnerShot(tmp);
    onShoot(tmp, miss.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1), { precision: TURRET.precision, speed: TURRET.bulletSpeed, heavy: true });
  }
}
