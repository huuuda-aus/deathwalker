import * as THREE from 'three';
import type { Fx } from './fx';
import type { Dust } from './dust';
import type { Explosions } from './explosions';
import type { FloorFn } from './debris';
import type { Mech } from './mech';
import { glowTexture } from './fireTextures';
import { MECH_DEATH } from './config';

const FIRE_COLORS = [0xfff2c0, 0xffd080, 0xff9030, 0xff5a10];
const GRAVITY = 9;
const GROUND_DRAG = 2.5;
const BOUNCE_MIN = 1.2;
const RING_GEO = new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);

const sprite = (color: THREE.Color): THREE.Sprite => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
  }));
  s.renderOrder = 6;
  return s;
};

/** One lobe of a fireball: from `start` (+`delay`) it swells from `from` to `to` over `life` seconds, then fades. */
interface Lobe { s: THREE.Sprite; start: number; life: number; from: number; to: number; rise: number; baseY: number }

/** A piece of the mech blown off and tumbling: it flies, bounces and comes to rest on whatever is below. */
interface Part { obj: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; r: number; settled: boolean; burning: boolean }

/** The cockpit, whole, on its way up: it blows up when it reaches the top of its climb. */
interface Pod { obj: THREE.Object3D; y0: number; vy: number; t: number; rise: number; q0: THREE.Quaternion; tilt: THREE.Euler; trail: number }

export interface MechDeathDeps {
  scene: THREE.Scene;
  fx: Fx;
  dust: Dust;
  explosions: Explosions;
  floor: FloorFn;
  /** the screen shakes (world units, at the blast) and flashes white (0..1) */
  shake: (at: THREE.Vector3, amount: number) => void;
  flash: (amount: number) => void;
  /** a blast tears at the buildings near it, flinging their blocks away */
  blastBuildings: (at: THREE.Vector3, radius: number, speed: number) => void;
  /** dig the crater the mech leaves at (x, z) */
  dig: (x: number, z: number) => void;
}

const tmp = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

/**
 * The mech's death. A huge yellow-white fireball boils up in lobes, with a shockwave ring and a column of smoke
 * that spreads at the top into a mushroom cap; the blast kills the infantry near it and tears the buildings
 * apart, throwing their blocks outward. The lower body breaks into parts that are flung about and left burning,
 * but the cockpit stays whole: it is shot straight up, tilting a little, and goes off in a second explosion.
 */
export class MechDeath {
  private age = -1;
  private at = new THREE.Vector3();
  private lobes: Lobe[] = [];
  private ring: THREE.Mesh | null = null;
  private parts: Part[] = [];
  private pod: Pod | null = null;
  private smokeT = 0;
  private capT = 0;

  constructor(private readonly deps: MechDeathDeps) {}

  /**
   * Blow the mech up where it stands. Its model is read for the pieces: the caller hides it.
   * @param apexY how high the cockpit climbs before it blows
   */
  start(mech: Mech, apexY: number): void {
    const { scene, fx, dust, explosions, shake, flash, blastBuildings, dig } = this.deps;
    this.clear();
    this.age = 0;
    mech.root.updateMatrixWorld(true);
    const p = mech.root.position;
    this.at.set(p.x, MECH_DEATH.height, p.z);
    const at = this.at;

    // the bang itself: it kills the infantry round about, tears the buildings and shoves rubble away
    explosions.wreckBlast(at, MECH_DEATH.blastRadius, MECH_DEATH.blastScale, 2.5, false);   // its own crater, not a flat scorch
    dig(at.x, at.z);
    blastBuildings(at, MECH_DEATH.buildingRadius, MECH_DEATH.buildingSpeed);
    fx.burst(at, 120, 9, FIRE_COLORS, false, 1.6);
    fx.sparks(at, 150, 12, FIRE_COLORS);
    fx.muzzleFlash(at);
    dust.puff(at, 40, 3, 6, 0.4);
    shake(at, MECH_DEATH.shake);
    flash(1);
    this.fireball(at, 0, MECH_DEATH.fireballSize, MECH_DEATH.lobes);

    // the shockwave across the ground
    this.ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 1.6, 0.8), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    }));
    this.ring.position.set(at.x, 0.05, at.z);
    scene.add(this.ring);

    // the cockpit leaves whole; everything else breaks up
    const cockpit = mech.cockpitModel;
    const pod = cockpit.clone(true);
    const lights: THREE.Object3D[] = [];
    pod.traverse((o) => { if (o instanceof THREE.Light || o instanceof THREE.Sprite) lights.push(o); });
    for (const o of lights) o.removeFromParent();       // the muzzle fire's lights and glow stay behind
    cockpit.matrixWorld.decompose(pod.position, pod.quaternion, pod.scale);
    scene.add(pod);
    const rise = Math.sqrt(2 * Math.max(1, apexY - pod.position.y) / MECH_DEATH.podGravity);
    const tilt = THREE.MathUtils.degToRad(MECH_DEATH.podTiltDeg);
    this.pod = {
      obj: pod, y0: pod.position.y, vy: rise * MECH_DEATH.podGravity, t: 0, rise, q0: pod.quaternion.clone(), trail: 0,
      tilt: new THREE.Euler((Math.random() * 2 - 1) * tilt, (Math.random() * 2 - 1) * tilt, (Math.random() * 2 - 1) * tilt),
    };
    this.breakApart(mech.root, at, 1, cockpit);
  }

  /** A fireball of a core, a big lobe and `count` smaller ones that boil out around `at`, starting now. `baseY` is where its bottom sits. */
  private fireball(at: THREE.Vector3, baseY: number, size: number, count: number): void {
    const { scene } = this.deps;
    const make = (color: THREE.Color, delay: number, life: number, from: number, to: number, rise: number, x = at.x, z = at.z): void => {
      const s = sprite(color);
      s.position.set(x, baseY, z);
      s.visible = false;
      scene.add(s);
      this.lobes.push({ s, start: this.age + delay, life, from, to, rise, baseY });
    };
    make(new THREE.Color(6, 5.2, 3.4), 0, 1.1, size * 0.2, size * 0.75, 0.4);
    make(new THREE.Color(3.2, 2.2, 0.8), 0, 1.9, size * 0.25, size, 0.35);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * size * 0.3;
      make(Math.random() < 0.5 ? new THREE.Color(3.6, 2.6, 1) : new THREE.Color(2.6, 1.1, 0.3),
        Math.random() * 0.45, 1.1 + Math.random() * 0.9, size * 0.12, size * (0.35 + Math.random() * 0.4), 0.3 + Math.random() * 0.5,
        at.x + Math.cos(a) * r, at.z + Math.sin(a) * r * 0.5);
    }
  }

  /**
   * Every visible piece of `root`'s model (except under `skip`) becomes a part of its own, thrown out from `from`.
   * @param force 1 for the mech's own blast
   */
  private breakApart(root: THREE.Object3D, from: THREE.Vector3, force: number, skip?: THREE.Object3D): void {
    const { scene } = this.deps;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || (o.material as THREE.Material).transparent) return;   // sprites, lights, flame planes
      for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible || n === skip) return;
      const obj = new THREE.Mesh(o.geometry, o.material);
      obj.castShadow = true;
      o.matrixWorld.decompose(obj.position, obj.quaternion, obj.scale);
      scene.add(obj);
      o.geometry.computeBoundingSphere();
      const r = Math.max(0.04, (o.geometry.boundingSphere?.radius ?? 0.2) * Math.max(obj.scale.x, obj.scale.y, obj.scale.z));
      // out from the centre of the blast, and up; small pieces fly farthest
      const out = tmp.subVectors(obj.position, from);
      out.y = Math.max(0, out.y);
      if (out.lengthSq() < 1e-4) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      const speed = force * MECH_DEATH.partSpeed * (0.5 + Math.random()) / (0.6 + r * 2.5);
      this.parts.push({
        obj, r,
        vel: new THREE.Vector3(out.x * speed, (5 + Math.random() * 9 + (1 - Math.min(1, r)) * 4) * force, out.z * speed * 0.6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16),
        settled: false,
        burning: Math.random() < MECH_DEATH.burnShare,
      });
    });
  }

  update(dt: number): void {
    if (this.age < 0) return;
    this.age += dt;
    const { dust } = this.deps;
    const t = this.age;
    const at = this.at;

    for (let i = this.lobes.length - 1; i >= 0; i--) {
      const l = this.lobes[i];
      const k = (t - l.start) / l.life;
      if (k >= 1) { this.deps.scene.remove(l.s); (l.s.material as THREE.Material).dispose(); this.lobes.splice(i, 1); continue; }
      l.s.visible = k >= 0;
      if (k < 0) continue;
      const ease = 1 - (1 - k) * (1 - k);
      const size = l.from + (l.to - l.from) * ease;
      l.s.scale.setScalar(size);
      l.s.position.y = l.baseY + size * l.rise;
      (l.s.material as THREE.SpriteMaterial).opacity = Math.min(1, (1 - k) * 1.6);
    }
    if (this.ring) {
      const k = Math.min(1, t / MECH_DEATH.ringLife);
      this.ring.scale.setScalar(4 + MECH_DEATH.blastRadius * 2.4 * (1 - (1 - k) * (1 - k)));
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
      this.ring.visible = k < 1;
    }

    // the stem of the mushroom: puffs shot up from the burning spot, slowing as they climb
    this.smokeT -= dt;
    if (t > 0.1 && t < MECH_DEATH.stemTime && this.smokeT <= 0) {
      this.smokeT = 0.03;
      for (let i = 0; i < 4; i++) {
        tmp.set(at.x + (Math.random() - 0.5) * 1.6, 0.5 + Math.random() * 1.5, at.z + (Math.random() - 0.5) * 1);
        dust.billow(tmp, new THREE.Vector3((Math.random() - 0.5) * 1.2, MECH_DEATH.stemSpeed * (0.8 + Math.random() * 0.4), (Math.random() - 0.5) * 0.6), 1.7 + Math.random() * 0.8, 5 + Math.random() * 2, 0.5, 0.55 + 0.45 * Math.min(1, t / 1.5));
      }
      // a skirt of dust rolling out along the ground
      if (t < 1.2) {
        const side = Math.random() < 0.5 ? -1 : 1;
        tmp.set(at.x, 0.3, at.z);
        dust.billow(tmp, new THREE.Vector3(side * (5 + Math.random() * 5), 0.4, (Math.random() - 0.5) * 3), 1.4 + Math.random(), 3.5, 1.2, 0.4);
      }
    }
    // the cap: where the stem has got to, puffs are thrown out all round and roll over, so it spreads into a mushroom
    this.capT -= dt;
    if (t > MECH_DEATH.capStart && t < MECH_DEATH.capStart + MECH_DEATH.capTime && this.capT <= 0) {
      this.capT = 0.025;
      const top = (MECH_DEATH.stemSpeed / 0.5) * (1 - Math.exp(-0.5 * (t - 0.1)));
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2;
        tmp.set(at.x + Math.cos(a) * 0.8, top + (Math.random() - 0.5) * 1.5, at.z + Math.sin(a) * 0.5);
        const out = MECH_DEATH.capSpread * (0.7 + Math.random() * 0.6);
        dust.billow(tmp, new THREE.Vector3(Math.cos(a) * out, 1.2 + Math.random() * 1.5, Math.sin(a) * out * 0.6), 2.2 + Math.random(), 6 + Math.random() * 2, 0.7, 1);
      }
    }

    this.stepPod(dt);
    this.stepParts(dt);
  }

  /** the cockpit climbs on the mech's last breath, burning, and goes off at the top */
  private stepPod(dt: number): void {
    const pod = this.pod;
    if (!pod) return;
    const { fx, dust } = this.deps;
    pod.t += dt;
    const t = Math.min(pod.t, pod.rise);
    pod.obj.position.y = pod.y0 + pod.vy * t - 0.5 * MECH_DEATH.podGravity * t * t;
    const k = t / pod.rise;
    pod.obj.quaternion.copy(pod.q0).multiply(tmpQ.setFromEuler(tmpE.set(pod.tilt.x * k, pod.tilt.y * k, pod.tilt.z * k)));
    pod.trail -= dt;
    if (pod.trail <= 0 && pod.t < pod.rise) {
      pod.trail = 0.03;
      tmp.copy(pod.obj.position).addScaledVector(UP, -0.2);
      fx.burst(tmp, 3, 3, FIRE_COLORS, false, 1);
      dust.puff(tmp, 3, 0.8, 0.8, 0.5);
      dust.plume(tmp, 0.9, 3);
    }
    if (pod.t >= pod.rise) this.explodePod(pod);
  }

  /** the second explosion: a smaller fireball in the air, the cockpit torn to pieces that rain down */
  private explodePod(pod: Pod): void {
    const { scene, fx, dust, explosions, shake, blastBuildings } = this.deps;
    const at = pod.obj.position.clone();
    pod.obj.updateMatrixWorld(true);
    this.breakApart(pod.obj, at, 0.8);
    scene.remove(pod.obj);
    this.pod = null;
    explosions.wreckBlast(at, MECH_DEATH.podBlastRadius, MECH_DEATH.podBlastScale, 1.5);
    blastBuildings(at, MECH_DEATH.podBuildingRadius, MECH_DEATH.podBuildingSpeed);
    fx.burst(at, 70, 8, FIRE_COLORS, false, 1.4);
    fx.sparks(at, 80, 10, FIRE_COLORS);
    fx.muzzleFlash(at);
    dust.puff(at, 24, 2, 4, 0.6);
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2, out = 2 + Math.random() * 3;
      dust.billow(at, new THREE.Vector3(Math.cos(a) * out, (Math.random() - 0.3) * 2.5, Math.sin(a) * out * 0.6), 1.6 + Math.random(), 4 + Math.random() * 2, 0.9, 0.8);
    }
    shake(at, MECH_DEATH.podShake);
    this.fireball(at, at.y - MECH_DEATH.podFireballSize * 0.35, MECH_DEATH.podFireballSize, 6);
  }

  private stepParts(dt: number): void {
    const { fx, dust, floor } = this.deps;
    for (const f of this.parts) {
      const { obj, vel, spin } = f;
      if (f.burning && this.age < MECH_DEATH.burnTime && Math.random() < dt * 14) {
        fx.burst(obj.position, 2, 1.8, FIRE_COLORS, false, 0.9);
        dust.plume(obj.position, 0.5, 2.4);
      }
      if (f.settled) continue;
      vel.y -= GRAVITY * dt;
      obj.position.addScaledVector(vel, dt);
      obj.rotation.x += spin.x * dt;
      obj.rotation.y += spin.y * dt;
      obj.rotation.z += spin.z * dt;
      const ground = floor(obj.position.x, obj.position.z, obj.position.y + 1) + f.r * 0.6;
      if (obj.position.y > ground) continue;
      obj.position.y = ground;
      const impact = -vel.y;
      if (impact > BOUNCE_MIN) {
        vel.y = impact * 0.35;
        vel.x *= 0.6; vel.z *= 0.6;
        spin.multiplyScalar(0.6);
        if (impact > 4) dust.puff(obj.position, 2, 0.5, 0.8);
      } else {
        vel.y = 0;
      }
      const drag = Math.exp(-GROUND_DRAG * dt);
      vel.x *= drag; vel.z *= drag;
      if (vel.y === 0) spin.multiplyScalar(Math.exp(-5 * dt));
      if (vel.y === 0 && Math.hypot(vel.x, vel.z) < 0.15) f.settled = true;
    }
  }

  /** Remove the fireball, the cockpit and the parts (a new life, a restart). */
  clear(): void {
    const { scene } = this.deps;
    for (const l of this.lobes) { scene.remove(l.s); (l.s.material as THREE.Material).dispose(); }
    this.lobes.length = 0;
    if (this.ring) { scene.remove(this.ring); (this.ring.material as THREE.Material).dispose(); this.ring = null; }
    if (this.pod) { scene.remove(this.pod.obj); this.pod = null; }
    for (const f of this.parts) scene.remove(f.obj);
    this.parts.length = 0;
    this.age = -1;
  }
}
