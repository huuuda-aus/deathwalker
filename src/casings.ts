import * as THREE from 'three';
import { CASING } from './config';
import type { FloorFn } from './debris';

const GEO = new THREE.CylinderGeometry(CASING.radius, CASING.radius, CASING.length, 6);
const MAT = new THREE.MeshStandardMaterial({ color: 0xe0b050, metalness: 0.9, roughness: 0.3, emissive: 0x3a2200 });
const GRAVITY = 9;
const UP = new THREE.Vector3(0, 1, 0);

interface Casing {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  age: number;
  life: number;
  /** on the ground: no more physics, just waiting to fade */
  rest: boolean;
}

const dummy = new THREE.Object3D();
const axisU = new THREE.Vector3();
const axisV = new THREE.Vector3();

/**
 * Spent bullet casings: small brass cylinders that fly out of the guns, tumble, bounce on whatever they land on, lie there
 * for a few seconds and shrink away. One instanced mesh, a few hundred at most, so a fast-firing gun can litter the ground.
 */
export class Casings {
  private readonly mesh: THREE.InstancedMesh;
  private readonly live: Casing[] = [];

  constructor(scene: THREE.Scene, private readonly floor: FloorFn) {
    this.mesh = new THREE.InstancedMesh(GEO, MAT, CASING.max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Throw a casing from `at` roughly along `dir` (unit), turned a random amount within the cone of `CASING.spreadDeg`. */
  eject(at: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.live.length >= CASING.max) return;
    // a random direction in a cone round `dir`
    const cosMax = Math.cos(THREE.MathUtils.degToRad(CASING.spreadDeg));
    const cosT = 1 - Math.random() * (1 - cosMax), sinT = Math.sqrt(1 - cosT * cosT), phi = Math.random() * Math.PI * 2;
    axisU.crossVectors(dir, Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    axisV.crossVectors(dir, axisU);
    const vel = new THREE.Vector3()
      .addScaledVector(dir, cosT)
      .addScaledVector(axisU, sinT * Math.cos(phi))
      .addScaledVector(axisV, sinT * Math.sin(phi))
      .multiplyScalar(CASING.speedMin + Math.random() * (CASING.speedMax - CASING.speedMin));
    this.live.push({
      pos: at.clone(), vel,
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40),
      age: 0, life: CASING.lifeMin + Math.random() * (CASING.lifeMax - CASING.lifeMin), rest: false,
    });
  }

  update(dt: number): void {
    const { live, mesh, floor } = this;
    for (let i = live.length - 1; i >= 0; i--) {
      const c = live[i];
      c.age += dt;
      if (c.age >= c.life) { live[i] = live[live.length - 1]; live.pop(); continue; }
      if (c.rest) continue;
      c.vel.y -= GRAVITY * dt;
      c.pos.addScaledVector(c.vel, dt);
      c.rot.x += c.spin.x * dt; c.rot.y += c.spin.y * dt; c.rot.z += c.spin.z * dt;
      const ground = floor(c.pos.x, c.pos.z, c.pos.y + 0.3) + CASING.radius;
      if (c.pos.y > ground) continue;
      c.pos.y = ground;
      if (c.vel.y < -CASING.restSpeed) {
        // a bounce: it loses most of its energy and spin
        c.vel.y *= -CASING.bounce;
        c.vel.x *= 0.6; c.vel.z *= 0.6;
        c.spin.multiplyScalar(0.6);
      } else {
        c.rest = true;
        c.rot.set(Math.PI / 2, Math.random() * Math.PI * 2, 0);      // lying on its side
      }
    }
    let n = 0;
    for (const c of live) {
      // it shrinks away in its last moments
      const fade = Math.min(1, (c.life - c.age) / CASING.fadeTime);
      dummy.position.copy(c.pos);
      dummy.rotation.copy(c.rot);
      dummy.scale.setScalar(fade);
      dummy.updateMatrix();
      mesh.setMatrixAt(n++, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.live.length = 0;
    this.mesh.count = 0;
  }
}
