/**
 * A vertical list of menu items (index.html `.menu-items`) picked with the mouse or up/down + enter: the part the
 * pause menu and the game-over menu have in common. Each item's `data-action` is handed to `onPick`.
 */
export class MenuList {
  private readonly items: HTMLElement[];
  private selected = 0;

  constructor(list: ParentNode, private readonly onPick: (action: string) => void) {
    this.items = [...list.querySelectorAll<HTMLElement>('.menu-items li')];
    this.items.forEach((li, i) => {
      li.addEventListener('pointerenter', () => this.select(i));
      li.addEventListener('click', () => { this.select(i); this.pick(); });
    });
    this.select(0);
  }

  select(i: number): void {
    this.selected = i;
    this.items.forEach((li, k) => li.classList.toggle('sel', k === i));
  }

  /** Handle a key press; true if it was one of the list's keys. */
  key(code: string): boolean {
    const n = this.items.length;
    if (code === 'ArrowDown' || code === 'KeyS') this.select((this.selected + 1) % n);
    else if (code === 'ArrowUp' || code === 'KeyW') this.select((this.selected + n - 1) % n);
    else if (code === 'Enter' || code === 'Space') this.pick();
    else return false;
    return true;
  }

  private pick(): void { this.onPick(this.items[this.selected].dataset.action ?? ''); }
}
