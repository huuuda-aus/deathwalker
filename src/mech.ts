import * as THREE from 'three';
import type { Collider } from './debris';
import { flameTexture, glowTexture } from './fireTextures';

const METAL = new THREE.MeshStandardMaterial({ color: 0x9ea3ac, roughness: 0.3, metalness: 0.7 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x0c0c10, roughness: 0.45, metalness: 0.5 });
const GLOW = new THREE.MeshStandardMaterial({ color: 0xffa040, emissive: 0xff7a00, emissiveIntensity: 2 });

export function setMechEnvironment(env: THREE.Texture): void {
  for (const [m, k] of [[METAL, 0.45], [DARK, 0.12]] as const) { m.envMap = env; m.envMapIntensity = k; m.needsUpdate = true; }
}

/** Uniform scale of the whole mech model (model is authored ~4 units tall). */
export const MECH_SCALE = 0.5;
/** Walkable depth range (world z). Front-row buildings stand behind ZMIN. */
export const LANE = { zMin: -3.5, zMax: 4.5 };
/** Distance of reticle from the cockpit pivot (along x) below which the guns can't fire. */
const MIN_AIM_DX = 1.0 * MECH_SCALE;

// Digitigrade ("chicken walker") legs, solved with two-bone IK so feet plant on the ground.
const L1 = 1.2;            // thigh
const L2 = 1.3;            // shin
const STEP = 0.75;         // half stride: foot travels +-STEP about the hip
const LIFT = 0.45;         // swing foot lift
const STANCE = 0.55;       // fraction of the gait cycle with the foot on the ground
const STRIDE = (2 * STEP) / STANCE; // body travel per gait cycle (model units)
const PELVIS_Y = 2.1;
const HIP_DROP = 0.2;      // hip joint below pelvis origin
const ANKLE_H = 0.2;       // ankle height above ground when planted
const LEG_Z = 1.0;

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
const R_ANKLE = 0.22, R_TOE = 0.22, R_KNEE = 0.2, R_BODY = 0.5;

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
  offset: number;
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
  /** False while the reticle is behind the mech: guns park sideways and can't fire. */
  canFire = true;
  /** Kinematic spheres (ankle, toe, knee per leg + body) that shove rubble. Updated in place. */
  readonly colliders: Collider[] = [];
  /** set by the game: guns are firing this frame (drives the muzzle fire) */
  firing = false;
  private flames: Flame[] = [];
  /** world-space cockpit pivot, used for aiming */
  readonly pivotWorld = new THREE.Vector3();

  private pelvis = new THREE.Group();
  private cockpit = new THREE.Group();
  private legs: Leg[] = [];
  /** gait cycles completed (fractional) */
  private cycle = 0;

  constructor() {
    this.root.scale.setScalar(MECH_SCALE);
    this.pelvis.position.y = PELVIS_Y;
    this.root.add(this.pelvis);

    // pelvis: wide hip frame
    this.pelvis.add(box(1.7, 0.5, 1.9, DARK));
    this.pelvis.add(box(1.0, 0.35, 1.2, METAL, 0, -0.3, 0));

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

  private buildLeg(z: number, offset: number): Leg {
    const hip = new THREE.Group();
    hip.position.set(0, -HIP_DROP, z);
    hip.add(cyl(0.38, 0.55, DARK, 'z'));                       // hip joint
    hip.add(box(0.5, L1, 0.42, METAL, 0, -L1 / 2, 0));          // thigh
    hip.add(box(0.2, L1 * 0.6, 0.5, DARK, -0.3, -L1 * 0.5, 0)); // front armour plate
    hip.add(cyl(0.06, L1 * 0.7, METAL, 'y', 0.3, -L1 * 0.45, 0.28)); // hydraulic piston

    const knee = new THREE.Group();
    knee.position.y = -L1;
    knee.add(cyl(0.32, 0.6, DARK, 'z'));                        // knee joint, points forward
    knee.add(box(0.3, L2, 0.3, METAL, 0, -L2 / 2, 0));          // shin
    knee.add(box(0.18, L2 * 0.55, 0.4, DARK, 0.2, -L2 * 0.45, 0));
    hip.add(knee);

    const foot = new THREE.Group();
    foot.position.y = -L2;
    foot.add(cyl(0.2, 0.45, DARK, 'z'));                        // ankle
    foot.add(box(0.45, 0.2, 0.6, DARK, 0.2, -0.1, 0));          // heel
    foot.add(box(0.95, 0.16, 0.2, METAL, -0.45, -0.12, 0));     // centre toe
    foot.add(box(0.8, 0.16, 0.18, METAL, -0.4, -0.12, 0.25));   // side toes
    foot.add(box(0.8, 0.16, 0.18, METAL, -0.4, -0.12, -0.25));
    knee.add(foot);

    this.pelvis.add(hip);
    return { hip, knee, foot, offset };
  }

  /** Place the ankle at (dx, dy) relative to the hip and bend the reverse knee. */
  private solveLeg(leg: Leg, dx: number, dy: number): void {
    const reach = L1 + L2 - 0.02;
    const dist = Math.hypot(dx, dy);
    if (dist > reach) { dx *= reach / dist; dy *= reach / dist; }
    const D = Math.hypot(dx, dy);
    const a = Math.acos(THREE.MathUtils.clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
    const t1 = Math.atan2(dx, -dy) - a; // minus: knee bends forward (-x)
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
    // Gait advances with ground distance covered; reverses when walking backward.
    // Side-steps (depth walking) shuffle the legs at a reduced rate.
    const forwardSpeed = (-vx + Math.abs(vz) * 0.6) / MECH_SCALE;
    this.cycle += (forwardSpeed * dt) / STRIDE;
    const amp = Math.min(1, Math.hypot(vx, vz) / MECH_SCALE / 1.5);

    const bob = Math.abs(Math.sin(this.cycle * Math.PI * 2)) * 0.06 * amp;
    this.pelvis.position.y = PELVIS_Y - bob;
    const hipHeight = this.pelvis.position.y - HIP_DROP - ANKLE_H;

    for (const leg of this.legs) {
      const p = (((this.cycle + leg.offset) % 1) + 1) % 1;
      let fx: number, lift: number;
      if (p < STANCE) {
        fx = -STEP + 2 * STEP * (p / STANCE);
        lift = 0;
      } else {
        const v = (p - STANCE) / (1 - STANCE);
        fx = STEP - 2 * STEP * v * v * (3 - 2 * v);
        lift = Math.sin(Math.PI * v) * LIFT;
      }
      this.solveLeg(leg, fx * amp, -hipHeight + lift * amp);
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
    this.cockpit.rotation.set(0, yaw, pitch, 'YZX');

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
      put(leg.foot.localToWorld(p.set(-0.5, -0.1, 0)));
      put(leg.knee.getWorldPosition(p));
    }
    put(this.pelvis.getWorldPosition(p));
    this.prevReady = true;
  }
}
