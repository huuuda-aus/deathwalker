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
 * (the right edge of the first view). A view spans [p, p + 1] screens.
 */
export interface SceneDef {
  /** 1 = locked single screen; >1 = scrolls, camera range grows by (width - 1) screens */
  widthScreens: number;
  killTarget: number;
  spawnBudget: number;
}

/** The first scene begins this far into the first screen. */
const FIRST_SCENE_START = 0.5;

export const LEVEL: SceneDef[] = [
  { widthScreens: 1, killTarget: 24, spawnBudget: 32 },
  { widthScreens: 2, killTarget: 40, spawnBudget: 52 },
  { widthScreens: 1, killTarget: 28, spawnBudget: 38 },
];

/** Progress (screens) at which each scene's view first locks in. Scenes are contiguous. */
const SCENE_START: number[] = LEVEL.reduce<number[]>(
  (acc, _def, i) => { acc.push(i === 0 ? FIRST_SCENE_START : acc[i - 1] + LEVEL[i - 1].widthScreens); return acc; },
  [],
);

export type Phase = 'entering' | 'active' | 'cleared' | 'complete';
export type LevelEvent = 'cleared' | 'arrived' | 'complete' | null;

/** Camera centre x for a view whose right edge is at `screens` of progress. */
export const camXAt = (screens: number): number => -screens * SCREEN_W - SCREEN_W / 2;

/** Start view: progress 0..1, mech parked near its right edge. */
export const START_CAM_X = camXAt(0);
export const START_MECH_X = START_CAM_X + SCREEN_W * 0.4;

/** Scene runner: owns the on-rails camera and the kill-gate state machine. */
export class LevelRunner {
  index = 0;
  /**
   * entering: camera rails into the first scene.
   * active:   scene running, camera confined to the scene.
   * cleared:  kill goal met; scroll unlocked, camera follows the mech toward the next scene.
   * complete: last scene cleared.
   */
  phase: Phase = 'entering';
  /** kills per scene index, kept for the whole run */
  killsByScene: number[] = LEVEL.map(() => 0);
  spawned = 0;
  camX = START_CAM_X;
  /** signed camera velocity (negative = advancing left) */
  camVel = 0;

  get kills(): number { return this.killsByScene[this.index]; }
  addKill(): void { this.killsByScene[this.index]++; }
  get scene(): SceneDef { return LEVEL[this.index]; }
  get count(): number { return LEVEL.length; }
  get canSpawn(): boolean { return this.phase === 'active' && this.spawned < this.scene.spawnBudget; }

  reset(): void {
    this.index = 0; this.phase = 'entering'; this.killsByScene.fill(0); this.spawned = 0;
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
      const { max } = this.range(0);
      this.camX = Math.max(max, this.camX - RAIL_SPEED * dt);
      if (this.camX <= max) { this.camX = max; this.phase = 'active'; event = 'arrived'; }
    } else if (this.phase === 'active') {
      const { min, max } = this.range(this.index);
      this.camX += (Math.min(max, Math.max(min, follow)) - this.camX) * Math.min(1, dt * 4);
      if (this.kills >= this.scene.killTarget) {
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
        this.spawned = 0;
        this.phase = 'active';
        event = 'arrived';
      }
    }
    this.camVel = dt > 0 ? (this.camX - prev) / dt : 0;
    return event;
  }
}
