import * as THREE from 'three';
import type { Wind } from './wind';

const COUNT = 36;
/** region around the camera the litter lives in (world units) */
const X_SPAN = 24;
const Z_MIN = -7, Z_MAX = 6;

interface Piece {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  size: number;
  paper: boolean;
  phase: number;
  lift: number;
  /** each piece has its own drag, gust timing and grey so they never move as a flock */
  speedMul: number;
  gustOffset: number;
  grey: number;
  /** seconds to wait (off-screen) before blowing in again */
  delay: number;
}

/**
 * Scarce leaves and scraps of paper blown along by the wind, only to sell the wind.
 * Flat double-sided quads that tumble and flutter, lift in gusts and skitter along the ground.
 */
export class Litter {
  private pieces: Piece[] = [];
  private mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private t = 0;
  private col = new THREE.Color();

  constructor(scene: THREE.Scene, private wind: Wind) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      // unlit mid-grey specks (the night lighting would otherwise swallow them); tumbling makes them glint
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      COUNT,
    );
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < COUNT; i++) {
      const isPaper = Math.random() < 0.4;
      this.pieces.push({
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Euler(), spin: new THREE.Vector3(),
        // ~3-4 px on screen at the lane's depth (about 55 px per world unit at 720p)
        size: isPaper ? 0.06 + Math.random() * 0.016 : 0.045 + Math.random() * 0.015,
        paper: isPaper, phase: Math.random() * 6.28, lift: 0.5 + Math.random(),
        speedMul: 0.55 + Math.random() * 1.1,
        gustOffset: Math.random() * 400,
        grey: 0.42 + Math.random() * 0.2,   // mid grey, slightly different per piece
        delay: Math.random() * 14,           // staggered first appearance
      });
    }
    scene.add(this.mesh);
  }

  private respawn(p: Piece, camX: number, anywhere: boolean): void {
    // blown in from far upwind (right); the spread of distances and speeds staggers the arrivals
    p.pos.set(
      camX + (anywhere ? (Math.random() * 2 - 1) * X_SPAN : X_SPAN * (1.0 + Math.random() * 1.6)),
      0.3 + Math.random() * 5.5,
      Z_MIN + Math.random() * (Z_MAX - Z_MIN),
    );
    p.vel.set(-this.wind.speed * 2 * p.speedMul, 0, 0);
    p.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    p.delay = anywhere ? Math.random() * 6 : Math.random() * 9;
  }

  private started = false;

  update(dt: number, camX: number): void {
    this.t += dt;
    if (!this.started) { this.pieces.forEach((p) => this.respawn(p, camX, true)); this.started = true; }

    for (let i = 0; i < COUNT; i++) {
      const p = this.pieces[i];
      // target velocity: pushed along by the wind (faster than the haze drifts), with gusts and eddies
      if (p.delay > 0) { p.delay -= dt; this.dummy.scale.set(0, 0, 0); this.dummy.updateMatrix(); this.mesh.setMatrixAt(i, this.dummy.matrix); continue; }
      const g = this.wind.gust(p.pos.x + p.gustOffset, this.t);
      const tx = -this.wind.speed * (p.paper ? 3.2 : 2.4) * p.speedMul * g;
      const tz = Math.sin(this.t * 0.7 + p.phase) * 0.9;
      // lift: gusts throw light things up, otherwise they sink slowly
      const ty = (g > 1.25 ? (g - 1.25) * 3.5 * p.lift : -0.35) + Math.sin(this.t * 3.1 + p.phase) * (p.paper ? 0.5 : 0.25);
      const k = Math.min(1, dt * 1.6);
      p.vel.x += (tx - p.vel.x) * k;
      p.vel.y += (ty - p.vel.y) * k;
      p.vel.z += (tz - p.vel.z) * k;
      p.pos.addScaledVector(p.vel, dt);

      // skitter along the ground
      if (p.pos.y < 0.04) { p.pos.y = 0.04; p.vel.y = Math.max(0, p.vel.y); p.spin.multiplyScalar(0.96); }
      // tumble; paper flutters (flat flap), leaves spin
      p.rot.x += (p.spin.x + Math.sin(this.t * 9 + p.phase) * (p.paper ? 3 : 1)) * dt;
      p.rot.y += p.spin.y * dt;
      p.rot.z += p.spin.z * dt;

      // left behind (or out of the lane's depth): come back in from the upwind side
      if (p.pos.x < camX - X_SPAN * 1.2 || p.pos.y > 9) this.respawn(p, camX, false);

      this.dummy.position.copy(p.pos);
      this.dummy.rotation.copy(p.rot);
      this.dummy.scale.set(p.size, p.size * (p.paper ? 1.35 : 0.8), 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      // glint: brightest when the flat piece faces the camera, dim edge-on
      const facing = 0.45 + 0.55 * Math.abs(Math.cos(p.rot.x) * Math.cos(p.rot.y));
      const v = p.grey * facing;
      this.mesh.setColorAt(i, this.col.setRGB(v, v, v));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
