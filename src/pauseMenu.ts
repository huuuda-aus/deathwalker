export interface PauseMenuDeps {
  /** is there a game to pause right now (not the main menu, not game over)? */
  canPause: () => boolean;
  onPause: () => void;
  onResume: () => void;
  onQuit: () => void;
}

/**
 * The pause menu: Esc during the game opens an HTML overlay (index.html) over the frozen scene; Esc again, or
 * "resume", carries on, and "back to main menu" abandons the game. Mouse or keyboard (up/down, enter) pick an item.
 */
export class PauseMenu {
  private readonly root = document.getElementById('pause')!;
  private readonly items = [...this.root.querySelectorAll<HTMLElement>('.menu-items li')];
  private selected = 0;

  constructor(private readonly deps: PauseMenuDeps) {
    this.items.forEach((li, i) => {
      li.addEventListener('pointerenter', () => this.select(i));
      li.addEventListener('click', () => { this.select(i); this.activate(); });
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.open) this.close();
        else if (deps.canPause()) this.show();
        else return;
      } else if (!this.open) {
        return;
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') this.select((this.selected + 1) % this.items.length);
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') this.select((this.selected + this.items.length - 1) % this.items.length);
      else if (e.code === 'Enter' || e.code === 'Space') this.activate();
      else return;
      e.preventDefault();
    });
    this.select(0);
  }

  get open(): boolean { return document.body.classList.contains('paused'); }

  private show(): void {
    this.select(0);
    document.body.classList.add('paused');
    this.deps.onPause();
  }

  private close(): void {
    document.body.classList.remove('paused');
    this.deps.onResume();
  }

  private select(i: number): void {
    this.selected = i;
    this.items.forEach((li, k) => li.classList.toggle('sel', k === i));
  }

  private activate(): void {
    const action = this.items[this.selected].dataset.action;
    if (action === 'resume') this.close();
    else if (action === 'quit') this.deps.onQuit();
  }
}
