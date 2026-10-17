import * as THREE from 'three';
import { PointPool } from './pointpool';

const MAX_DUST = 1200;

interface Puff { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; size0: number; size1: number; drag: number; alpha: number; dark: number; windK: number }

/** Soft smoke/dust puffs: one Points draw call with per-particle size and alpha. */
export class Dust {
  private material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // dust colour, 25% darker than the original 0x6a7a88
    uniforms: { uScale: { value: 500 }, uColor: { value: new THREE.Color(0x6a7a88).multiplyScalar(0.75) } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aAlpha; attribute float aDark;
      uniform float uScale; varying float vAlpha; varying float vDark;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale / -mv.z;
        vAlpha = aAlpha;
        vDark = aDark;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vAlpha; varying float vDark;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.1, d) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(uColor, vec3(0.012, 0.014, 0.016), vDark), a);
      }`,
  });
  private pool: PointPool<Puff>;
  /** wind speed toward -x (units/s); the older a cloud, the more it is carried along */
  windSpeed = 0;

  constructor(scene: THREE.Scene) {
    this.pool = new PointPool(scene, MAX_DUST, this.material, { position: 3, aSize: 1, aAlpha: 1, aDark: 1 });
  }

  /** @param viewportHeightPx drawing-buffer height, @param fovDeg vertical fov */
  setViewport(viewportHeightPx: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  /** @param dark 0 = the usual grey dust, 1 = near black */
  puff(at: THREE.Vector3, count: number, size: number, spread = 1.5, dark = 0): void {
    for (let i = 0; i < count && !this.pool.full; i++) {
      const life = 0.8 + Math.random() * 1.2;
      this.pool.push({
        pos: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * size, (Math.random() - 0.5) * size, (Math.random() - 0.5) * size)),
        vel: new THREE.Vector3((Math.random() - 0.5) * spread, Math.random() * spread * 0.8, Math.random() * spread * 0.5),
        life, maxLife: life, size0: size * 0.6, size1: size * (1.8 + Math.random()), drag: 1.8, alpha: 0.55, dark, windK: 0.9,
      });
    }
  }

  /** A slow, lingering cloud (rising ruin smoke): drifts up and sideways for `life` seconds, thinning as it spreads. */
  smoke(at: THREE.Vector3, size: number, life: number): void {
    if (this.pool.full) return;
    this.pool.push({
      pos: at.clone(),
      // up, and out toward the camera and to the sides
      vel: new THREE.Vector3((Math.random() - 0.5) * 1.4, 0.7 + Math.random() * 0.9, 0.8 + Math.random() * 1.2),
      life, maxLife: life, size0: size * 0.7, size1: size * (2 + Math.random()), drag: 0.25, alpha: 0.6, dark: 1, windK: 2.2,
    });
  }

  update(dt: number): void {
    const { items } = this.pool;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i];
      p.life -= dt;
      if (p.life <= 0) { this.pool.removeAt(i); continue; }
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      p.pos.x -= this.windSpeed * p.windK * (1 - p.life / p.maxLife + 0.15) * dt;
    }
    this.pool.upload((p, i, a) => {
      const k = 1 - p.life / p.maxLife;
      a.position.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
      a.aSize.setX(i, p.size0 + (p.size1 - p.size0) * k);
      a.aDark.setX(i, p.dark);
      a.aAlpha.setX(i, p.alpha * (1 - k) * Math.min(1, k * 8));
    });
  }
}
