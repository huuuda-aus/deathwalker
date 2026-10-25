import { MenuList } from './menuList';

export interface PauseMenuDeps {
  /** is there a game to pause right now (not the main menu, not game over)? */
  canPause: () => boolean;
  onPause: () => void;
  onResume: () => void;
  onQuit: () => void;
}

/**
 * The pause menu: Esc during the game opens an HTML overlay (index.html) over the frozen scene; Esc again, or
 * "resume", carries on, and "back to main menu" abandons the game.
 */
export class PauseMenu {
  private readonly list: MenuList;

  constructor(private readonly deps: PauseMenuDeps) {
    this.list = new MenuList(document.getElementById('pause')!, (action) => {
      if (action === 'resume') this.close();
      else if (action === 'quit') deps.onQuit();
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.open) this.close();
        else if (deps.canPause()) this.show();
        else return;
      } else if (!this.open || !this.list.key(e.code)) {
        return;
      }
      e.preventDefault();
    });
  }

  get open(): boolean { return document.body.classList.contains('paused'); }

  private show(): void {
    this.list.select(0);
    document.body.classList.add('paused');
    this.deps.onPause();
  }

  private close(): void {
    document.body.classList.remove('paused');
    this.deps.onResume();
  }
}
