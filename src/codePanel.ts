import { LEVEL_NO, levelForCode } from './levelData';
import { queueLevel, unlockLevel, unlockedLevels } from './levelSelect';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/**
 * "Enter level code" on the main menu: type a level's password (shown on the win screen of the level before it) and go
 * straight there. Esc closes it.
 */
export class CodePanel {
  private readonly form = $('code-form') as HTMLFormElement;
  private readonly input = $('code-input') as HTMLInputElement;
  private readonly note = $('code-note');
  private readonly hint = $('code-hint');

  /** @param onSame the code was for the level this page already plays: just start it */
  constructor(private readonly onSame: () => void) {
    this.input.addEventListener('input', () => { this.input.value = this.input.value.toUpperCase().replace(/[^A-Z]/g, ''); this.note.textContent = ''; });
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    addEventListener('keydown', (e) => {
      if (!this.visible) return;
      if (e.code === 'Escape') { e.preventDefault(); this.close(); }
      e.stopPropagation();                // typing a password is not a menu key
    }, true);
  }

  get visible(): boolean { return document.body.classList.contains('code'); }

  open(): void {
    const reached = unlockedLevels();
    this.hint.textContent = `LEVELS REACHED: ${reached.join(', ')}`;
    this.input.value = '';
    this.note.textContent = '';
    document.body.classList.add('code');
    setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    this.input.blur();
    document.body.classList.remove('code');
  }

  private submit(): void {
    const n = levelForCode(this.input.value);
    if (!n) {
      this.note.textContent = 'WRONG CODE';
      this.form.classList.remove('shake');
      void this.form.offsetWidth;
      this.form.classList.add('shake');
      return;
    }
    unlockLevel(n);
    this.close();
    if (n === LEVEL_NO) { document.body.classList.remove('menu'); this.onSame(); return; }
    queueLevel(n);                         // the page plays one level: a fresh page, straight into it
    location.reload();
  }
}


