import * as THREE from 'three';
import type { Fx } from './fx';
import type { Dust } from './dust';
import type { World } from './world';
import type { Debris } from './debris';
import { BlastFx } from './blastFx';

const FIRE_COLORS = [0xffd080, 0xff7020, 0x884422, 0x444444];
const SPARK_COLORS = [0xffe080, 0xffa030, 0xffffff];
const DIRT_COLORS = [new THREE.Color(0x6b6256), new THREE.Color(0x4a4a46), new THREE.Color(0x857a68)];
/** how far the shockwave reaches, in blast radii, and how hard it hits at the centre (units/s) */
const SHOCK_REACH = 2.2;
const SHOCK_SPEED = 7;
const tmpV = new THREE.Vector3();

export interface ExplosionDeps {
  scene: THREE.Scene;
  fx: Fx;
  dust: Dust;
  world: World;
  debris: Debris;
}

/**
 * The look and feel of a big bang, shared by everything that explodes: a fireball and shockwave ring, fire
 * particles, sparks, bouncing embers, smoke, clods of dirt, and a physical shockwave that shoves rubble away.
 * It does no damage: callers decide who gets hurt.
 */
export class Explosions {
  private readonly blasts: BlastFx;

  constructor(private readonly deps: ExplosionDeps) {
    this.blasts = new BlastFx(deps.scene);
  }

  /** @param scale multiplies the particle counts (1 = a shell, ~2 = a vehicle) */
  detonate(at: THREE.Vector3, radius: number, scale = 1): void {
    const { fx, dust, world, debris } = this.deps;
    this.blasts.spawn(at, radius);
    fx.muzzleFlash(at);
    fx.burst(at, Math.round(60 * scale), 7, FIRE_COLORS);
    fx.sparks(at, Math.round(30 * scale), 7, SPARK_COLORS);
    dust.puff(at, Math.round(10 * scale), 1, 3);
    // glowing embers thrown out and up: they fall, bounce and cool like the barrels' coals
    for (let i = 0; i < Math.round(14 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 1 + Math.random() * 4;
      tmpV.set(Math.cos(a) * out, 2 + Math.random() * 4, Math.sin(a) * out * 0.6);
      world.coals.emit(at, tmpV, 0.8 + Math.random() * 1.6);
    }
    // the shockwave shoves rubble outwards, and the ground throws up clods
    debris.blast(at, radius * SHOCK_REACH, SHOCK_SPEED * Math.sqrt(scale));
    const floor = (x: number, z: number, y: number): number => world.surfaceTop(x, z, y);
    for (let i = 0; i < Math.round(8 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 0.5 + Math.random() * 2.5;
      tmpV.set(Math.cos(a) * out, 2 + Math.random() * 3, Math.sin(a) * out * 0.6);
      debris.spawn(at, DIRT_COLORS[i % DIRT_COLORS.length], 0.05 + Math.random() * 0.08, tmpV, floor);
    }
  }

  update(dt: number): void { this.blasts.update(dt); }

  clear(): void { this.blasts.clear(); }
}
