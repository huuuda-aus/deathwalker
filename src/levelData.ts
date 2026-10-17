import raw from './levels/level1.json';
import { AIRCRAFT, CANNON } from './config';

/** A vehicle that arrives during a scene. `at` is how much of the scene's infantry has been sent in by then (0..1). */
export type SpawnEvent =
  | { type: 'cannon'; at: number; count: number }
  | { type: 'truck'; at: number; troops: number }
  | { type: 'aircraft'; at: number; count: number };

export interface InfantryDef {
  count: number;
  waveMin: number;
  waveExtra: number;
  intervalMin: number;
  intervalExtra: number;
  /** enemies alive at once, above which no new infantry is sent */
  maxAlive: number;
}

export interface SceneDef {
  name: string;
  /** 1 = locked single screen; >1 = scrolls, camera range grows by (width - 1) screens */
  widthScreens: number;
  infantry: InfantryDef;
  /** sorted by `at` */
  events: SpawnEvent[];
  /** everything the scene sends in; every one of them must be killed to clear it */
  spawnBudget: number;
}

const fail = (where: string, why: string): never => { throw new Error(`level data: ${where}: ${why}`); };
const num = (where: string, v: unknown, min: number, max = Infinity): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(where, `expected a number from ${min}${max === Infinity ? '' : ` to ${max}`}, got ${JSON.stringify(v)}`);
  return v as number;
};

/** Read and check a level file, and work out how many kills each scene needs. Throws with a clear message if it is wrong. */
export function parseLevel(data: unknown): SceneDef[] {
  const level = data as { scenes?: unknown[] };
  if (!level || !Array.isArray(level.scenes) || level.scenes.length === 0) fail('scenes', 'a level needs at least one scene');
  return level.scenes!.map((s, i) => {
    const w = `scene ${i + 1}`;
    const sc = s as Record<string, unknown>;
    const inf = (sc.infantry ?? {}) as Record<string, unknown>;
    const infantry: InfantryDef = {
      count: num(`${w} infantry.count`, inf.count ?? 0, 0),
      waveMin: num(`${w} infantry.waveMin`, inf.waveMin ?? 3, 1),
      waveExtra: num(`${w} infantry.waveExtra`, inf.waveExtra ?? 3, 1),
      intervalMin: num(`${w} infantry.intervalMin`, inf.intervalMin ?? 3, 0.1),
      intervalExtra: num(`${w} infantry.intervalExtra`, inf.intervalExtra ?? 2.5, 0),
      maxAlive: num(`${w} infantry.maxAlive`, inf.maxAlive ?? 12, 1),
    };
    let budget = infantry.count;
    const events: SpawnEvent[] = ((sc.events ?? []) as Record<string, unknown>[]).map((e, j) => {
      const ew = `${w} event ${j + 1}`;
      const at = num(`${ew} at`, e.at ?? 0, 0, 1);
      switch (e.type) {
        case 'cannon': {
          const count = num(`${ew} count`, e.count ?? 1, 1, CANNON.packMax);
          budget += count * (1 + CANNON.crew);
          return { type: 'cannon', at, count };
        }
        case 'truck': {
          const troops = Math.round(num(`${ew} troops`, e.troops ?? 10, 1));
          budget += 1 + troops;
          return { type: 'truck', at, troops };
        }
        case 'aircraft': {
          const count = num(`${ew} count`, e.count ?? 1, 1, AIRCRAFT.packMax);
          budget += count;
          return { type: 'aircraft', at, count };
        }
        default:
          return fail(`${ew} type`, `unknown type ${JSON.stringify(e.type)} (cannon, truck or aircraft)`);
      }
    });
    events.sort((a, b) => a.at - b.at);
    return { name: String(sc.name ?? w), widthScreens: num(`${w} widthScreens`, sc.widthScreens ?? 1, 1), infantry, events, spawnBudget: budget };
  });
}

/** The scenes of the level being played. */
export const LEVEL: SceneDef[] = parseLevel(raw);
