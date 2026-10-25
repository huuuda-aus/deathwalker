import * as THREE from 'three';
import type { Fx } from './fx';
import type { Dust } from './dust';
import type { World } from './world';
import type { Collider, Debris } from './debris';
import { CANNON } from './config';
import type { Explosions } from './explosions';
import { sfx } from './sfx';

const SHELL_R = 0.045;
const GEO = new THREE.SphereGeometry(SHELL_R, 10, 8);
const MAT = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x808080 });
const FIRE_COLORS = [0xffd080, 0xff7020, 0x884422, 0x444444];
/** seconds between smoke puffs along a shell's path */
const TRAIL_STEP = 0.05;

interface Shell { mesh: THREE.Mesh; vel: THREE.Vector3; trail: number }

export interface ShellDeps {
  scene: THREE.Scene;
  fx: Fx;
  dust: Dust;
  world: World;
  debris: Debris;
  explosions: Explosions;
  /** the player's hit spheres */
  colliders: Collider[];
  onPlayerHit: (damage: number) => void;
}

/** Lobbed artillery shells: slow ballistic arcs that explode on the first thing they touch. */
export class Shells {
  private live: Shell[] = [];
  constructor(private readonly deps: ShellDeps) {}

  /** Lob a shell from `from` so that it comes down at `aim` after `flight` seconds. */
  launch(from: THREE.Vector3, aim: THREE.Vector3, flight: number): void {
    const { scene, fx, dust } = this.deps;
    const mesh = new THREE.Mesh(GEO, MAT);
    mesh.castShadow = true;
    mesh.position.copy(from);
    scene.add(mesh);
    const vel = new THREE.Vector3(
      (aim.x - from.x) / flight,
      (aim.y - from.y) / flight + 0.5 * CANNON.shellGravity * flight,
      (aim.z - from.z) / flight,
    );
    this.live.push({ mesh, vel, trail: 0 });
    sfx.cannon(from);
    fx.burst(from, 14, 3, FIRE_COLORS, false);
    fx.muzzleFlash(from);
    dust.puff(from, 4, 0.35, 1);
  }

  update(dt: number): void {
    const { world, colliders, dust } = this.deps;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      const p = s.mesh.position;
      s.vel.y -= CANNON.shellGravity * dt;
      p.addScaledVector(s.vel, dt);
      s.trail -= dt;
      if (s.trail <= 0) { s.trail = TRAIL_STEP; dust.puff(p, 1, 0.14, 0.15); }

      let hit = world.solidAt(p.x, p.y, p.z) || p.y <= world.surfaceTop(p.x, p.z, p.y + 0.1);
      if (!hit) for (const c of colliders) if (p.distanceTo(c.pos) < c.r + SHELL_R) { hit = true; break; }
      if (hit) { this.explode(p); this.remove(i); }
    }
  }

  clear(): void {
    for (let i = this.live.length - 1; i >= 0; i--) this.remove(i);
  }

  private remove(i: number): void {
    this.deps.scene.remove(this.live[i].mesh);
    this.live.splice(i, 1);
  }

  private explode(at: THREE.Vector3): void {
    const { explosions, world, colliders, onPlayerHit } = this.deps;
    const R = CANNON.blastRadius;
    explosions.detonate(at, R);
    world.forEachBuilding(at.x - R, at.x + R, (b) => b.damage(at.x, at.y, at.z, R));
    for (const c of colliders) {
      if (at.distanceTo(c.pos) < R + c.r) { onPlayerHit(CANNON.damage); break; }
    }
  }
}
