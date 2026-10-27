import * as THREE from 'three';
import type { Collider } from './debris';
import { flameTexture, glowTexture } from './fireTextures';
import { sfx } from './sfx';

/** the mech's main colour: gunmetal */
const METAL = new THREE.MeshStandardMaterial({ color: 0x59616b, roughness: 0.32, metalness: 0.75 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x0c0c10, roughness: 0.45, metalness: 0.5 });
const GLOW = new THREE.MeshStandardMaterial({ color: 0xffa040, emissive: 0xff7a00, emissiveIntensity: 2 });

export function setMechEnvironment(env: THREE.Texture): void {
  for (const [m, k] of [[METAL, 0.45], [DARK, 0.12]] as const) { m.envMap = env; m.envMapIntensity = k; m.needsUpdate = true; }
}

/** Uniform scale of the whole mech model (model is authored ~4 units tall). */
export const MECH_SCALE = 0.5;
/**
 * Walkable depth range (world z) of the mech and the vehicles (zMin/zMax), and of the infantry (soldierZMin/soldierZMax): the same in the
 * city; in the desert the walkway is bounded by low stone walls and the infantry may also stand outside them, behind them (see rockWall.ts).
 * Front-row buildings stand behind ZMIN.
 */
export const LANE = { zMin: -3.5, zMax: 4.5, soldierZMin: -3.5, soldierZMax: 4.5, wallBands: [] as [number, number][] };

/** a z to stand at, moved out of the stone walls' bands (where the walls may stand) to the nearer side of it */
export function clearOfWalls(z: number): number {
  for (const [a, b] of LANE.wallBands) if (z > a && z < b) return z > (a + b) / 2 ? b + 0.1 : a - 0.1;
  return z;
}
/** Distance of reticle from the cockpit pivot (along x) below which the guns can't fire. */
const MIN_AIM_DX = 1.0 * MECH_SCALE;

// Digitigrade legs with a backward-pointing knee, solved with two-bone IK so feet plant on the ground.
// A heavy walker: long, slow strides (a low step rate), a low foot lift, and most of the cycle spent with the foot planted.
const L1 = 1.25;           // thigh
const L2 = 1.35;           // shin
const STEP = 1.5;          // half stride: foot travels +-STEP about the hip
const LIFT = 0.6;          // swing foot lift
const STANCE = 0.6;        // fraction of the gait cycle with the foot on the ground
const STRIDE = (2 * STEP) / STANCE; // body travel per gait cycle (model units)
const PELVIS_Y = 2.4;
const HIP_DROP = 0.2;      // hip joint below pelvis origin
const ANKLE_H = 0.2;       // ankle height above ground when planted
const LEG_Z = 1.15;
/** the body's give when a foot lands: the impulse it is knocked down with, and the spring that brings it back (stiffness, damping) */
const SETTLE_KICK = 1.6;
const SETTLE_K = 150;
const SETTLE_C = 11;
/** the lower half turns toward the walking direction: how fast it eases (1/s), its top speed (rad/s), and the speed below which it stops following */
const TURN_EASE = 9;
const TURN_RATE = 7;
const TURN_MIN_SPEED = 0.3;
/** how fast the cockpit follows the aim (1/s): about a 40 ms lag */
const AIM_EASE = 25;
/** standing still this long, it turns back to face left */
const IDLE_RETURN_DELAY = 0.5;

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Cylinder; axis: 'z' (joint pins), 'x' (barrels) or 'y' (pistons, stacks). */
function cyl(r: number, len: number, mat: THREE.Material, axis: 'x' | 'y' | 'z', x = 0, y = 0, z = 0): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, len, 16);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** One barrel's muzzle fire: two crossed flame planes, a hot glow sprite and a local light. */
interface Flame { root: THREE.Group; planes: THREE.Mesh[]; glow: THREE.Sprite; light: THREE.PointLight }

/** Collider radii in world units (the model is scaled by MECH_SCALE). */
const R_ANKLE = 0.3, R_TOE = 0.3, R_KNEE = 0.26, R_BODY = 0.55;

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
  offset: number;
  /** where in the gait cycle it was last frame (unwrapped), to catch the moment it plants */
  prevU: number;
}

/**
 * Procedural placeholder mech. Origin is at foot level; ~4 units tall.
 * The body (pelvis + legs) always faces -x (left). Only the cockpit rotates:
 * it carries two rigid guns, and turns (yaw + pitch) to face the reticle,
 * limited to the forward (-x) hemisphere.
 */
export class Mech {
  readonly root = new THREE.Group();
  /** One muzzle per gun, fired alternately. */
  readonly muzzles: THREE.Object3D[] = [];
  /** and the ejection port of each gun, where its casings come out (they are thrown outward, up and back) */
  readonly ports: THREE.Object3D[] = [];
  /** False while the reticle is behind the mech: guns park sideways and can't fire. */
  canFire = true;
  /** Kinematic spheres (ankle, toe, knee per leg + body) that shove rubble. Updated in place. */
  readonly colliders: Collider[] = [];
  /** set by the game: guns are firing this frame (drives the muzzle fire) */
  firing = false;
  /** set by the game: a foot has come down; called for the toe and the heel with the world position under each and the strength 0..1 (dust, a small jolt) */
  onStep: ((at: THREE.Vector3, strength: number) => void) | null = null;
  /** set by the game: a foot has come down, once per step: under the middle of the sole (world), which way the foot points (0 = toe to the left), the strength 0..1 (a footprint, a cloud of dust) */
  onPrint: ((at: THREE.Vector3, yaw: number, strength: number) => void) | null = null;
  /** set by the game: the height of the ground at a world (x, z); the feet follow it up and down the dunes */
  ground: ((x: number, z: number) => number) | null = null;
  private flames: Flame[] = [];
  /** the cockpit pod with its guns (it turns to face the reticle) */
  get cockpitModel(): THREE.Object3D { return this.cockpit; }
  /** world-space cockpit pivot, used for aiming */
  readonly pivotWorld = new THREE.Vector3();

  private pelvis = new THREE.Group();
  /** the lower half: hip frame and legs. It turns about the vertical to face the way the mech walks; the cockpit above does not turn with it */
  private lower = new THREE.Group();
  /** which way the lower half faces: 0 = left (-x), PI/2 = toward the camera, PI = right */
  private bodyYaw = 0;
  private idleTime = 0;
  private tmpW = new THREE.Vector3();
  private tmpX = new THREE.Vector3();
  private cockpit = new THREE.Group();
  private legs: Leg[] = [];
  /** gait cycles completed (fractional) */
  private cycle = 0;
  /** how far the body has been pushed down by a footfall (model units), and how fast it is moving */
  private settle = 0;
  /** where the cockpit is actually pointing: it eases toward the aim so a jump in the aim point (the reticle crossing from a near building to a far one) turns it fast but smoothly */
  private aimYaw = 0;
  private aimPitch = 0;
  private aimReady = false;
  private settleV = 0;

  constructor() {
    this.root.scale.setScalar(MECH_SCALE);
    this.pelvis.position.y = PELVIS_Y;
    this.root.add(this.pelvis);

    // pelvis: wide hip frame
    this.pelvis.add(this.lower);
    this.lower.add(box(1.9, 0.6, 2.9, DARK));
    this.lower.add(box(1.3, 0.4, 1.8, METAL, 0, -0.4, 0));
    this.lower.add(box(2.1, 0.22, 2.3, METAL, 0, 0.32, 0));       // belly plate under the cockpit

    for (const [z, offset] of [[LEG_Z, 0], [-LEG_Z, 0.5]] as const) this.legs.push(this.buildLeg(z, offset));
    for (const r of [R_ANKLE, R_TOE, R_KNEE, R_ANKLE, R_TOE, R_KNEE, R_BODY]) {
      this.colliders.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), r });
    }

    // cockpit pod: local -x is forward (gun direction)
    this.cockpit.position.y = 1.3;
    this.pelvis.add(this.cockpit);
    this.cockpit.add(box(1.9, 0.9, 1.5, METAL));
    const nose = box(0.8, 0.7, 1.3, METAL, -1.05, -0.05, 0);
    nose.rotation.z = 0.5;
    this.cockpit.add(nose);
    this.cockpit.add(box(1.0, 0.25, 1.0, DARK, 0.1, -0.55, 0));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), DARK);
    dome.position.set(-0.2, 0.45, 0);
    dome.castShadow = true;
    this.cockpit.add(dome);
    this.cockpit.add(box(0.12, 0.14, 0.7, GLOW, -0.72, 0.62, 0));
    // rear exhaust stacks and antenna
    for (const z of [-0.4, 0.4]) this.cockpit.add(cyl(0.12, 0.6, DARK, 'y', 0.85, 0.7, z));
    this.cockpit.add(cyl(0.025, 1.0, DARK, 'y', 0.6, 1.1, -0.55));

    // two hard-mounted guns on the cockpit flanks
    for (const z of [-1.0, 1.0]) {
      this.cockpit.add(box(1.0, 0.5, 0.45, DARK, -0.5, 0, z));
      this.cockpit.add(cyl(0.09, 1.4, METAL, 'x', -1.5, 0, z));
      this.cockpit.add(cyl(0.16, 0.14, DARK, 'x', -1.15, 0, z));
      this.cockpit.add(cyl(0.16, 0.14, DARK, 'x', -1.55, 0, z));
      const muzzle = new THREE.Object3D();
      muzzle.position.set(-2.25, 0, z);
      this.cockpit.add(muzzle);
      this.muzzles.push(muzzle);
      const port = new THREE.Object3D();
      port.position.set(-0.85, 0.2, z);
      this.cockpit.add(port);
      this.ports.push(port);
      this.flames.push(this.buildFlame(muzzle));
    }
  }

  private buildFlame(muzzle: THREE.Object3D): Flame {
    const root = new THREE.Group();
    root.visible = false;
    const tex = flameTexture();
    // HDR colour (> 1) so the flame blooms; additive so overlapping layers add up
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      toneMapped: false, side: THREE.DoubleSide, color: new THREE.Color(3.2, 2.2, 1.2),
    });
    const planes: THREE.Mesh[] = [];
    for (const roll of [0, Math.PI / 2]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.rotation.x = roll;
      root.add(m);
      planes.push(m);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      toneMapped: false, color: new THREE.Color(3, 2, 1),
    }));
    root.add(glow);
    const light = new THREE.PointLight(0xff9a3c, 0, 9, 2);
    root.add(light);
    muzzle.add(root);
    return { root, planes, glow, light };
  }

  /** Fast, random flicker while firing: length, width, brightness and the odd dropout change every frame. */
  private updateFlames(): void {
    for (const f of this.flames) {
      f.root.visible = this.firing;
      f.light.intensity = this.firing ? 25 + Math.random() * 70 : 0;
      if (!this.firing) continue;
      const dropout = Math.random() < 0.12;
      const len = (dropout ? 0.5 : 1.7 + Math.random() * 1.5);           // model units (the mech is scaled 0.5)
      const wid = (dropout ? 0.2 : 0.55 + Math.random() * 0.45);
      for (const p of f.planes) {
        p.scale.set(len, wid, 1);
        p.position.x = -len / 2;                                          // base at the barrel tip, extends forward (-x)
      }
      const k = 0.7 + Math.random() * 0.9;
      (f.planes[0].material as THREE.MeshBasicMaterial).color.setRGB(3.2 * k, 2.2 * k, 1.2 * k);
      const gs = dropout ? 0.5 : 1.1 + Math.random() * 0.9;
      f.glow.scale.set(gs, gs, 1);
      f.glow.position.x = -0.15;
      (f.glow.material as THREE.SpriteMaterial).color.setRGB(3 * k, 2 * k, 1 * k);
    }
  }

  /**
   * A stout leg: a massive armoured thigh and a thick shin on big cylindrical joint pins (hip, knee, ankle), with the
   * knee pointing backward, ending in a broad flat foot. Heavy plates, paired hydraulics and a wide stance carry the weight.
   */
  private buildLeg(z: number, offset: number): Leg {
    const hip = new THREE.Group();
    hip.position.set(0, -HIP_DROP, z);
    hip.add(cyl(0.45, 1.15, DARK, 'z'));                                // hip joint
    hip.add(box(1.1, 0.7, 1.0, DARK, 0, 0.1, 0));                       // hip housing
    hip.add(box(0.85, L1, 0.8, METAL, 0, -L1 / 2, 0));                  // thigh
    hip.add(box(1.0, 0.5, 0.9, METAL, 0, -0.35, 0));                    // upper thigh armour
    hip.add(box(0.25, L1 * 0.75, 0.88, DARK, -0.54, -L1 * 0.5, 0));     // front armour plate
    for (const dz of [-0.3, 0.3]) hip.add(cyl(0.09, L1 * 0.8, METAL, 'y', 0.5, -L1 * 0.45, dz)); // hydraulic pistons

    const knee = new THREE.Group();
    knee.position.y = -L1;
    knee.add(cyl(0.4, 1.0, DARK, 'z'));                                 // knee joint, points backward
    knee.add(box(0.5, 0.55, 0.9, DARK, 0.4, 0.02, 0));                  // knee guard
    knee.add(box(0.7, L2, 0.72, METAL, 0, -L2 / 2, 0));                 // shin
    knee.add(box(0.85, 0.55, 0.8, METAL, 0, -0.45, 0));                 // calf armour
    knee.add(box(0.22, L2 * 0.65, 0.78, DARK, 0.46, -L2 * 0.5, 0));     // rear armour plate
    knee.add(box(0.2, L2 * 0.5, 0.76, DARK, -0.43, -L2 * 0.4, 0));      // shin guard
    hip.add(knee);

    const foot = new THREE.Group();
    foot.position.y = -L2;
    foot.add(cyl(0.3, 0.95, DARK, 'z'));                                // ankle joint
    foot.add(box(0.85, 0.42, 0.9, DARK, 0.02, -0.02, 0));               // ankle housing
    foot.add(box(1.9, 0.26, 1.05, METAL, -0.3, -0.07, 0));              // broad sole plate
    const toeCap = box(0.55, 0.2, 1.05, DARK, -1.3, -0.1, 0);           // upturned toe
    toeCap.rotation.z = 0.3;
    foot.add(toeCap);
    foot.add(box(0.45, 0.22, 1.1, DARK, 0.68, -0.09, 0));               // heel block
    knee.add(foot);

    this.lower.add(hip);
    return { hip, knee, foot, offset, prevU: 0 };
  }

  /** Turn the lower half smoothly toward `target` (or back to facing left once it has been idle a moment). */
  private turnBody(dt: number, target: number | null): void {
    if (target === null) {
      this.idleTime += dt;
      if (this.idleTime < IDLE_RETURN_DELAY) return;
      target = 0;
    } else {
      this.idleTime = 0;
    }
    const diff = THREE.MathUtils.euclideanModulo(target - this.bodyYaw + Math.PI, Math.PI * 2) - Math.PI;   // shortest way round
    const step = diff * (1 - Math.exp(-dt * TURN_EASE));
    const limit = TURN_RATE * dt;
    this.bodyYaw += THREE.MathUtils.clamp(step, -limit, limit);
    this.lower.rotation.y = this.bodyYaw;
  }

  /** Place the ankle at (dx, dy) relative to the hip and bend the reverse knee. */
  private solveLeg(leg: Leg, dx: number, dy: number): void {
    const reach = L1 + L2 - 0.02;
    const dist = Math.hypot(dx, dy);
    if (dist > reach) { dx *= reach / dist; dy *= reach / dist; }
    const D = Math.hypot(dx, dy);
    const a = Math.acos(THREE.MathUtils.clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
    const t1 = Math.atan2(dx, -dy) + a; // plus: the knee bends backward (+x), as on the original walker
    const sx = dx - L1 * Math.sin(t1);
    const sy = dy + L1 * Math.cos(t1);
    const t2 = Math.atan2(sx, -sy);
    leg.hip.rotation.z = t1;
    leg.knee.rotation.z = t2 - t1;
    leg.foot.rotation.z = -t2; // keep the foot flat
  }

  /**
   * @param vx,vz walking velocity (world units/s); vx < 0 = forward (left), vz < 0 = away from camera
   * @param aim 3D world point the guns should point at
   */
  update(dt: number, vx: number, vz: number, aim: THREE.Vector3): void {
    // The lower half turns toward the player's depth axis when walking toward or away from the camera (the mech's
    // left/right), but never to face backward: walking backward keeps the base facing forward and the gait runs in
    // reverse, so the reverse knees always point the right way. Standing still, it swings back to face left.
    const speed = Math.hypot(vx, vz);
    this.turnBody(dt, speed > TURN_MIN_SPEED ? Math.atan2(vz, Math.abs(vx)) : null);
    // moving against the way the base faces: play the stride backward so the feet still plant
    const along = -vx * Math.cos(this.bodyYaw) + vz * Math.sin(this.bodyYaw);
    const dCycle = ((along < 0 ? -speed : speed) / MECH_SCALE * dt) / STRIDE;
    this.cycle += dCycle;
    /** seconds a foot spends in the air each stride, at the current pace */
    const swing = ((1 - STANCE) * dt) / Math.max(1e-4, Math.abs(dCycle));
    const amp = Math.min(1, speed / MECH_SCALE / 1.5);

    // the body rides lower and sways deeper than a light machine would, and gives a little each time a foot lands
    const bob = Math.abs(Math.sin(this.cycle * Math.PI * 2)) * 0.09 * amp;
    const h = Math.min(dt, 1 / 30);
    this.settleV += (-SETTLE_K * this.settle - SETTLE_C * this.settleV) * h;
    this.settle += this.settleV * h;
    this.pelvis.position.y = PELVIS_Y - bob + this.settle;
    const hipHeight = this.pelvis.position.y - HIP_DROP - ANKLE_H;

    this.root.updateMatrixWorld(true);
    for (const leg of this.legs) {
      const u = this.cycle + leg.offset;
      // forward the foot lands as the cycle comes round to 0; played in reverse, as it comes back down to the end of its stance
      const planted = u > leg.prevU ? Math.floor(u) > Math.floor(leg.prevU) : Math.floor(u - STANCE) < Math.floor(leg.prevU - STANCE);
      // the foot leaves the ground as the stance ends (forward) or as the cycle comes back round to 0 (reverse): servos whine, then it plants
      const lifted = u > leg.prevU ? Math.floor(u - STANCE) > Math.floor(leg.prevU - STANCE) : Math.floor(u) < Math.floor(leg.prevU);
      if (lifted && amp > 0.15) sfx.servoBurst(this.root.position.x, amp, swing);
      if (planted && amp > 0.15) {
        sfx.step(this.root.position.x, amp);
        this.settleV -= SETTLE_KICK * amp;
        if (this.onStep) {
          // under the toe and under the heel
          this.root.updateMatrixWorld(true);
          for (const x of [-1.0, 0.6]) this.onStep(leg.foot.localToWorld(this.tmpV.set(x, -ANKLE_H, 0)), amp);
        }
        this.onPrint?.(leg.foot.localToWorld(this.tmpV.set(-0.3, -ANKLE_H, 0)), this.bodyYaw, amp);
      }
      leg.prevU = u;
      const p = (((u % 1) + 1) % 1);
      let fx: number, lift: number;
      if (p < STANCE) {
        fx = -STEP + 2 * STEP * (p / STANCE);
        lift = 0;
      } else {
        const v = (p - STANCE) / (1 - STANCE);
        fx = STEP - 2 * STEP * v * v * (3 - 2 * v);
        lift = Math.sin(Math.PI * v) * LIFT;
      }
      // the sole lands on the ground where it is (up or down the slope from the body), tilted to lie on it
      let rise = 0, tilt = 0;
      if (this.ground) {
        const e = 0.3;
        const foot = this.lower.localToWorld(this.tmpV.set(fx * amp, 0, leg.hip.position.z));
        const ahead = this.lower.localToWorld(this.tmpW.set(fx * amp + e, 0, leg.hip.position.z));
        const behind = this.lower.localToWorld(this.tmpX.set(fx * amp - e, 0, leg.hip.position.z));
        const h = this.ground(foot.x, foot.z);
        rise = THREE.MathUtils.clamp((h - this.root.position.y) / MECH_SCALE, -1.4, 1.4);
        const along = (this.ground(ahead.x, ahead.z) - this.ground(behind.x, behind.z)) / (2 * e);   // ground rise per world unit along the foot's +x
        tilt = Math.atan(THREE.MathUtils.clamp(along, -1, 1)) * (1 - Math.min(1, lift / (LIFT * 0.5)));
      }
      this.solveLeg(leg, fx * amp, -hipHeight + lift * amp + rise);
      leg.foot.rotation.z += tilt;
    }

    // Cockpit aim. Forward is -x; yaw turns toward +z (camera), pitch lifts the guns.
    // Euler order YZX = Ry * Rz: pitch first, then yaw about the vertical.
    this.root.updateMatrixWorld(true);
    this.cockpit.getWorldPosition(this.pivotWorld);
    const dx = aim.x - this.pivotWorld.x;
    const dy = aim.y - this.pivotWorld.y;
    const dz = aim.z - this.pivotWorld.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.canFire = -dx >= MIN_AIM_DX;
    const yaw = THREE.MathUtils.clamp(Math.atan2(dz, -dx), -Math.PI / 2, Math.PI / 2);
    const pitch = -Math.asin(THREE.MathUtils.clamp(dy / len, -1, 1));
    if (!this.aimReady) { this.aimYaw = yaw; this.aimPitch = pitch; this.aimReady = true; }
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * AIM_EASE);
    this.aimYaw += (yaw - this.aimYaw) * k;
    this.aimPitch += (pitch - this.aimPitch) * k;
    this.cockpit.rotation.set(0, this.aimYaw, this.aimPitch, 'YZX');

    this.updateColliders(dt);
    this.updateFlames();
  }

  private prevReady = false;
  private tmpV = new THREE.Vector3();

  private updateColliders(dt: number): void {
    this.root.updateMatrixWorld(true);
    const p = this.tmpV;
    let i = 0;
    const put = (v: THREE.Vector3): void => {
      const col = this.colliders[i++];
      if (this.prevReady && dt > 0) col.vel.subVectors(v, col.pos).multiplyScalar(1 / dt);
      col.pos.copy(v);
    };
    for (const leg of this.legs) {
      put(leg.foot.getWorldPosition(p));
      put(leg.foot.localToWorld(p.set(-0.7, -0.1, 0)));
      put(leg.knee.getWorldPosition(p));
    }
    put(this.pelvis.getWorldPosition(p));
    this.prevReady = true;
  }
}
