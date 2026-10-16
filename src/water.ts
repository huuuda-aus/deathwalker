import * as THREE from 'three';

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Puddle { x: number; z: number; rx: number; rz: number; rot: number }

/** Fraction of the nominal puddle radius that is guaranteed to be water (the drawn edge is a bit ragged). */
const WET_CORE = 0.82;

/**
 * Shallow puddles on the ground: ragged-edged dark water that mirrors a hint of the sky at grazing angles,
 * glints with the nearby fire and muzzle flashes, and rings with raindrops. One instanced quad per puddle;
 * the CPU keeps the same shapes so feet can tell whether they are standing in water.
 */
export class Puddles {
  /** shared by every chunk's mesh */
  static readonly uniforms = {
    uTime: { value: 0 },
    uRain: { value: 0 },
    uLight0: { value: new THREE.Vector4() },
    uLight1: { value: new THREE.Vector4() },
    uFogColor: { value: new THREE.Color(0x030d0b) },
    uFogRange: { value: new THREE.Vector2(28, 62) },
  };

  private static material = new THREE.ShaderMaterial({
    uniforms: Puddles.uniforms,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute vec4 aPuddle;     // x, z, rx, rz
      attribute vec2 aRot;        // rotation, seed
      varying vec2 vLocal;        // ellipse-space coordinates (1 = nominal edge)
      varying vec3 vWorld;
      varying float vSeed;
      void main() {
        vec2 l = position.xz * 2.0 * 1.3;
        vLocal = l;
        vSeed = aRot.y;
        float c = cos(aRot.x), s = sin(aRot.x);
        vec2 e = l * aPuddle.zw;
        vec2 w = vec2(c * e.x - s * e.y, s * e.x + c * e.y) + aPuddle.xy;
        vWorld = vec3(w.x, 0.006, w.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vLocal;
      varying vec3 vWorld;
      varying float vSeed;
      uniform float uTime, uRain;
      uniform vec4 uLight0, uLight1;
      uniform vec3 uFogColor;
      uniform vec2 uFogRange;

      float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      // raindrop rings: a drop lands somewhere in each cell every second or so and a ring expands from it
      float ripples(vec2 p) {
        float a = 0.0;
        vec2 cell = floor(p / 0.55);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 c = cell + vec2(float(i), float(j));
          float h1 = hash(c), h2 = hash(c + 17.3);
          float live = step(h2, 0.12 + 0.6 * uRain);
          vec2 centre = (c + vec2(hash(c + 3.1), hash(c + 9.7))) * 0.55;
          float ph = fract(uTime * (0.55 + 0.6 * h1) + h1 * 7.0);
          float d = length(p - centre);
          float ring = smoothstep(0.035, 0.0, abs(d - ph * 0.3)) * (1.0 - ph) * (1.0 - ph);
          a += ring * live;
        }
        return a;
      }

      void main() {
        float r = length(vLocal);
        float edge = 1.0 + 0.14 * (noise(vLocal * 2.4 + vSeed * 13.0) - 0.5) * 2.0;   // ragged, always beyond the wet core
        float mask = smoothstep(edge, edge - 0.2, r);
        if (mask <= 0.001) discard;
        float depth = 1.0 - smoothstep(0.0, 0.9, r);

        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        float fres = pow(1.0 - clamp(toCam.y / dist, 0.0, 1.0), 3.0);

        // dark water; at grazing angles it shows the sky: deep blue with the green horizon glow
        vec3 water = vec3(0.004, 0.007, 0.011) * (0.6 + 0.6 * depth);
        vec3 sky = vec3(0.005, 0.012, 0.022) + vec3(0.0, 0.018, 0.011) * smoothstep(0.35, 1.0, fres);
        vec3 col = water + sky * (0.25 + 1.2 * fres);

        // fire and muzzle light glinting on the surface
        vec3 r0 = vWorld - uLight0.xyz, r1 = vWorld - uLight1.xyz;
        col += vec3(1.0, 0.55, 0.22) * (uLight0.w / (1.0 + 3.0 * dot(r0, r0)) + uLight1.w / (1.0 + 3.0 * dot(r1, r1))) * (0.35 + fres);

        col += vec3(0.2, 0.3, 0.42) * ripples(vWorld.xz) * (0.4 + fres);

        float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
        gl_FragColor = vec4(mix(col, uFogColor, fog), mask * (0.82 + 0.15 * depth) * (1.0 - fog));
      }`,
  });

  /** Build the puddles for one chunk of the world (deterministic per chunk index). */
  static build(chunkIndex: number, chunkSize: number): { mesh: THREE.Mesh; list: Puddle[] } {
    const rng = mulberry32(chunkIndex * 104729 + 7);
    const list: Puddle[] = [];
    const x0 = chunkIndex * chunkSize;
    for (let i = 0; i < 44; i++) {
      const inLane = rng() < 0.75;
      list.push({
        x: x0 + rng() * chunkSize,
        z: inLane ? -3.2 + rng() * 8.4 : -13 + rng() * 9.5,
        rx: 0.5 + rng() * 1.9,
        rz: 0.3 + rng() * 0.85,
        rot: (rng() - 0.5) * 0.7,
      });
    }
    const g = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    const data = new Float32Array(list.length * 4), rot = new Float32Array(list.length * 2);
    list.forEach((p, i) => {
      data.set([p.x, p.z, p.rx, p.rz], i * 4);
      rot.set([p.rot, rng()], i * 2);
    });
    g.setAttribute('aPuddle', new THREE.InstancedBufferAttribute(data, 4));
    g.setAttribute('aRot', new THREE.InstancedBufferAttribute(rot, 2));
    g.instanceCount = list.length;
    const mesh = new THREE.Mesh(g, Puddles.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return { mesh, list };
  }

  /** 0 outside water, up to 1 at the centre of a puddle. */
  static depthAt(list: Puddle[], x: number, z: number): number {
    let best = 0;
    for (const p of list) {
      if (Math.abs(x - p.x) > p.rx * 1.3 + 0.5) continue;
      const dx = x - p.x, dz = z - p.z, c = Math.cos(p.rot), s = Math.sin(p.rot);
      const ex = (c * dx + s * dz) / p.rx, ez = (-s * dx + c * dz) / p.rz;
      const r = Math.hypot(ex, ez);
      if (r < WET_CORE) best = Math.max(best, 1 - r / WET_CORE);
    }
    return best;
  }
}

// ---- splashes -------------------------------------------------------------------------------

const MAX_DROPS = 500;
const MAX_RINGS = 80;
const G = 16;

/** Water thrown up by feet: droplets with real gravity, plus expanding rings on the surface. */
export class SplashFx {
  private drops: { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; px: number }[] = [];
  private dropGeo = new THREE.BufferGeometry();
  private dropPos = new THREE.BufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
  private dropCol = new THREE.BufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
  private dropSize = new THREE.BufferAttribute(new Float32Array(MAX_DROPS), 1);
  private dropMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec3 aColor; uniform float uPixelRatio; varying vec3 vColor;
      void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uPixelRatio; vColor = aColor; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(vColor, smoothstep(1.0, 0.3, r)); }`,
  });

  private rings: { x: number; z: number; age: number; life: number; size: number }[] = [];
  private ringAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 4), 4);
  private ringMesh: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    for (const a of [this.dropPos, this.dropCol, this.dropSize]) a.setUsage(THREE.DynamicDrawUsage);
    this.dropGeo.setAttribute('position', this.dropPos);
    this.dropGeo.setAttribute('aColor', this.dropCol);
    this.dropGeo.setAttribute('aSize', this.dropSize);
    this.dropGeo.setDrawRange(0, 0);
    const pts = new THREE.Points(this.dropGeo, this.dropMat);
    pts.frustumCulled = false;
    scene.add(pts);

    const g = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    this.ringAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aRing', this.ringAttr);
    g.instanceCount = 0;
    this.ringMesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      vertexShader: /* glsl */ `
        attribute vec4 aRing;    // x, z, age (0..1), size
        varying vec2 vUv; varying float vAge;
        void main() {
          vUv = position.xz * 2.0; vAge = aRing.z;
          float rad = aRing.w * (0.2 + 0.8 * aRing.z);
          vec3 w = vec3(aRing.x + position.x * 2.0 * rad, 0.014, aRing.y + position.z * 2.0 * rad);
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying float vAge;
        void main() {
          float r = length(vUv);
          float ring = smoothstep(0.7, 0.88, r) * (1.0 - smoothstep(0.9, 1.0, r));
          gl_FragColor = vec4(vec3(0.5, 0.65, 0.9), ring * pow(1.0 - vAge, 1.5) * 0.75);
        }`,
    }));
    this.ringMesh.frustumCulled = false;
    scene.add(this.ringMesh);
  }

  setPixelRatio(r: number): void { this.dropMat.uniforms.uPixelRatio.value = r; }

  droplet(at: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.drops.length >= MAX_DROPS) return;
    const life = 0.7 + Math.random() * 0.8;
    this.drops.push({ pos: at.clone(), vel: vel.clone(), life, maxLife: life, px: 2 + Math.random() * 2.2 });
  }

  /** @param delay seconds before the ring starts */
  ring(x: number, z: number, size: number, delay = 0): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    const life = 0.55 + Math.random() * 0.25;
    this.rings.push({ x, z, age: -delay / life, life, size });
  }

  /** A foot coming down hard: a crown of droplets thrown up and outward, and a ring. */
  plant(at: THREE.Vector3, footVel: THREE.Vector3, strength: number): void {
    const n = 12 + Math.round(20 * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.6 + Math.random() * 1.8 * (0.5 + strength);
      this.droplet(
        new THREE.Vector3(at.x, 0.03, at.z),
        new THREE.Vector3(Math.cos(a) * s + footVel.x * 0.12, 1.2 + Math.random() * 2.8 * (0.5 + strength), Math.sin(a) * s + footVel.z * 0.12),
      );
    }
    this.ring(at.x, at.z, 0.45 + 0.4 * strength);
    if (strength > 0.5) this.ring(at.x, at.z, 0.3 + 0.3 * strength, 0.09);
  }

  /** A foot pulling out: water flung up and back with it. */
  lift(at: THREE.Vector3, footVel: THREE.Vector3, strength: number): void {
    const n = 5 + Math.round(8 * strength);
    for (let i = 0; i < n; i++) {
      this.droplet(
        new THREE.Vector3(at.x + (Math.random() - 0.5) * 0.12, 0.05, at.z + (Math.random() - 0.5) * 0.12),
        new THREE.Vector3(footVel.x * 0.25 + (Math.random() - 0.5) * 0.9, 0.9 + Math.random() * 1.8, footVel.z * 0.25 + (Math.random() - 0.5) * 0.9),
      );
    }
  }

  /** A foot skimming through the water: spray thrown ahead of it. */
  wade(at: THREE.Vector3, footVel: THREE.Vector3): void {
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      this.droplet(
        new THREE.Vector3(at.x, 0.04, at.z),
        new THREE.Vector3(footVel.x * 0.35 + (Math.random() - 0.5) * 0.8, 0.8 + Math.random() * 1.6, footVel.z * 0.35 + (Math.random() - 0.5) * 0.8),
      );
    }
  }

  update(dt: number): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      d.vel.y -= G * dt;
      d.pos.addScaledVector(d.vel, dt);
      if (d.life <= 0 || d.pos.y < 0.01) {
        if (d.pos.y < 0.01 && Math.random() < 0.18) this.ring(d.pos.x, d.pos.z, 0.1 + Math.random() * 0.1);
        this.drops[i] = this.drops[this.drops.length - 1];
        this.drops.pop();
      }
    }
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const f = Math.min(1, d.life / d.maxLife * 2);
      this.dropPos.setXYZ(i, d.pos.x, d.pos.y, d.pos.z);
      this.dropCol.setXYZ(i, 0.55 * f, 0.78 * f, 1.1 * f);
      this.dropSize.setX(i, d.px);
    }
    this.dropGeo.setDrawRange(0, this.drops.length);
    this.dropPos.needsUpdate = this.dropCol.needsUpdate = this.dropSize.needsUpdate = true;

    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].age += dt / this.rings[i].life;
      if (this.rings[i].age >= 1) this.rings.splice(i, 1);
    }
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      // a ring that has not started yet has no size
      this.ringAttr.setXYZW(i, r.x, r.z, Math.max(0, r.age), r.age < 0 ? 0 : r.size);
    }
    (this.ringMesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.rings.length;
    this.ringAttr.needsUpdate = true;
  }
}

interface FootSpec { toe: number; cool: number; wadeT: number }

/**
 * Watches the mech's feet (its kinematic colliders): when a foot comes down, pulls out of, or skims
 * through a puddle it asks SplashFx for the matching splash. Strength follows the foot's speed.
 */
export class FootSplasher {
  private feet: FootSpec[] = [{ toe: 1, cool: 0, wadeT: 0 }, { toe: 4, cool: 0, wadeT: 0 }];
  private tmp = new THREE.Vector3();

  update(dt: number, colliders: { pos: THREE.Vector3; vel: THREE.Vector3 }[], depthAt: (x: number, z: number) => number, fx: SplashFx): void {
    for (const f of this.feet) {
      const toe = colliders[f.toe];
      f.cool -= dt; f.wadeT -= dt;
      const depth = depthAt(toe.pos.x, toe.pos.z);
      if (depth <= 0) continue;
      const y = toe.pos.y, vy = toe.vel.y;
      const hs = Math.hypot(toe.vel.x, toe.vel.z);
      this.tmp.set(toe.vel.x, 0, toe.vel.z);
      if (y < 0.14 && vy < -0.6 && f.cool <= 0) {
        fx.plant(toe.pos, this.tmp, Math.min(1, (-vy + 0.4) / 4.5) * (0.5 + 0.5 * depth));
        f.cool = 0.12;
      } else if (y < 0.2 && vy > 1.2 && f.cool <= 0) {
        fx.lift(toe.pos, this.tmp, Math.min(1, vy / 4.5));
        f.cool = 0.12;
      } else if (y < 0.16 && hs > 2.5 && f.wadeT <= 0) {
        fx.wade(toe.pos, this.tmp);
        f.wadeT = 0.05;
      }
    }
  }
}
