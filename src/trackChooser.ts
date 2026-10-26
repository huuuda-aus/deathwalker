import { audio } from './audio';

const KEY = 'walker.track';

/** the main menu's soundtracks (`public/audio/music_<id>.opus`), in the order the chooser lists them */
const TRACKS = [
  { id: 'menu', title: 'Steel Sky' },
  { id: 'menu2', title: 'Be Crushed' },
  { id: 'menu3', title: 'Run And Gun' },
];
export const MENU_TRACKS = TRACKS.map((t) => t.id);

/** the track the player last chose, if any */
export function savedTrack(): string | null {
  try {
    const t = localStorage.getItem(KEY);
    return t !== null && MENU_TRACKS.includes(t) ? t : null;
  } catch { return null; }
}

/** The soundtrack buttons in the corner of the main menu, one per track, named: click one (or press 1, 2, 3) to switch the soundtrack. The choice is remembered. */
export class TrackChooser {
  private readonly buttons: HTMLButtonElement[];

  /** @param current the track playing now */
  constructor(private current: string) {
    const box = document.getElementById('tracks')!;
    this.buttons = TRACKS.map(({ id, title }, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.textContent = title;
      b.title = `${i + 1}: ${title}`;
      b.addEventListener('click', () => { this.pick(id); b.blur(); });
      box.append(b);
      return b;
    });
    addEventListener('keydown', (e) => {
      if (!document.body.classList.contains('menu') || document.body.classList.contains('booting') || document.body.classList.contains('fame') || document.body.classList.contains('settings')) return;
      const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
      if (i >= 0 && i < MENU_TRACKS.length) this.pick(MENU_TRACKS[i]);
    });
    this.mark();
  }

  private pick(name: string): void {
    if (name === this.current) return;
    this.current = name;
    try { localStorage.setItem(KEY, name); } catch { /* not remembered */ }
    audio.playMusic(name, 1.2);
    this.mark();
  }

  private mark(): void {
    this.buttons.forEach((b, i) => {
      const on = MENU_TRACKS[i] === this.current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
}
