import { SCORE } from './config';

const KEY = 'walker.hallOfFame';

export interface FameEntry {
  name: string;
  score: number;
  /** which level it was (older entries have none: the first) */
  level?: number;
  /** scenes cleared */
  scenes: number;
  /** how many scenes that level has (older entries have none: the first level's) */
  sceneCount?: number;
  /** the whole level was cleared */
  complete: boolean;
  /** seconds of play */
  time: number;
  date: number;
}

/**
 * Better first: a run that got further beats one that scored more but fell short; then the higher score; then the faster time.
 * (Two players who clear everything with the same score are told apart by how quickly they did it.)
 */
export const compareEntries = (a: FameEntry, b: FameEntry): number =>
  Number(b.complete) - Number(a.complete) || (b.level ?? 1) - (a.level ?? 1) || b.scenes - a.scenes || b.score - a.score || a.time - b.time;

/** The best runs on this machine, remembered between visits. */
class HallOfFame {
  private entries: FameEntry[] = [];

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as FameEntry[];
      if (Array.isArray(raw)) this.entries = raw.filter((e) => typeof e?.score === 'number').sort(compareEntries).slice(0, SCORE.fameSize);
    } catch { /* storage blocked or damaged: start empty */ }
  }

  get list(): readonly FameEntry[] { return this.entries; }

  /** The place (1-based) a run would take, or 0 if it would not make the list. */
  rankOf(run: Omit<FameEntry, 'name' | 'date'>): number {
    if (run.score <= 0) return 0;                   // nothing scored: nothing to remember
    const probe: FameEntry = { ...run, name: '', date: 0 };
    let rank = 1;
    for (const e of this.entries) if (compareEntries(e, probe) <= 0) rank++;
    return rank <= SCORE.fameSize ? rank : 0;
  }

  /** Put a run on the list; returns its place, or 0 if it did not make it. */
  add(entry: FameEntry): number {
    const rank = this.rankOf(entry);
    if (!rank) return 0;
    this.entries.push(entry);
    this.entries.sort(compareEntries);
    this.entries.length = Math.min(this.entries.length, SCORE.fameSize);
    try { localStorage.setItem(KEY, JSON.stringify(this.entries)); } catch { /* not remembered */ }
    return rank;
  }
}

/** the one list: the menu shows it and the game adds to it */
export const hof = new HallOfFame();
export type { HallOfFame };
