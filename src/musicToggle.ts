import { audio } from './audio';

const KEY = 'walker.music';
const ICON_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path class="w" d="M15.5 8.5a5 5 0 0 1 0 7M18.2 5.8a9 9 0 0 1 0 12.4"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path class="w" d="M16 9.5l5 5m0-5l-5 5"/></svg>';

/** The speaker button in the corner of the main menu: music on or off (remembered between visits). Also M. */
export class MusicToggle {
  private readonly btn = document.getElementById('music-toggle') as HTMLButtonElement;
  private on = true;

  constructor() {
    try { this.on = localStorage.getItem(KEY) !== 'off'; } catch { /* storage blocked: music stays on */ }
    this.apply();
    this.btn.addEventListener('click', () => { this.toggle(); this.btn.blur(); });
    addEventListener('keydown', (e) => { if (e.code === 'KeyM' && document.body.classList.contains('menu')) this.toggle(); });
  }

  private toggle(): void {
    this.on = !this.on;
    try { localStorage.setItem(KEY, this.on ? 'on' : 'off'); } catch { /* not remembered */ }
    this.apply();
  }

  private apply(): void {
    audio.setVolume('music', this.on ? 1 : 0, 0.4);
    this.btn.innerHTML = this.on ? ICON_ON : ICON_OFF;
    this.btn.title = this.on ? 'Music on (M)' : 'Music off (M)';
    this.btn.setAttribute('aria-pressed', String(this.on));
    document.getElementById('music-box')?.classList.toggle('off', !this.on);
  }
}
