import { CANNON, SCORE } from './config';
import type { SceneDef } from './levelData';

export type ScoreKind = keyof typeof SCORE.points;
export type KillCause = keyof typeof SCORE.causeBonus;

/** What a cleared scene paid in bonuses, and what it was worked out from. */
export interface SceneResult {
  scene: number;
  time: number;
  par: number;
  shield: number;
  hits: number;
  overheats: number;
  timeBonus: number;
  shieldBonus: number;
  noDamageBonus: number;
  noOverheatBonus: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** The bonuses a scene pays for a run through it. */
export function sceneBonuses(par: number, time: number, shield: number, hits: number, overheats: number, maxShield: number): Pick<SceneResult, 'timeBonus' | 'shieldBonus' | 'noDamageBonus' | 'noOverheatBonus'> {
  const { bonus, timeBest, timeWorst } = SCORE;
  const t = clamp01((par * timeWorst - time) / (par * (timeWorst - timeBest)));
  return {
    timeBonus: Math.round(bonus.time * t),
    shieldBonus: Math.round(bonus.shield * clamp01(shield / maxShield)),
    noDamageBonus: hits === 0 ? bonus.noDamage : 0,
    noOverheatBonus: overheats === 0 ? bonus.noOverheat : 0,
  };
}

/** What killing everything a scene sends in is worth, and with every bonus in full: the yardstick a run is graded against. */
export function nominalScene(scene: SceneDef): number {
  const p = SCORE.points;
  let pts = scene.infantry.count * p.soldier;
  for (const e of scene.events) {
    if (e.type === 'cannon') pts += e.count * (p.cannon + CANNON.crew * p.soldier + p.horse);
    else if (e.type === 'truck') pts += p.truck + e.troops * p.soldier;
    else pts += e.count * p.aircraft;
  }
  if (scene.boss) pts += 2 * p.silo;
  return pts + SCORE.bonus.time + SCORE.bonus.shield + SCORE.bonus.noDamage + SCORE.bonus.noOverheat;
}

export const nominalLevel = (scenes: SceneDef[]): number => scenes.reduce((sum, s) => sum + nominalScene(s), 0);

/** The grade for a finished run: its score as a share of the level's nominal total. */
export function gradeFor(score: number, nominal: number): string {
  const share = score / nominal;
  for (const [g, min] of SCORE.grades) if (share >= min) return g;
  return 'D';
}

/**
 * The run's score: points for each kill (with a combo multiplier for quick ones), and a bonus for each scene cleared. Also keeps
 * what the scene bonuses need: how long the scene took, and how many times the player was hit or overheated in it.
 */
export class Score {
  total = 0;
  /** seconds of play, over the whole run */
  time = 0;
  kills: Record<ScoreKind, number> = { soldier: 0, horse: 0, cannon: 0, truck: 0, aircraft: 0, silo: 0 };
  results: SceneResult[] = [];
  /** kills in a row, and how long until the chain breaks */
  combo = 0;
  private comboT = 0;
  private sceneTime = 0;
  private hits = 0;
  private overheats = 0;
  private inScene = false;

  reset(): void {
    this.total = this.time = this.combo = this.comboT = 0;
    for (const k of Object.keys(this.kills) as ScoreKind[]) this.kills[k] = 0;
    this.results = [];
    this.inScene = false;
  }

  /** the points a kill is worth now: the multiplier of the combo it would join */
  get multiplier(): number { return this.comboT > 0 ? Math.min(SCORE.comboMax, 1 + SCORE.comboStep * this.combo) : 1; }

  /** @param running the player is playing a scene right now (not rolling in, between scenes, or dead) */
  update(dt: number, running: boolean): void {
    this.comboT = Math.max(0, this.comboT - dt);
    if (this.comboT === 0) this.combo = 0;
    if (!running) return;
    this.time += dt;
    if (this.inScene) this.sceneTime += dt;
  }

  /** An enemy died. Returns the points it was worth. */
  kill(kind: ScoreKind, cause: KillCause = 'bullet'): number {
    this.combo = this.comboT > 0 ? this.combo + 1 : 1;
    this.comboT = SCORE.comboWindow;
    const mult = Math.min(SCORE.comboMax, 1 + SCORE.comboStep * (this.combo - 1));
    const pts = Math.round((SCORE.points[kind] + (kind === 'soldier' ? SCORE.causeBonus[cause] : 0)) * mult);
    this.total += pts;
    this.kills[kind]++;
    return pts;
  }

  noteHit(): void { if (this.inScene) this.hits++; }
  noteOverheat(): void { if (this.inScene) this.overheats++; }

  beginScene(): void {
    this.sceneTime = this.hits = this.overheats = 0;
    this.inScene = true;
  }

  /** The scene is cleared: pay its bonuses. */
  endScene(index: number, par: number, shield: number, maxShield: number): SceneResult {
    this.inScene = false;
    const b = sceneBonuses(par, this.sceneTime, shield, this.hits, this.overheats, maxShield);
    const result: SceneResult = { scene: index, time: this.sceneTime, par, shield, hits: this.hits, overheats: this.overheats, ...b };
    this.total += b.timeBonus + b.shieldBonus + b.noDamageBonus + b.noOverheatBonus;
    this.results.push(result);
    return result;
  }
}
