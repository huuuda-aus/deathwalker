import type { HallOfFame, FameEntry } from './hallOfFame';
import type { SceneResult, ScoreKind } from './score';
import { SCORE } from './config';

export interface EndSummary {
  /** 'over': the mech was destroyed; 'win': the level was cleared */
  kind: 'over' | 'win';
  score: number;
  /** scenes cleared, out of this many */
  scenes: number;
  sceneCount: number;
  time: number;
  kills: Record<ScoreKind, number>;
  results: SceneResult[];
  /** only for a win */
  grade?: string;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const fmt = (n: number): string => n.toLocaleString('en-US');
export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * What the game over / level complete screen says: the score and where it came from, the grade, and (if the run is good
 * enough for the hall of fame) a place to key in three letters. Leaving the screen without doing so enters the run as AAA.
 */
export class EndScreen {
  private readonly root = $('over');
  private readonly title = $('over-title');
  private readonly summary = $('over-summary');
  private readonly entry = $('over-entry') as HTMLFormElement;
  private readonly name = $('over-name') as HTMLInputElement;
  private readonly rankNote = $('over-rank');
  private run: Omit<FameEntry, 'name' | 'date'> | null = null;

  constructor(private readonly fame: HallOfFame) {
    this.name.addEventListener('input', () => { this.name.value = this.name.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    this.entry.addEventListener('submit', (e) => { e.preventDefault(); this.commit(); this.name.blur(); });
  }

  show(s: EndSummary): void {
    const win = s.kind === 'win';
    this.root.classList.toggle('win', win);
    this.title.textContent = win ? 'LEVEL COMPLETE' : 'GAME OVER';
    const bonus = (k: 'timeBonus' | 'shieldBonus' | 'noDamageBonus' | 'noOverheatBonus'): number => s.results.reduce((sum, r) => sum + r[k], 0);
    const kills = Object.values(s.kills).reduce((a, b) => a + b, 0);
    const rows: [string, string][] = [
      ['SCORE', fmt(s.score)],
      [win ? 'GRADE' : 'SCENES CLEARED', win ? (s.grade ?? '') : `${s.scenes} / ${s.sceneCount}`],
      ['TIME', clock(s.time)],
      ['KILLS', String(kills)],
      ['BONUS: SPEED', `+${fmt(bonus('timeBonus'))}`],
      ['BONUS: SHIELD', `+${fmt(bonus('shieldBonus'))}`],
      ['BONUS: NO DAMAGE', `+${fmt(bonus('noDamageBonus'))}`],
      ['BONUS: NO OVERHEAT', `+${fmt(bonus('noOverheatBonus'))}`],
    ];
    this.summary.replaceChildren(...rows.map(([k, v]) => {
      const row = document.createElement('div');
      row.className = k === 'GRADE' ? 'row grade' : 'row';
      const a = document.createElement('span'), b = document.createElement('span');
      a.textContent = k; b.textContent = v;
      row.append(a, b);
      return row;
    }));
    this.run = { score: s.score, scenes: s.scenes, complete: win, time: s.time };
    const rank = this.fame.rankOf(this.run);
    this.entry.style.display = rank ? 'flex' : 'none';
    this.rankNote.textContent = rank ? `A PLACE IN THE HALL OF FAME: #${rank}` : '';
    this.name.value = '';
    this.name.disabled = false;
    if (rank) setTimeout(() => this.name.focus(), 0);
  }

  /** Put the run on the list (once), under the letters typed, or AAA. */
  commit(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    const rank = this.fame.add({ ...run, name: (this.name.value || 'AAA').padEnd(3, '_').slice(0, 3), date: Date.now() });
    this.name.disabled = true;
    this.rankNote.textContent = rank ? `SAVED: #${rank} IN THE HALL OF FAME` : '';
  }

  /** the hall of fame is this long */
  static get listSize(): number { return SCORE.fameSize; }
}
