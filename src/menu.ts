const NOTES: Record<string, string> = {
  code: 'ENTER LEVEL CODE: coming soon',
  credits: 'CREDITS: coming soon',
};

/**
 * The main menu: an HTML overlay (index.html) over the live skyline. Mouse or keyboard (up/down, enter) pick an
 * item; only "start game" does anything yet, the others show a placeholder note.
 */
export class Menu {
  /** what the items that do something other than start the game do (by `data-action`) */
  private readonly actions: Record<string, () => void>;
  private readonly items = [...document.querySelectorAll<HTMLElement>('#menu-items li')];
  private readonly note = document.getElementById('menu-note')!;
  private selected = 0;
  private noteTimer = 0;

  constructor(private readonly onStart: () => void, actions: Record<string, () => void> = {}) {
    this.actions = actions;
    this.items.forEach((li, i) => {
      li.addEventListener('pointerenter', () => this.select(i));
      li.addEventListener('click', () => { this.select(i); this.activate(); });
    });
    addEventListener('keydown', (e) => {
      if (!this.visible || document.body.classList.contains('fame') || document.body.classList.contains('settings')) return;
      if (e.code === 'ArrowDown' || e.code === 'KeyS') this.select((this.selected + 1) % this.items.length);
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') this.select((this.selected + this.items.length - 1) % this.items.length);
      else if (e.code === 'Enter' || e.code === 'Space') this.activate();
      else return;
      e.preventDefault();
    });
    this.select(0);
  }

  get visible(): boolean { return document.body.classList.contains('menu'); }

  private select(i: number): void {
    this.selected = i;
    this.items.forEach((li, k) => li.classList.toggle('sel', k === i));
  }

  private activate(): void {
    const action = this.items[this.selected].dataset.action ?? '';
    if (action === 'start') {
      document.body.classList.remove('menu');
      this.onStart();
      return;
    }
    const act = this.actions[action];
    if (act) { act(); return; }
    this.note.textContent = NOTES[action] ?? '';
    this.note.classList.add('on');
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => this.note.classList.remove('on'), 2200);
  }
}
