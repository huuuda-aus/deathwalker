import level1 from './levels/level1.json';
import level2 from './levels/level2.json';
import { pickLevel } from './levelSelect';
import { ENVIRONMENTS } from './environment';
import { AIRCRAFT, CANNON, GUNNER, LAUNCHER } from './config';

/** A vehicle that arrives during a scene. `at` is how much of the scene's infantry has been sent in by then (0..1). */
export type SpawnEvent =
  | { type: 'cannon'; at: number; count: number }
  | { type: 'truck'; at: number; troops: number }
  | { type: 'aircraft'; at: number; count: number }
  | { type: 'gunner'; at: number; count: number }
  | { type: 'launcher'; at: number; count: number }
  | { type: 'zeppelin'; at: number; troops: number };

/**
 * The scene's boss: two missile silos. The scene has no kill count: it ends when the boss is destroyed (or the player
 * is), and its infantry never runs out. The silos stay shut until `opensAfter` infantry have been sent in; a truck
 * of troops arrives every `truckEvery` seconds, give or take `truckJitter`.
 */
export interface BossDef {
  type: 'silos';
  opensAfter: number;
  truckEvery: number;
  truckJitter: number;
  truckTroops: number;
}

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
  /** the look of the scene (a key of ENVIRONMENTS): the game fades to it as the scene begins */
  environment: string;
  /** 1 = locked single screen; >1 = scrolls, camera range grows by (width - 1) screens */
  widthScreens: number;
  infantry: InfantryDef;
  /** sorted by `at` */
  events: SpawnEvent[];
  boss: BossDef | null;
  /** seconds a good player takes to clear the scene: the time bonus is paid against it */
  parTime: number;
  /** everything the scene sends in; every one of them must be killed to clear it (Infinity for a boss scene, which ends with the boss) */
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
        case 'gunner': {
          const count = num(`${ew} count`, e.count ?? 1, 1, GUNNER.packMax);
          budget += count;
          return { type: 'gunner', at, count };
        }
        case 'launcher': {
          const count = num(`${ew} count`, e.count ?? 1, 1, LAUNCHER.packMax);
          budget += count;
          return { type: 'launcher', at, count };
        }
        case 'zeppelin': {
          const troops = Math.round(num(`${ew} troops`, e.troops ?? 14, 1, 40));
          budget += troops;
          return { type: 'zeppelin', at, troops };
        }
        default:
          return fail(`${ew} type`, `unknown type ${JSON.stringify(e.type)} (cannon, truck, aircraft, gunner, launcher or zeppelin)`);
      }
    });
    events.sort((a, b) => a.at - b.at);
    let boss: BossDef | null = null;
    if (sc.boss) {
      const b = sc.boss as Record<string, unknown>;
      if (b.type !== 'silos') fail(`${w} boss type`, `unknown type ${JSON.stringify(b.type)} (silos)`);
      boss = {
        type: 'silos',
        opensAfter: num(`${w} boss.opensAfter`, b.opensAfter ?? 12, 0),
        truckEvery: num(`${w} boss.truckEvery`, b.truckEvery ?? 30, 5),
        truckJitter: num(`${w} boss.truckJitter`, b.truckJitter ?? 10, 0),
        truckTroops: Math.round(num(`${w} boss.truckTroops`, b.truckTroops ?? 10, 1)),
      };
    }
    const environment = String(sc.environment ?? 'night');
    if (!(environment in ENVIRONMENTS)) fail(`${w} environment`, `unknown environment ${JSON.stringify(environment)} (${Object.keys(ENVIRONMENTS).join(', ')})`);
    return { name: String(sc.name ?? w), environment, widthScreens: num(`${w} widthScreens`, sc.widthScreens ?? 1, 1), infantry, events, boss, parTime: num(`${w} parTime`, sc.parTime ?? 90, 10), spawnBudget: boss ? Infinity : budget };
  });
}

/** `code` is the level's password: typed at the main menu, shown on the win screen of the level before it */
export interface LevelDef { name: string; code: string; /** what the world is made of: a ruined city, or open desert */ world: WorldStyle; scenes: SceneDef[] }

export type WorldStyle = 'city' | 'desert';

/** Every level of the game, in play order. */
export const LEVELS: LevelDef[] = [level1, level2].map((raw, i) => {
  const { name, code, world } = raw as { name?: unknown; code?: unknown; world?: unknown };
  if (world !== undefined && world !== 'city' && world !== 'desert') fail(`level ${i + 1}`, `world must be "city" or "desert", got ${JSON.stringify(world)}`);
  if (typeof code !== 'string' || !/^[A-Z]{4,10}$/.test(code)) fail(`level ${i + 1}`, `code must be 4 to 10 capital letters, got ${JSON.stringify(code)}`);
  return { name: String(name ?? `Level ${i + 1}`), code: code as string, world: (world as WorldStyle | undefined) ?? 'city', scenes: parseLevel(raw) };
});

/** The number (1-based) of the level a password opens, or 0 if it opens none. */
export function levelForCode(code: string): number {
  return LEVELS.findIndex((l) => l.code === code.trim().toUpperCase()) + 1;
}

/** The number (1-based) of the level this page plays, and its scenes. */
export const LEVEL_NO = pickLevel(LEVELS.length);
export const LEVEL: SceneDef[] = LEVELS[LEVEL_NO - 1].scenes;
