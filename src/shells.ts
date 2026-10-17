import * as THREE from 'three';
import type { Fx } from './fx';
import type { Dust } from './dust';
import type { World } from './world';
import type { Collider, Debris } from './debris';
import { CANNON } from './config';
import { BlastFx } from './blastFx';

const SHELL_R = 0.045;
const GEO = new THREE.SphereGeometry(SHELL_R, 10, 8);
const MAT = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x808080 });
const SPARK_COLORS = [0xffe080, 0xffa030, 0xffffff];
const DIRT_COLORS = [new THREE.Color(0x6b6256), new THREE.Color(0x4a4a46), new THREE.Color(0x857a68)];
/** how far the shockwave reaches, in blast radii, and how hard it hits at the centre (units/s) */
const SHOCK_REACH = 2.2;
const SHOCK_SPEED = 7;
const EMBERS = 14;
const DIRT_PIECES = 8;
const tmpV = new THREE.Vector3();
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
  /** the player's hit spheres */
  colliders: Collider[];
  onPlayerHit: (damage: number) => void;
}

/** Lobbed artillery shells: slow ballistic arcs that explode on the first thing they touch. */
export class Shells {
  private live: Shell[] = [];
  private readonly blasts: BlastFx;

  constructor(private readonly deps: ShellDeps) {
    this.blasts = new BlastFx(deps.scene);
  }

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
    fx.burst(from, 14, 3, FIRE_COLORS, false);
    fx.muzzleFlash(from);
    dust.puff(from, 4, 0.35, 1);
  }

  update(dt: number): void {
    const { world, colliders, dust } = this.deps;
    this.blasts.update(dt);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      const p = s.mesh.position;
      s.vel.y -= CANNON.shellGravity * dt;
      p.addScaledVector(s.vel, dt);
      s.trail -= dt;
      if (s.trail <= 0) { s.trail = TRAIL_STEP; dust.puff(p, 1, 0.14, 0.15); }

      let hit = world.solidAt(p.x, p.y, p.z) || p.y <= Math.max(0, world.surfaceTop(p.x, p.z, p.y + 0.1));
      if (!hit) for (const c of colliders) if (p.distanceTo(c.pos) < c.r + SHELL_R) { hit = true; break; }
      if (hit) { this.explode(p); this.remove(i); }
    }
  }

  clear(): void {
    this.blasts.clear();
    for (let i = this.live.length - 1; i >= 0; i--) this.remove(i);
  }

  private remove(i: number): void {
    this.deps.scene.remove(this.live[i].mesh);
    this.live.splice(i, 1);
  }

  private explode(at: THREE.Vector3): void {
    const { fx, dust, world, debris, colliders, onPlayerHit } = this.deps;
    const R = CANNON.blastRadius;
    this.blasts.spawn(at, R);
    fx.muzzleFlash(at);
    fx.burst(at, 60, 7, FIRE_COLORS);
    fx.sparks(at, 30, 7, SPARK_COLORS);
    dust.puff(at, 10, 1, 3);
    // glowing embers thrown out and up: they fall, bounce and cool like the barrels' coals
    for (let i = 0; i < EMBERS; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 1 + Math.random() * 4;
      tmpV.set(Math.cos(a) * out, 2 + Math.random() * 4, Math.sin(a) * out * 0.6);
      world.coals.emit(at, tmpV, 0.8 + Math.random() * 1.6);
    }
    // the shockwave shoves rubble outwards, and the ground throws up clods
    debris.blast(at, R * SHOCK_REACH, SHOCK_SPEED);
    const floor = (x: number, z: number, y: number): number => world.surfaceTop(x, z, y);
    for (let i = 0; i < DIRT_PIECES; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 0.5 + Math.random() * 2.5;
      tmpV.set(Math.cos(a) * out, 2 + Math.random() * 3, Math.sin(a) * out * 0.6);
      debris.spawn(at, DIRT_COLORS[i % DIRT_COLORS.length], 0.05 + Math.random() * 0.08, tmpV, floor);
    }
    world.forEachBuilding(at.x - R, at.x + R, (b) => b.damage(at.x, at.y, at.z, R));
    for (const c of colliders) {
      if (at.distanceTo(c.pos) < R + c.r) { onPlayerHit(CANNON.damage); break; }
    }
  }
}
