import * as THREE from 'three';
import type { Fx } from './fx';
import type { Dust } from './dust';
import type { World } from './world';
import type { Collider, Debris } from './debris';
import { CANNON } from './config';
import type { Explosions } from './explosions';
import { sfx } from './sfx';

/** a shell: a steel body with a pointed nose and a brass driving band, about as big as the ball it replaced */
const SHELL_R = 0.035;
const BODY_LEN = 0.1;
const NOSE_LEN = 0.075;
const GEO = {
  body: new THREE.CylinderGeometry(SHELL_R, SHELL_R, BODY_LEN, 10),
  nose: new THREE.CylinderGeometry(0.004, SHELL_R, NOSE_LEN, 10).translate(0, BODY_LEN / 2 + NOSE_LEN / 2, 0),
  band: new THREE.CylinderGeometry(SHELL_R * 1.1, SHELL_R * 1.1, 0.016, 10).translate(0, -BODY_LEN * 0.3, 0),
};
const STEEL = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.35, metalness: 0.7, emissive: 0x303236 });
const BRASS = new THREE.MeshStandardMaterial({ color: 0xe0b050, roughness: 0.35, metalness: 0.9, emissive: 0x3a2200 });
const UP = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();

function makeShell(): THREE.Group {
  const g = new THREE.Group();
  const meshes = [new THREE.Mesh(GEO.body, STEEL), new THREE.Mesh(GEO.nose, STEEL), new THREE.Mesh(GEO.band, BRASS)];
  for (const m of meshes) m.castShadow = true;
  g.add(...meshes);
  return g;
}
const FIRE_COLORS = [0xffd080, 0xff7020, 0x884422, 0x444444];
/** seconds between smoke puffs along a shell's path, and their size: a thin, soft grey trail that hangs in the air a moment */
const TRAIL_STEP = 0.03;
const TRAIL_SIZE = 0.15;

interface Shell { mesh: THREE.Group; vel: THREE.Vector3; trail: number }

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
    const mesh = makeShell();
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
      // nose first, along the way it is flying
      s.mesh.quaternion.setFromUnitVectors(UP, dir.copy(s.vel).normalize());
      s.trail -= dt;
      if (s.trail <= 0) { s.trail = TRAIL_STEP; dust.puff(p, 1, TRAIL_SIZE, 0.06, 0.15); }

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
