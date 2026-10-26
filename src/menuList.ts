/**
 * A vertical list of menu items (index.html `.menu-items`) picked with the mouse or up/down + enter: the part the
 * pause menu and the game-over menu have in common. Each item's `data-action` is handed to `onPick`. Items can come and
 * go (an item with the `hidden` attribute is skipped).
 */
export class MenuList {
  private selected = 0;

  constructor(private readonly list: ParentNode, private readonly onPick: (action: string) => void) {
    const itemOf = (e: Event): number => this.items.indexOf((e.target as HTMLElement).closest('.menu-items li') as HTMLElement);
    list.addEventListener('pointerover', (e) => { const i = itemOf(e); if (i >= 0) this.select(i); });
    list.addEventListener('click', (e) => { const i = itemOf(e); if (i >= 0) { this.select(i); this.pick(); } });
    this.select(0);
  }

  private get items(): HTMLElement[] { return [...this.list.querySelectorAll<HTMLElement>('.menu-items li:not([hidden])')]; }

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

  private pick(): void { this.onPick(this.items[this.selected]?.dataset.action ?? ''); }
}
