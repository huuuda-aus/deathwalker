import { LEVEL, type SceneDef } from './levelData';
import { DEBUG } from './config';

/** Camera distance from the gameplay plane (z = 0). */
export const CAM_DIST = 24;
/** World units across one "screen" at the gameplay depth (horizontal view is locked to this). */
export const SCREEN_W = 24;
/** Camera speed while rolling into the first scene (world units/s). */
const RAIL_SPEED = 5;
/** While scrolling, the camera sits this far left of the mech. */
export const FOLLOW_OFFSET = 8;

/**
 * Level positions are in "screens" of progress measured leftward from the level start
 * (the right edge of the first view). A view spans [p, p + 1] screens. The scenes themselves (what each one sends
 * in, and when) are data: see levels/level1.json and levelData.ts.
 */

/** TEMP (testing): start the level this many scenes in. 0 = play from the beginning. */
const DEBUG_SKIP_SCENES: number = 0;

/** The first scene begins this far into the first screen. */
const FIRST_SCENE_START = 0.5;

export { LEVEL, LEVELS, LEVEL_NO, type SceneDef, type SpawnEvent, type BossDef } from './levelData';

/** Progress (screens) at which each scene's view first locks in. Scenes are contiguous. */
const SCENE_START: number[] = LEVEL.reduce<number[]>(
  (acc, _def, i) => { acc.push(i === 0 ? FIRST_SCENE_START : acc[i - 1] + LEVEL[i - 1].widthScreens); return acc; },
  [],
);

/** where the camera comes to rest at the end of the level (x of the middle of the view) */
export function endCamX(): number {
  const last = LEVEL.length - 1;
  return camXAt(SCENE_START[last] + LEVEL[last].widthScreens - 1);
}

/** x of the end of the road at the end of the level: just inside the left edge of the view the camera ends on */
export function endDoorX(): number { return endCamX() - SCREEN_W / 2 + 4; }

export type Phase = 'entering' | 'active' | 'cleared' | 'complete';
export type LevelEvent = 'cleared' | 'arrived' | 'complete' | null;

/** Camera centre x for a view whose right edge is at `screens` of progress. */
export const camXAt = (screens: number): number => -screens * SCREEN_W - SCREEN_W / 2;

/** Start view: progress 0..1, mech parked near its right edge. */
export const START_CAM_X = camXAt(DEBUG_SKIP_SCENES === 0 ? 0 : SCENE_START[DEBUG_SKIP_SCENES]);
export const START_MECH_X = START_CAM_X + SCREEN_W * 0.4;

/** Scene runner: owns the on-rails camera and the kill-gate state machine. */
export class LevelRunner {
  index = DEBUG_SKIP_SCENES;
  /**
   * entering: camera rails into the first scene.
   * active:   scene running, camera confined to the scene.
   * cleared:  kill goal met; scroll unlocked, camera follows the mech toward the next scene.
   * complete: last scene cleared.
   */
  phase: Phase = 'entering';
  /** kills per scene index, kept for the whole run */
  killsByScene: number[] = LEVEL.map(() => 0);
  /** everything sent in so far this scene (all kinds), and how many street infantry of it */
  spawned = 0;
  infantrySpawned = 0;
  /** the scene's boss has been destroyed: what ends a boss scene */
  bossDown = false;
  /** which of the scene's events have gone (by index into `scene.events`) */
  readonly fired = new Set<number>();
  camX = START_CAM_X;
  /** signed camera velocity (negative = advancing left) */
  camVel = 0;

  get kills(): number { return this.killsByScene[this.index]; }
  addKill(): void { this.killsByScene[this.index]++; }
  /** failsafe: whatever is still missing from the kill goal is written off */
  writeOffKills(): void { this.killsByScene[this.index] = this.scene.spawnBudget; }
  get scene(): SceneDef { return LEVEL[this.index]; }
  get count(): number { return LEVEL.length; }
  get canSpawn(): boolean { return this.phase === 'active'; }
  /** how much of this scene's infantry has been sent in, 0..1 (1 if it sends none): what the scene's events are timed by */
  get progress(): number { const n = this.scene.infantry.count; return n === 0 ? 1 : this.infantrySpawned / n; }

  /** a scene begins: nothing has been sent in yet */
  private beginScene(): void { this.spawned = 0; this.infantrySpawned = 0; this.bossDown = false; this.fired.clear(); }

  reset(): void {
    this.index = DEBUG_SKIP_SCENES; this.phase = 'entering'; this.killsByScene.fill(0); this.beginScene();
    this.camX = START_CAM_X; this.camVel = 0;
  }

  /** Camera x range allowed inside scene i: [min (most progress), max (least progress)]. */
  private range(i: number): { min: number; max: number } {
    const max = camXAt(SCENE_START[i]);
    return { min: max - (LEVEL[i].widthScreens - 1) * SCREEN_W, max };
  }

  update(dt: number, mechX: number): LevelEvent {
    const prev = this.camX;
    let event: LevelEvent = null;
    const follow = mechX - FOLLOW_OFFSET;

    if (this.phase === 'entering') {
      const { max } = this.range(this.index);
      this.camX = Math.max(max, this.camX - RAIL_SPEED * dt);
      if (this.camX <= max) { this.camX = max; this.phase = 'active'; event = 'arrived'; }
    } else if (this.phase === 'active') {
      const { min, max } = this.range(this.index);
      this.camX += (Math.min(max, Math.max(min, follow)) - this.camX) * Math.min(1, dt * 4);
      // (testing, DEBUG.noResistance: every scene but the last is cleared at once, and the last never is)
      const cleared = DEBUG.noResistance ? this.index < LEVEL.length - 1 : this.scene.boss ? this.bossDown : this.kills >= this.scene.spawnBudget;
      if (cleared) {
        this.phase = this.index === LEVEL.length - 1 ? 'complete' : 'cleared';
        event = this.phase === 'complete' ? 'complete' : 'cleared';
      }
    } else if (this.phase === 'cleared') {
      // scroll unlocked: follow the mech leftward (never back) until the next scene's view locks in
      const nextMax = this.range(this.index + 1).max;
      const target = Math.max(nextMax, Math.min(this.camX, follow));
      this.camX += (target - this.camX) * Math.min(1, dt * 4);
      if (this.camX - nextMax < 0.05) {
        this.camX = nextMax;
        this.index++;
        this.beginScene();
        this.phase = 'active';
        event = 'arrived';
      }
    }
    this.camVel = dt > 0 ? (this.camX - prev) / dt : 0;
    return event;
  }
}
