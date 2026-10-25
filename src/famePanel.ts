import type { HallOfFame } from './hallOfFame';
import { clock } from './endScreen';
import { LEVEL } from './level';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** The hall of fame on the main menu: the best runs on this machine. Esc, Enter or a click closes it. */
export class FamePanel {
  private readonly root = $('fame');
  private readonly table = $('fame-table');

  constructor(private readonly fame: HallOfFame) {
    this.root.addEventListener('click', () => this.close());
    addEventListener('keydown', (e) => {
      if (!this.visible) return;
      if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, true);
  }

  get visible(): boolean { return document.body.classList.contains('fame'); }

  open(): void {
    const cell = (text: string, cls = ''): HTMLTableCellElement => { const td = document.createElement('td'); td.textContent = text; td.className = cls; return td; };
    const head = document.createElement('tr');
    for (const h of ['#', 'NAME', 'SCORE', 'PROGRESS', 'TIME']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    const rows = this.fame.list.map((e, i) => {
      const tr = document.createElement('tr');
      tr.append(cell(String(i + 1)), cell(e.name), cell(e.score.toLocaleString('en-US'), 'num'),
        cell(e.complete ? 'CLEARED' : `SCENE ${Math.min(LEVEL.length, e.scenes + 1)} / ${LEVEL.length}`), cell(clock(e.time), 'num'));
      return tr;
    });
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = cell('NO RUNS YET: GO MAKE HISTORY'); td.colSpan = 5;
      tr.append(td);
      rows.push(tr);
    }
    this.table.replaceChildren(head, ...rows);
    document.body.classList.add('fame');
  }

  close(): void { document.body.classList.remove('fame'); }
}
