import { MenuList } from './menuList';

export interface GameOverMenuDeps {
  /** is the game over (and the screen up)? */
  isOver: () => boolean;
  onNext: () => void;
  onRetry: () => void;
  onQuit: () => void;
}

/** The buttons on the game-over screen (index.html): on to the next level (after a win, if there is one), retry the level, or go back to the main menu. */
export class GameOverMenu {
  private readonly list: MenuList;

  /** the screen comes up: the "next level" button is there only after a win with a level to go to */
  show(next: boolean): void {
    document.querySelector<HTMLElement>('#over [data-action="next"]')!.hidden = !next;
    this.list.select(0);
  }

  constructor(deps: GameOverMenuDeps) {
    this.list = new MenuList(document.getElementById('over')!, (action) => {
      if (action === 'next') deps.onNext();
      else if (action === 'retry') { this.list.select(0); deps.onRetry(); }
      else if (action === 'quit') deps.onQuit();
    });
    addEventListener('keydown', (e) => {
      // typing a name into the box is not a menu key
      if (document.activeElement instanceof HTMLInputElement) return;
      if (deps.isOver() && this.list.key(e.code)) e.preventDefault();
    });
  }
}
