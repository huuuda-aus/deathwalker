import * as THREE from 'three';
import { Soldier, type Enemy, type SoldierEnv } from './enemies';
import { CannonUnit } from './cannon';
import { Horse } from './horse';
import type { Shells } from './shells';
import type { Dust } from './dust';
import type { Fx } from './fx';
import type { World } from './world';
import type { Debris } from './debris';
import { LANE, type Mech } from './mech';
import { SPAWN, ENEMY_FIRE, CANNON } from './config';
import { SCREEN_W, type LevelRunner } from './level';

const chest = new THREE.Vector3();
const shotAt = new THREE.Vector3();
const crushBox = new THREE.Box3();

/** Spawns soldier waves from the level budget, steps them, scores kills and removes the dead and the fled. */
export interface EnemyDeps {
  scene: THREE.Scene;
  world: World;
  level: LevelRunner;
  fx: Fx;
  debris: Debris;
  mech: Mech;
  /** how soldiers query rubble and surfaces */
  env: SoldierEnv;
  shells: Shells;
  dust: Dust;
}

export class EnemyManager {
  readonly list: Enemy[] = [];
  private spawnTimer = 1;
  private cannonTimer: number = CANNON.firstDelay;

  constructor(private readonly deps: EnemyDeps) {
    const { debris, fx } = deps;
    // falling masonry crushes soldiers it touches
    debris.onContact = (pos, size) => {
      for (const e of this.list) {
        if (!e.alive) continue;
        e.getBox(crushBox).expandByScalar(size * 0.35);
        if (crushBox.containsPoint(pos)) e.damage(99, fx);
      }
    };
  }

  reset(): void {
    for (const e of this.list) this.discard(e);
    this.list.length = 0;
  }

  /** the current scene is over: whoever is left runs away */
  retreatAll(): void {
    for (const e of this.list) if (e.alive) e.retreating = true;
  }

  /** stragglers that fled the previous scene are gone by the time the next one starts */
  purgeRetreating(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].retreating) { this.discard(this.list[i]); this.list.splice(i, 1); }
    }
  }

  private discard(e: Enemy): void {
    this.deps.scene.remove(e.group);
    e.dispose();
  }

  /**
   * Now and then a horse-drawn cannon gallops in from behind the mech and stops somewhere between mid-screen
   * and the left edge. Only one at a time, and it uses a slot of the scene's spawn budget.
   */
  private spawnCannon(dt: number, camX: number): void {
    const { scene, level, mech, shells, env, debris, dust, world } = this.deps;
    this.cannonTimer -= dt;
    // the gun and its crew all come out of the scene's spawn budget
    const cost = 1 + CANNON.crew;
    if (this.cannonTimer > 0 || !level.canSpawn || level.scene.spawnBudget - level.spawned < cost) return;
    if (this.list.some((e) => e instanceof CannonUnit && e.operational)) return;
    // roll 1..packMax, but no more than the budget can pay for
    const roll = 1 + Math.floor(Math.random() * CANNON.packMax);
    const count = Math.min(roll, Math.floor((level.scene.spawnBudget - level.spawned) / cost));
    const half = SCREEN_W / 2;
    const lanes = this.packLanes(count, mech.root.position.z);
    for (let n = 0; n < count; n++) {
      const z = lanes[n];
      const x = camX + half + 5 + n * CANNON.packStagger;
      const stopX = camX - Math.random() * (half - 2);
      const crew = Array.from({ length: CANNON.crew }, () => new Soldier(x, z, env));
      const horse = new Horse();
      const unit = new CannonUnit(x, z, stopX, crew, horse, { shells, debris, dust, floor: (fx, fz, fy) => world.surfaceTop(fx, fz, fy) });
      for (const e of [unit, ...crew, horse]) { scene.add(e.group); this.list.push(e); }
      level.spawned += cost;
    }
    this.cannonTimer = CANNON.intervalMin + Math.random() * CANNON.intervalExtra;
  }

  /**
   * `count` lane depths, one per equal band of the street so neighbours are always well apart (a pack of
   * three keeps at least ~1.6 units between lines). A lone cannon may pick anywhere, but steers clear of the
   * mech's lane so it does not ride straight through it.
   */
  private packLanes(count: number, mechZ: number): number[] {
    const band = (LANE.zMax - LANE.zMin) / count;
    const jitter = count === 1 ? 0.5 * band : 0.2 * band;
    const pick = (n: number): number => LANE.zMin + (n + 0.5) * band + (Math.random() * 2 - 1) * jitter;
    const lanes = Array.from({ length: count }, (_, n) => pick(n));
    if (count === 1) for (let i = 0; i < 5 && Math.abs(lanes[0] - mechZ) < 1.5; i++) lanes[0] = pick(0);
    return lanes;
  }

  /** waves of 3-6 from the scene budget; most come out of buildings, the rest walk in from off-screen */
  private spawn(dt: number, camX: number): void {
    const { scene, world, level, mech, env } = this.deps;
    const mechX = mech.root.position.x;
    this.spawnTimer -= dt;
    let alive = 0;
    for (const e of this.list) if (e.alive) alive++;
    if (this.spawnTimer > 0 || !level.canSpawn || alive >= SPAWN.maxAlive) return;
    const half = SCREEN_W / 2;
    const wave = Math.min(SPAWN.waveMin + Math.floor(Math.random() * SPAWN.waveExtra), SPAWN.maxAlive - alive, level.scene.spawnBudget - level.spawned);
    for (let w = 0; w < wave; w++) {
      const bay = Math.random() < SPAWN.ledgeChance ? world.takeLedge(camX - half * 0.85, mechX - 5) : null;
      let s: Soldier;
      if (bay) {
        s = new Soldier(bay.pos.x, bay.pos.z, env);
        s.perchAt(bay.pos, { ledgeZ: bay.ledgeZ, backZ: bay.backZ, floorTop: bay.floorTop });
      } else {
        s = new Soldier(camX - half - 3 - Math.random() * 8, LANE.zMin + Math.random() * (LANE.zMax - LANE.zMin), env);
      }
      scene.add(s.group);
      this.list.push(s);
      level.spawned++;
    }
    this.spawnTimer = SPAWN.intervalMin + Math.random() * SPAWN.intervalExtra;
  }

  /**
   * @param spawning false once the player is dead
   * @param onPlayerHit called when a soldier's shot lands on the mech
   */
  update(dt: number, camX: number, spawning: boolean, onPlayerHit: () => void): void {
    const { level, fx, mech } = this.deps;
    if (spawning) { this.spawn(dt, camX); this.spawnCannon(dt, camX); }
    chest.copy(mech.pivotWorld);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.update(dt, mech.root.position, fx, () => {
        const hit = Math.random() < ENEMY_FIRE.hitChance;
        shotAt.copy(chest);
        if (!hit) {
          shotAt.x += (Math.random() - 0.5) * 2;
          shotAt.y += (Math.random() - 0.5) * 1.5;
          shotAt.z += (Math.random() - 0.5) * 2;
        }
        fx.sparks(shotAt, 2, 2.5, hit ? [0xffa040, 0xffffff] : [0xaa8855]);
        if (hit && spawning) onPlayerHit();
      });
      if (!e.alive && !e.counted) { e.counted = true; level.addKill(); }
      if ((!e.alive && e.deadTime > 8) || e.gone || (e.retreating && e.x < camX - 14)) {
        this.discard(e);
        this.list.splice(i, 1);
      }
    }
  }
}
