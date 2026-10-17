import * as THREE from 'three';
import { glowTexture } from './fireTextures';

interface Blast {
  fireball: THREE.Sprite;
  core: THREE.Sprite;
  ring: THREE.Mesh;
  age: number;
  radius: number;
  /** ground level at the impact, so the fireball can sit on it without being cut off */
  y: number;
}

const FIREBALL_LIFE = 0.45;
const CORE_LIFE = 0.2;
const RING_LIFE = 0.4;
const RING_GEO = new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2);

const sprite = (color: THREE.Color): THREE.Sprite => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
  }));
  s.renderOrder = 5;
  return s;
};

/** The visible side of an explosion: a fireball that swells and fades, a white-hot core and a shockwave ring on the ground. */
export class BlastFx {
  private live: Blast[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** @param radius blast radius; the fireball grows to about 1.6x that, the ring to twice */
  spawn(at: THREE.Vector3, radius: number): void {
    const fireball = sprite(new THREE.Color(2.4, 1.1, 0.35));
    const core = sprite(new THREE.Color(4, 3.4, 2.4));
    fireball.position.copy(at);
    core.position.copy(at);
    const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.5, 0.9, 0.45), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    }));
    ring.position.copy(at).y += 0.03;
    this.scene.add(fireball, core, ring);
    this.live.push({ fireball, core, ring, age: 0, radius, y: at.y });
    this.update(0);
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.age += dt;
      const kf = b.age / FIREBALL_LIFE;
      if (kf >= 1) { this.remove(i); continue; }
      const ease = 1 - (1 - kf) * (1 - kf);              // fast at first, then slowing
      const size = b.radius * (0.5 + 1.9 * ease);
      b.fireball.scale.setScalar(size);
      b.fireball.position.y = b.y + size * 0.5;      // it swells upward off the ground, not into it
      (b.fireball.material as THREE.SpriteMaterial).opacity = (1 - kf) * (1 - kf);
      const kc = Math.min(1, b.age / CORE_LIFE);
      const coreSize = b.radius * (0.4 + 0.7 * kc);
      b.core.scale.setScalar(coreSize);
      b.core.position.y = b.y + coreSize * 0.5;
      (b.core.material as THREE.SpriteMaterial).opacity = 1 - kc;
      const kr = Math.min(1, b.age / RING_LIFE);
      b.ring.scale.setScalar(b.radius * (0.2 + 1.8 * (1 - (1 - kr) * (1 - kr))));
      (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - kr);
      b.ring.visible = kr < 1;
    }
  }

  clear(): void {
    for (let i = this.live.length - 1; i >= 0; i--) this.remove(i);
  }

  private remove(i: number): void {
    const b = this.live[i];
    this.scene.remove(b.fireball, b.core, b.ring);
    (b.fireball.material as THREE.Material).dispose();
    (b.core.material as THREE.Material).dispose();
    (b.ring.material as THREE.Material).dispose();
    this.live.splice(i, 1);
  }
}
