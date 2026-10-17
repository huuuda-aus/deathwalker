import * as THREE from 'three';
import { PointPool } from './pointpool';

const MAX_PARTICLES = 600;

interface Particle { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; size: number }

const MAX_SPARKS = 400;

interface Spark { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; px: number; color: THREE.Color }

/** Height of the highest solid surface under (x, z) at or below y; 0 = ground. */
export type SurfaceFn = (x: number, z: number, y: number) => number;

/** Tiny 1-2 px sparks for bullet impacts: one Points draw call, additive, size in screen pixels. */
class PixelSparks {
  private material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec3 aColor;
      uniform float uPixelRatio; varying vec3 vColor;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio;
        vColor = aColor;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() { gl_FragColor = vec4(vColor, 1.0); }`,
  });

  private pool: PointPool<Spark>;

  constructor(scene: THREE.Scene) {
    this.pool = new PointPool(scene, MAX_SPARKS, this.material, { position: 3, aColor: 3, aSize: 1 });
  }

  surface: SurfaceFn | null = null;

  setPixelRatio(r: number): void { this.material.uniforms.uPixelRatio.value = r; }

  emit(at: THREE.Vector3, count: number, speed: number, colors: number[]): void {
    for (let i = 0; i < count && !this.pool.full; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      const life = 0.15 + Math.random() * 0.25;
      this.pool.push({
        pos: at.clone().add(new THREE.Vector3(0, 0, 0.05)), // nudge toward camera so surfaces don't clip it
        vel: new THREE.Vector3(Math.cos(a) * s, Math.random() * s * 0.8 + 0.5, (Math.random() - 0.3) * s * 0.6),
        life, maxLife: life, px: Math.random() < 0.5 ? 1 : 2,
        color: new THREE.Color(colors[(Math.random() * colors.length) | 0]),
      });
    }
  }

  update(dt: number): void {
    const { items } = this.pool;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i];
      p.life -= dt;
      if (p.life <= 0) { this.pool.removeAt(i); continue; }
      p.vel.y -= 12 * dt;
      const floor = this.surface ? this.surface(p.pos.x, p.pos.z, p.pos.y) : 0;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < floor + 0.02) { p.pos.y = floor + 0.02; p.vel.y *= -0.3; }
    }
    this.pool.upload((p, i, a) => {
      const f = p.life / p.maxLife; // additive: fading to black = fading out
      a.position.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
      a.aColor.setXYZ(i, p.color.r * f, p.color.g * f, p.color.b * f);
      a.aSize.setX(i, p.px);
    });
  }
}

export class Fx {
  private sparkSystem: PixelSparks;
  private particles: Particle[] = [];
  private mesh: THREE.InstancedMesh;
  private flashLight = new THREE.PointLight(0xffb060, 0, 14, 2);
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ fog: false }),
      MAX_PARTICLES,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    scene.add(this.flashLight);
    this.sparkSystem = new PixelSparks(scene);
  }

  private surface: SurfaceFn | null = null;

  /** Let particles land on building floors, not just the ground. */
  setSurface(fn: SurfaceFn): void { this.surface = fn; this.sparkSystem.surface = fn; }

  setPixelRatio(r: number): void { this.sparkSystem.setPixelRatio(r); }

  /** Subtle bullet-impact sparks: a few 1-2 px specks. */
  sparks(at: THREE.Vector3, count: number, speed: number, colors: number[]): void {
    this.sparkSystem.emit(at, count, speed, colors);
  }

  muzzleFlash(at: THREE.Vector3): void {
    this.flashLight.position.copy(at);
    this.flashLight.intensity = 25;
  }

  /** Spark burst. colors: hex values picked at random per particle. */
  burst(at: THREE.Vector3, count: number, speed: number, colors: number[], gravity = true): void {
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const s = speed * (0.3 + Math.random());
      const life = 0.3 + Math.random() * 0.5;
      this.particles.push({
        pos: at.clone(),
        vel: new THREE.Vector3(Math.cos(a) * s, up * s * 0.9 + (gravity ? 1 : 0), Math.sin(a) * s * 0.6),
        life, maxLife: life, size: 0.05 + Math.random() * 0.1,
      });
      this.mesh.setColorAt(this.particles.length - 1, this.tmpColor.setHex(colors[(Math.random() * colors.length) | 0]));
    }
  }

  update(dt: number): void {
    this.sparkSystem.update(dt);
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 300);

    // update particles; keep colour index aligned by swap-remove
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        const last = this.particles.length - 1;
        if (i !== last) {
          this.particles[i] = this.particles[last];
          this.mesh.getColorAt(last, this.tmpColor);
          this.mesh.setColorAt(i, this.tmpColor);
        }
        this.particles.pop();
        continue;
      }
      p.vel.y -= 14 * dt;
      const floor = this.surface ? this.surface(p.pos.x, p.pos.z, p.pos.y) : 0;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < floor + 0.02) { p.pos.y = floor + 0.02; p.vel.y *= -0.3; p.vel.x *= 0.7; }
    }
    this.mesh.count = this.particles.length;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const s = p.size * (p.life / p.maxLife);
      this.dummy.position.copy(p.pos);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
