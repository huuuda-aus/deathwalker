import * as THREE from 'three';
import type { Building } from './building';
import type { Dust } from './debris';

/** Teardrop flame: white-hot at the barrel (right edge), orange, fading red at the tip (left). */
export function flameTexture(): THREE.CanvasTexture {
  const W = 256, H = 96;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(W, 0, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,235,1)');
  grad.addColorStop(0.22, 'rgba(255,215,110,0.97)');
  grad.addColorStop(0.55, 'rgba(255,120,25,0.65)');
  grad.addColorStop(1, 'rgba(190,40,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // soft elongated mask: wide at the muzzle, tapering to the tip
  g.globalCompositeOperation = 'destination-in';
  g.setTransform((W * 0.98) / (H / 2), 0, 0, 1, W, H / 2);
  const mask = g.createRadialGradient(0, 0, 0, 0, 0, H / 2);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.5, 'rgba(255,255,255,0.75)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = mask;
  g.fillRect(-W, -H, 2 * W, 2 * H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,200,110,0.8)');
  r.addColorStop(0.6, 'rgba(255,110,20,0.25)');
  r.addColorStop(1, 'rgba(255,60,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


let sharedFlame: THREE.CanvasTexture | null = null;
let sharedGlow: THREE.CanvasTexture | null = null;
const flameTex = (): THREE.CanvasTexture => (sharedFlame ??= flameTexture());
const glowTex = (): THREE.CanvasTexture => (sharedGlow ??= glowTexture());

const BARREL_MAT = new THREE.MeshStandardMaterial({ color: 0x3b2a22, roughness: 0.7, metalness: 0.55 });
const RING_MAT = new THREE.MeshStandardMaterial({ color: 0x1c1512, roughness: 0.6, metalness: 0.6 });
const BARREL_H = 0.46, BARREL_R = 0.14;
/** widest a flame sheet may be: well inside the barrel's diameter, leaving room for the lean */
const MAX_FLAME_W = 0.2;

interface Tongue {
  group: THREE.Group;
  mat: THREE.MeshBasicMaterial;
  meshes: THREE.Mesh[];
  base: number;     // nominal height
  phase: number;
  /** flicker state: current values ease toward targets that are re-rolled a few times a second */
  h: number; hT: number; b: number; bT: number; w: number; wT: number; timer: number;
}

/** Surface height under (x, z) at or below y; 0 = ground. */
export type SurfaceFn = (x: number, z: number, y: number) => number;

const GRAVITY = 16;
const MAX_COALS = 700;

/**
 * Hot coals thrown out of a shot barrel. They are real little bodies: gravity, bounce on whatever
 * floor is under them, friction, then they lie there glowing and cool from white-yellow through
 * orange to a dull red before going out. One Points draw call, additive, HDR so the hot ones bloom.
 */
export class Coals {
  private items: { pos: THREE.Vector3; vel: THREE.Vector3; heat: number; tau: number; px: number; rest: boolean }[] = [];
  private geo = new THREE.BufferGeometry();
  private posAttr = new THREE.BufferAttribute(new Float32Array(MAX_COALS * 3), 3);
  private heatAttr = new THREE.BufferAttribute(new Float32Array(MAX_COALS), 1);
  private sizeAttr = new THREE.BufferAttribute(new Float32Array(MAX_COALS), 1);
  private material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aHeat; attribute float aSize;
      uniform float uPixelRatio; varying float vHeat;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio;
        vHeat = aHeat;
      }`,
    fragmentShader: /* glsl */ `
      varying float vHeat;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float core = smoothstep(1.0, 0.15, r);
        vec3 cold = vec3(0.22, 0.025, 0.0), warm = vec3(2.2, 0.8, 0.18), hot = vec3(3.2, 2.2, 0.9);
        vec3 c = vHeat < 0.5 ? mix(cold, warm, vHeat * 2.0) : mix(warm, hot, (vHeat - 0.5) * 2.0);
        gl_FragColor = vec4(c, core);
      }`,
  });
  surface: SurfaceFn | null = null;
  /** is this point inside a wall, floor or pillar? */
  solid: ((x: number, y: number, z: number) => boolean) | null = null;

  constructor(scene: THREE.Scene) {
    for (const a of [this.posAttr, this.heatAttr, this.sizeAttr]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aHeat', this.heatAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setDrawRange(0, 0);
    const pts = new THREE.Points(this.geo, this.material);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  setPixelRatio(r: number): void { this.material.uniforms.uPixelRatio.value = r; }

  emit(at: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.items.length >= MAX_COALS) return;
    this.items.push({
      pos: at.clone(), vel: vel.clone(), heat: 0.85 + Math.random() * 0.15,
      tau: 3 + Math.random() * 4, px: 2.5 + Math.random() * 2.5, rest: false,
    });
  }

  /** A burst thrown mostly along `dir` (horizontal), with plenty going up and some sideways. */
  burst(at: THREE.Vector3, dir: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      const s = 1.2 + Math.random() * 3.6;
      const v = new THREE.Vector3(
        dir.x * s + (Math.random() - 0.5) * 2.4,
        1.0 + Math.random() * 3.2,
        dir.z * s + (Math.random() - 0.5) * 2.4,
      );
      this.emit(at, v);
    }
  }

  update(dt: number): void {
    const solid = this.solid;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      c.heat -= dt / c.tau;
      if (c.heat <= 0.03) { this.items[i] = this.items[this.items.length - 1]; this.items.pop(); continue; }
      if (c.rest) {
        // lying on something: if that goes (a floor shot away), fall again
        if (c.pos.y > 0.02 && solid && !solid(c.pos.x, c.pos.y - 0.02, c.pos.z)) c.rest = false;
        else continue;
      }
      // two sub-steps; each axis is moved separately so a coal slides along a wall instead of passing through it
      const h = dt / 2;
      const buried = solid ? solid(c.pos.x, c.pos.y, c.pos.z) : false;   // already inside something: let it out freely
      for (let sub = 0; sub < 2; sub++) {
        c.vel.y -= GRAVITY * h;
        const nx = c.pos.x + c.vel.x * h;
        if (solid && !buried && solid(nx, c.pos.y, c.pos.z)) { c.vel.x *= -0.35; c.vel.z *= 0.85; } else c.pos.x = nx;
        const nz = c.pos.z + c.vel.z * h;
        if (solid && !buried && solid(c.pos.x, c.pos.y, nz)) { c.vel.z *= -0.35; c.vel.x *= 0.85; } else c.pos.z = nz;
        const ny = c.pos.y + c.vel.y * h;
        if (solid && !buried && solid(c.pos.x, ny, c.pos.z)) {
          // landed on a floor top, or hit a ceiling
          const impact = c.vel.y;
          c.vel.y = Math.abs(impact) > 0.8 ? -impact * 0.35 : 0;
          const f = Math.max(0, 1 - 7 * dt);
          c.vel.x *= f; c.vel.z *= f;
          if (impact < 0 && c.vel.lengthSq() < 0.02) { c.vel.set(0, 0, 0); c.rest = true; break; }
        } else c.pos.y = ny;
        if (c.pos.y <= 0.012) {
          c.pos.y = 0.012;
          const impact = -c.vel.y;
          c.vel.y = impact > 0.8 ? impact * 0.35 : 0;
          const f = Math.max(0, 1 - 7 * dt);          // sliding friction
          c.vel.x *= f; c.vel.z *= f;
          if (c.vel.lengthSq() < 0.02) { c.vel.set(0, 0, 0); c.rest = true; break; }
        }
      }
    }
    for (let i = 0; i < this.items.length; i++) {
      const c = this.items[i];
      this.posAttr.setXYZ(i, c.pos.x, c.pos.y, c.pos.z);
      this.heatAttr.setX(i, c.heat);
      this.sizeAttr.setX(i, c.px);
    }
    this.geo.setDrawRange(0, this.items.length);
    this.posAttr.needsUpdate = this.heatAttr.needsUpdate = this.sizeAttr.needsUpdate = true;
  }
}

/** What a barrel needs from the world when it is shot. */
export interface BarrelContext {
  coals: Coals;
  fx: { sparks(at: THREE.Vector3, n: number, speed: number, colors: number[]): void };
  dust: Dust;
  /** is this point inside a wall, floor or pillar? */
  solid: (x: number, y: number, z: number) => boolean;
}

/**
 * An oil barrel with a fire burning in it: a few flickering flame tongues, an ember glow and rising smoke.
 * Shoot it and it topples in the direction of the bullet (a rigid rod tipping about its base edge, then
 * thumping down and sliding), throwing out hot coals that obey gravity; the spilled oil burns down.
 */
export class FireBarrel {
  readonly group = new THREE.Group();
  /** the barrel itself (tips over); the flames stay upright and follow its mouth */
  private body = new THREE.Group();
  private flames = new THREE.Group();
  /** centre of the fire (the barrel's mouth), world space */
  readonly top = new THREE.Vector3();
  /** 1 = burning, 0 = out (fades when the building is down or the spilled oil burns off) */
  burn = 1;
  gone = false;
  shot = false;
  private tongues: Tongue[] = [];
  private glow: THREE.Sprite;
  private embers: THREE.Mesh;
  private emberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.1, 0.35), toneMapped: false });
  private t = Math.random() * 100;
  private smokeT = Math.random();
  private glowS = 1; private glowT = 1; private emberS = 1; private emberT = 1; private glowTimer = 0;
  // toppling
  private dir = new THREE.Vector3(1, 0, 0);
  private theta = 0;
  /** how far it can tip before it meets a wall (pi/2 = lies flat) */
  private thetaMax = Math.PI / 2;
  private omega = 0;
  private landed = false;
  private slideV = 0;
  private slide = new THREE.Vector3();
  private flash = 0;
  private spillAcc = 0;
  private box = new THREE.Box3();

  /**
   * @param pos base of the barrel (world space, standing on the floor)
   * @param strength 1 for the front row, lower for the second row
   */
  constructor(pos: THREE.Vector3, readonly building: Building, readonly strength: number) {
    this.group.position.copy(pos);
    this.top.set(pos.x, pos.y + BARREL_H, pos.z);
    this.group.add(this.body, this.flames);
    this.flames.position.y = BARREL_H - 0.02;

    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(BARREL_R, BARREL_R * 0.94, BARREL_H, 14, 1, true), BARREL_MAT);
    mesh.position.y = BARREL_H / 2;
    mesh.castShadow = true;
    this.body.add(mesh);
    for (const y of [0.08, 0.23, 0.38]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(BARREL_R * 1.04, BARREL_R * 1.04, 0.025, 14), RING_MAT);
      ring.position.y = y;
      this.body.add(ring);
    }
    // glowing embers just below the rim: the fire inside
    this.embers = new THREE.Mesh(new THREE.CircleGeometry(BARREL_R * 0.92, 14).rotateX(-Math.PI / 2), this.emberMat);
    this.embers.position.y = BARREL_H - 0.03;
    this.body.add(this.embers);

    // flame tongues, each two crossed sheets so they read from any angle
    const specs = [{ h: 0.46, x: 0, z: 0 }, { h: 0.32, x: 0.02, z: 0.015 }, { h: 0.28, x: -0.02, z: -0.015 }];
    for (const sp of specs) {
      const group = new THREE.Group();
      group.position.set(sp.x, 0, sp.z);
      const mat = new THREE.MeshBasicMaterial({
        map: flameTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false, side: THREE.DoubleSide, color: new THREE.Color(3, 2, 1),
      });
      const meshes: THREE.Mesh[] = [];
      for (const yaw of [0, Math.PI / 2]) {
        const sheet = new THREE.Group();
        sheet.rotation.y = yaw;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        m.rotation.z = -Math.PI / 2;   // the texture's hot base (its right edge) points down
        sheet.add(m);
        group.add(sheet);
        meshes.push(m);
      }
      this.flames.add(group);
      this.tongues.push({ group, mat, meshes, base: sp.h, phase: Math.random() * 6.28, h: 1, hT: 1, b: 1, bT: 1, w: 0.55, wT: 0.55, timer: Math.random() * 0.2 });
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      toneMapped: false, color: new THREE.Color(2.4, 1.3, 0.5),
    }));
    this.glow.position.y = 0.1;
    this.flames.add(this.glow);
  }

  /** Light strength this fire contributes right now (0..~1). */
  get light(): number { return (this.burn + this.flash) * this.strength; }

  /** Distance along the ray to this barrel (Infinity if missed, or if it has already been shot). */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    if (this.shot || this.gone) return Infinity;
    const p = this.group.position;
    this.box.min.set(p.x - BARREL_R - 0.02, p.y, p.z - BARREL_R - 0.02);
    this.box.max.set(p.x + BARREL_R + 0.02, p.y + BARREL_H + 0.04, p.z + BARREL_R + 0.02);
    return ray.intersectBox(this.box, out) ? out.distanceTo(ray.origin) : Infinity;
  }

  /** Knock it over along `dir` (the bullet's direction) and throw the coals. */
  shoot(dir: THREE.Vector3, ctx: BarrelContext): void {
    if (this.shot) return;
    this.shot = true;
    this.dir.set(dir.x, 0, dir.z);
    if (this.dir.lengthSq() < 1e-4) this.dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    this.dir.normalize();
    this.theta = 0.06;
    this.omega = 1.4;
    this.thetaMax = this.freeTilt(ctx);
    this.flash = 1;
    this.embers.visible = false;
    const mouth = this.mouthWorld();
    ctx.coals.burst(mouth, this.dir, 55);
    ctx.fx.sparks(mouth, 8, 3.5, [0xffd080, 0xffa040, 0xffffff]);
    ctx.dust.puff(mouth, 3, 0.4, 1.2);
  }

  /** How far the barrel can tip toward `dir` before its side meets a wall or pillar. */
  private freeTilt(ctx: BarrelContext): number {
    const base = this.group.position;
    // distance to the first solid point along the fall, checked at a few heights
    let wall = Infinity;
    for (const y of [0.06, 0.2, 0.34, 0.46]) {
      for (let d = 0.02; d <= 0.8; d += 0.02) {
        if (ctx.solid(base.x + this.dir.x * d, base.y + y, base.z + this.dir.z * d)) { wall = Math.min(wall, d); break; }
      }
    }
    if (wall >= BARREL_R + BARREL_H + 0.03) return Math.PI / 2;
    // the mouth's reach along the fall at tilt t: R(1 - cos t) + H sin t
    const room = Math.max(0.05, wall - 0.03);
    let best = 0.12;
    for (let t = 0.12; t <= Math.PI / 2; t += 0.02) {
      if (BARREL_R * (1 - Math.cos(t)) + BARREL_H * Math.sin(t) <= room) best = t; else break;
    }
    return best;
  }

  private mouthWorld(): THREE.Vector3 {
    return this.group.position.clone().add(this.mouthLocal());
  }

  /** The mouth of the barrel relative to its base, with the tip and the slide applied. */
  private mouthLocal(): THREE.Vector3 {
    const top = new THREE.Vector3(0, BARREL_H, 0);
    if (!this.shot) return top;
    const q = this.tipQuat();
    const pivot = this.dir.clone().multiplyScalar(BARREL_R);
    return pivot.clone().add(top.sub(pivot).applyQuaternion(q)).add(this.slide);
  }

  private tipQuat(): THREE.Quaternion {
    // rotating "up" toward dir is a right-handed turn about (up x dir)
    const axis = new THREE.Vector3(this.dir.z, 0, -this.dir.x);
    return new THREE.Quaternion().setFromAxisAngle(axis, this.theta);
  }

  /** Topple: a rod tipping about the base edge on the side it falls toward. */
  private stepFall(dt: number, ctx: BarrelContext): void {
    if (!this.landed) {
      const K = (3 * GRAVITY) / (2 * BARREL_H);
      this.omega += K * Math.sin(this.theta) * dt;
      this.theta += this.omega * dt;
      // spill burning coals out of the mouth while it tips
      this.spillAcc += dt * 140 * Math.min(1, this.theta / 0.9);
      while (this.spillAcc >= 1) {
        this.spillAcc -= 1;
        const v = new THREE.Vector3(
          this.dir.x * (0.8 + Math.random() * 1.8) + (Math.random() - 0.5) * 1.2,
          0.2 + Math.random() * 1.4,
          this.dir.z * (0.8 + Math.random() * 1.8) + (Math.random() - 0.5) * 1.2,
        );
        ctx.coals.emit(this.mouthWorld(), v);
      }
      if (this.theta >= this.thetaMax) {
        this.theta = this.thetaMax;
        if (this.omega > 1.5) {
          // thump: it rebounds a little and sprays another handful of coals
          ctx.coals.burst(this.mouthWorld(), this.dir, 18);
          this.omega *= -0.18;
        } else {
          this.landed = true;
          this.omega = 0;
          this.slideV = this.thetaMax >= Math.PI / 2 ? 0.9 : 0;   // it skids on a little further, unless it is propped on a wall
        }
      }
    } else if (this.slideV > 0.01) {
      // skid along the floor unless something solid is in the way
      const ahead = this.mouthLocal().add(this.dir.clone().multiplyScalar(0.05 + this.slideV * dt)).add(this.group.position);
      if (ctx.solid(ahead.x, ahead.y, ahead.z)) this.slideV = 0;
      else this.slide.addScaledVector(this.dir, this.slideV * dt);
      this.slideV *= Math.exp(-4 * dt);
    }
    // pose the barrel: rotate about the base edge on the side it falls toward
    const q = this.tipQuat();
    const pivot = this.dir.clone().multiplyScalar(BARREL_R);
    this.body.quaternion.copy(q);
    this.body.position.copy(pivot.clone().sub(pivot.clone().applyQuaternion(q)).add(this.slide));
  }

  update(dt: number, dust: Dust | null, ctx?: BarrelContext): void {
    this.t += dt;
    if (this.building.down && !this.shot) this.burn = Math.max(0, this.burn - dt / 1.4);
    // the fire dies with the floor it stands on
    if (this.building.floorTop(this.group.position.x, this.group.position.y + 0.05) < this.group.position.y - 0.05) this.gone = true;
    this.group.visible = !this.gone;

    if (this.shot && ctx) {
      this.stepFall(dt, ctx);
      this.burn = Math.max(0, this.burn - dt / 9);   // the spilled oil burns down
      this.flash = Math.max(0, this.flash - dt * 3.5);
      const m = this.mouthLocal();
      this.flames.position.set(m.x, m.y - 0.02, m.z);
      this.top.copy(this.group.position).add(m);
    }

    const k = this.burn * this.strength;
    // Flicker: targets are re-rolled about 6 times a second (not every frame) and eased toward,
    // so the flames breathe slowly. The dancing (lean and sway) runs at half speed.
    const ease = 1 - Math.exp(-dt * 7);
    const boost = 1 + this.flash * 1.6;              // the flash when it is hit
    for (const tg of this.tongues) {
      tg.timer -= dt;
      if (tg.timer <= 0) {
        tg.timer = 0.12 + Math.random() * 0.1;
        const dropout = Math.random() < 0.08;
        tg.hT = dropout ? 0.45 : 0.7 + Math.random() * 0.65;
        tg.bT = 0.65 + Math.random() * 0.8;
        tg.wT = 0.45 + 0.25 * Math.random();
      }
      tg.h += (tg.hT - tg.h) * ease;
      tg.b += (tg.bT - tg.b) * ease;
      tg.w += (tg.wT - tg.w) * ease;
      const h = tg.base * tg.h * (0.45 + 0.55 * this.strength) * this.burn * boost;
      // never wider than the barrel's mouth (0.28 across), however tall the flame gets (the hit flash may flare)
      const w = Math.min(h * tg.w, MAX_FLAME_W * boost);
      for (const m of tg.meshes) { m.scale.set(h, w, 1); m.position.y = h / 2; }
      tg.group.rotation.z = Math.sin(this.t * 3.25 + tg.phase) * 0.05 + Math.sin(this.t * 6.5 + tg.phase * 2) * 0.02;
      tg.group.rotation.x = Math.sin(this.t * 2.55 + tg.phase * 1.7) * 0.04;
      const b = tg.b * (0.4 + 0.6 * this.strength) * this.burn * boost;
      tg.mat.color.setRGB(1.6 * b, 1.05 * b, 0.52 * b);
    }
    this.glowTimer -= dt;
    if (this.glowTimer <= 0) {
      this.glowTimer = 0.14 + Math.random() * 0.1;
      this.glowT = 0.7 + 0.5 * Math.random();
      this.emberT = 0.6 + 0.6 * Math.random();
    }
    this.glowS += (this.glowT - this.glowS) * ease;
    this.emberS += (this.emberT - this.emberS) * ease;
    const gs = (0.13 + 0.15 * (this.glowS - 0.7) / 0.5) * (0.5 + 0.5 * this.strength) * this.burn * boost;
    this.glow.scale.set(gs, gs, 1);
    (this.glow.material as THREE.SpriteMaterial).color.setRGB(1.2 * this.glowS * k * boost, 0.65 * k * boost, 0.25 * k * boost);
    const e = this.emberS * k;
    this.emberMat.color.setRGB(1.5 * e, 0.55 * e, 0.18 * e);

    // smoke wisps rising off the fire
    if (dust && this.burn > 0.3) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.smokeT = 0.3 + Math.random() * 0.4;
        dust.puff(new THREE.Vector3(this.top.x, this.top.y + 0.35, this.top.z), 1, 0.22, 0.4);
      }
    }
  }
}

/**
 * A few real lights for the nearest fires. The count is fixed (changing it would recompile every
 * material), so the lights move around to whichever fires are closest to the action.
 */
export class FireLights {
  private lights: THREE.PointLight[] = [];
  private t = 0;

  constructor(scene: THREE.Scene, count = 3) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xff7e30, 0, 7, 2);
      scene.add(l);
      this.lights.push(l);
    }
  }

  update(dt: number, barrels: FireBarrel[], focusX: number): void {
    this.t += dt;
    const live = barrels
      .filter((b) => !b.gone && b.burn > 0.05 && Math.abs(b.top.x - focusX) < 30)
      .sort((a, b) => Math.abs(a.top.x - focusX) - Math.abs(b.top.x - focusX));
    this.lights.forEach((l, i) => {
      const b = live[i];
      if (!b) { l.intensity = 0; return; }
      l.position.set(b.top.x, b.top.y + 0.3, b.top.z + 0.3);
      // slow breathing, not per-frame noise
      l.intensity = (10 + 3 * Math.sin(this.t * 1.9 + i * 1.7) + 2 * Math.sin(this.t * 3.1 + i * 0.9)) * b.light;
    });
  }
}
