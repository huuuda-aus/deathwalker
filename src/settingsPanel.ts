import { MenuList } from './menuList';
import { view, setMirror } from './view';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** The settings page, on the main menu and on the pause menu: for now, which way the game scrolls. Esc or "back" closes it. */
export class SettingsPanel {
  private readonly list = new MenuList($('settings'), (action) => {
    if (action === 'mirror') this.toggle();
    else if (action === 'back') this.close();
  });
  private readonly direction = $('setting-direction');

  constructor() {
    this.show();
    addEventListener('keydown', (e) => {
      if (!this.visible) return;
      if (e.code === 'Escape') this.close();
      else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyA' || e.code === 'KeyD') this.toggle();
      else if (!this.list.key(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  get visible(): boolean { return document.body.classList.contains('settings'); }

  open(): void {
    this.list.select(0);
    this.show();
    document.body.classList.add('settings');
  }

  close(): void { document.body.classList.remove('settings'); }

  private toggle(): void {
    setMirror(!view.mirror);
    this.show();
  }

  private show(): void {
    this.direction.textContent = view.mirror ? '▶ LEFT TO RIGHT' : '◀ RIGHT TO LEFT';
  }
}

/** the one settings page: the main menu and the pause menu both open it */
export const settingsPanel = new SettingsPanel();
