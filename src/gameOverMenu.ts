import { MenuList } from './menuList';

export interface GameOverMenuDeps {
  /** is the game over (and the screen up)? */
  isOver: () => boolean;
  onRetry: () => void;
  onQuit: () => void;
}

/** The buttons on the game-over screen (index.html): retry the level, or go back to the main menu. */
export class GameOverMenu {
  private readonly list: MenuList;

  constructor(deps: GameOverMenuDeps) {
    this.list = new MenuList(document.getElementById('over')!, (action) => {
      if (action === 'retry') { this.list.select(0); deps.onRetry(); }
      else if (action === 'quit') deps.onQuit();
    });
    addEventListener('keydown', (e) => {
      // typing a name into the box is not a menu key
      if (document.activeElement instanceof HTMLInputElement) return;
      if (deps.isOver() && this.list.key(e.code)) e.preventDefault();
    });
  }
}
