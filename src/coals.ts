import * as THREE from 'three';
import { PointPool } from './pointpool';
import type { SurfaceFn } from './fx';

const GRAVITY = 16;
const MAX_COALS = 700;

interface Coal { pos: THREE.Vector3; vel: THREE.Vector3; heat: number; tau: number; px: number; rest: boolean }

/**
 * Hot coals thrown out of a shot barrel. They are real little bodies: gravity, bounce on whatever
 * floor is under them, friction, then they lie there glowing and cool from white-yellow through
 * orange to a dull red before going out. One Points draw call, additive, HDR so the hot ones bloom.
 */
export class Coals {
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

  private pool: PointPool<Coal>;

  constructor(scene: THREE.Scene) {
    this.pool = new PointPool(scene, MAX_COALS, this.material, { position: 3, aHeat: 1, aSize: 1 });
  }

  setPixelRatio(r: number): void { this.material.uniforms.uPixelRatio.value = r; }

  emit(at: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.pool.full) return;
    this.pool.push({
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
    const { items } = this.pool;
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i];
      c.heat -= dt / c.tau;
      if (c.heat <= 0.03) { this.pool.removeAt(i); continue; }
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
    this.pool.upload((c, i, a) => {
      a.position.setXYZ(i, c.pos.x, c.pos.y, c.pos.z);
      a.aHeat.setX(i, c.heat);
      a.aSize.setX(i, c.px);
    });
  }
}

