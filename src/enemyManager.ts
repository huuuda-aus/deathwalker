import * as THREE from 'three';
import { Soldier, type SoldierEnv } from './enemies';
import type { Fx } from './fx';
import type { World } from './world';
import type { Debris } from './debris';
import { LANE, type Mech } from './mech';
import { SPAWN, ENEMY_FIRE } from './config';
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
}

export class EnemyManager {
  readonly list: Soldier[] = [];
  private spawnTimer = 1;

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
    for (const e of this.list) this.deps.scene.remove(e.group);
    this.list.length = 0;
  }

  /** the current scene is over: whoever is left runs away */
  retreatAll(): void {
    for (const e of this.list) if (e.alive) e.retreating = true;
  }

  /** stragglers that fled the previous scene are gone by the time the next one starts */
  purgeRetreating(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].retreating) { this.deps.scene.remove(this.list[i].group); this.list.splice(i, 1); }
    }
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
    const { scene, level, fx, mech } = this.deps;
    if (spawning) this.spawn(dt, camX);
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
      if (e.state === 'dead' && !e.counted) { e.counted = true; level.addKill(); }
      if ((e.state === 'dead' && e.deadTime > 8) || (e.retreating && (e.gone || e.x < camX - 14))) {
        scene.remove(e.group);
        this.list.splice(i, 1);
      }
    }
  }
}
