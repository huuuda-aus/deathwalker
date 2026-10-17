import * as THREE from 'three';
import { flameTexture, glowTexture } from './fireTextures';

interface Tongue {
  group: THREE.Group;
  mat: THREE.MeshBasicMaterial;
  meshes: THREE.Mesh[];
  /** where it stands, nominal height (of a size-1 blaze), flicker phase, and the flicker's current/target values */
  x: number; z: number; base: number; phase: number;
  h: number; hT: number; b: number; bT: number; w: number; wT: number; timer: number;
}

/** every blaze is drawn at this fraction of the size it is asked for */
const FLAME_SCALE = 1 / 3;

/**
 * A big open fire (a burning wreck): several tall, flickering tongues of flame (crossed sheets, so they read from
 * any side), hot at the root and fading to red at the tip, with a glow around the base. The flames lean the way the
 * air is flowing (wind, or the airflow past a falling wreck), and sway and dip as they burn.
 */
export class Blaze {
  readonly group = new THREE.Group();
  private tongues: Tongue[] = [];
  private glow: THREE.Sprite;
  private t = Math.random() * 100;
  private glowS = 1; private glowT = 1; private glowTimer = 0;

  /** @param size 1 = flames about a unit tall, from a base about half a unit across */
  private readonly size: number;

  constructor(parent: THREE.Object3D, size = 1, count = 5) {
    this.size = size *= FLAME_SCALE;
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group();
      const x = (Math.random() - 0.5) * 0.5 * size, z = (Math.random() - 0.5) * 0.3 * size;
      group.position.set(x, 0, z);
      const mat = new THREE.MeshBasicMaterial({
        map: flameTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false, side: THREE.DoubleSide, color: new THREE.Color(3, 2, 1),
      });
      const meshes: THREE.Mesh[] = [];
      for (const yaw of [0, Math.PI / 2]) {
        const sheet = new THREE.Group();
        sheet.rotation.y = yaw;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        m.rotation.z = -Math.PI / 2;   // the texture's hot root (its right edge) points down
        sheet.add(m);
        group.add(sheet);
        meshes.push(m);
      }
      this.group.add(group);
      this.tongues.push({
        group, mat, meshes, x, z, base: (0.6 + Math.random() * 0.8) * size, phase: Math.random() * 6.28,
        h: 1, hT: 1, b: 1, bT: 1, w: 0.5, wT: 0.5, timer: Math.random() * 0.2,
      });
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      toneMapped: false, color: new THREE.Color(2.2, 1.2, 0.45),
    }));
    this.glow.position.y = 0.15 * size;
    this.group.add(this.glow);
    parent.add(this.group);
    this.group.visible = false;
  }

  /** the base of the fire, in the parent's space */
  place(at: THREE.Vector3): void { this.group.position.copy(at); }

  /**
   * @param intensity 0 = out, 1 = fully ablaze
   * @param flowX, flowY the way the air carries the flames (world units/s): they lean along it
   */
  update(dt: number, intensity: number, flowX: number, flowY: number): void {
    this.group.visible = intensity > 0.02;
    if (!this.group.visible) return;
    this.t += dt;
    const ease = Math.min(1, dt * 10);
    // lean along the flow (rotation about z: positive tips the top toward -x), at most about 70 degrees
    const lean = THREE.MathUtils.clamp(Math.atan2(-flowX, Math.max(0.5, flowY)), -1.2, 1.2);
    for (const tg of this.tongues) {
      tg.timer -= dt;
      if (tg.timer <= 0) {
        tg.timer = 0.1 + Math.random() * 0.12;
        tg.hT = Math.random() < 0.1 ? 0.4 : 0.7 + Math.random() * 0.7;     // now and then a tongue ducks right down
        tg.bT = 0.7 + Math.random() * 0.8;
        tg.wT = 0.4 + 0.25 * Math.random();
      }
      tg.h += (tg.hT - tg.h) * ease;
      tg.b += (tg.bT - tg.b) * ease;
      tg.w += (tg.wT - tg.w) * ease;
      const h = tg.base * tg.h * intensity;
      const w = h * tg.w;
      for (const m of tg.meshes) { m.scale.set(h, w, 1); m.position.y = h / 2; }
      // each tongue sways on its own, on top of the lean
      tg.group.rotation.z = lean * (0.8 + 0.4 * tg.phase / 6.28) + Math.sin(this.t * 3.4 + tg.phase) * 0.1 + Math.sin(this.t * 7.1 + tg.phase * 2) * 0.04;
      tg.group.rotation.x = Math.sin(this.t * 2.7 + tg.phase * 1.7) * 0.08;
      const b = tg.b * intensity;
      tg.mat.color.setRGB(1.7 * b, 1.1 * b, 0.5 * b);
    }
    this.glowTimer -= dt;
    if (this.glowTimer <= 0) { this.glowTimer = 0.12 + Math.random() * 0.1; this.glowT = 0.75 + 0.5 * Math.random(); }
    this.glowS += (this.glowT - this.glowS) * ease;
    const gs = 1.6 * this.size * this.glowS * (0.4 + 0.6 * intensity);
    this.glow.scale.set(gs, gs, 1);
    (this.glow.material as THREE.SpriteMaterial).opacity = Math.min(1, intensity * 1.3);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const tg of this.tongues) tg.mat.dispose();
    (this.glow.material as THREE.SpriteMaterial).dispose();
  }
}
