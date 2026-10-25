import { SOUND_IDS, soundDef, type AudioEngine, type LoopHandle, type SoundId } from './audio';

/**
 * A debug panel for listening to every sound event on its own (F2, or ?sounds in the address): play buttons, a
 * position and a muffle slider to hear the distance treatment, bus volumes, and a live voice count. Loops toggle.
 */
export class SoundTest {
  private readonly root = document.createElement('div');
  private readonly count = document.createElement('div');
  private readonly loops = new Map<SoundId, LoopHandle>();
  private x = 0;
  private muffle = 0;
  private open = false;

  constructor(private readonly audio: AudioEngine) {
    const style = document.createElement('style');
    style.textContent = `
      #soundtest { position: fixed; right: 12px; top: 12px; bottom: 12px; width: 300px; overflow: auto; z-index: 50; display: none;
        font: 12px monospace; color: #ffb347; background: rgba(2,6,10,0.92); border: 1px solid #ffb347; padding: 10px; }
      #soundtest button { font: inherit; color: #ffb347; background: #1a1208; border: 1px solid #ffb347; cursor: pointer; padding: 1px 8px; }
      #soundtest button.on { background: #ffb347; color: #000; }
      #soundtest .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 3px 0; }
      #soundtest .file { color: #7dff9a; } #soundtest .synth { opacity: 0.55; }
      #soundtest input[type=range] { width: 140px; }
    `;
    document.head.append(style);
    this.root.id = 'soundtest';
    document.body.append(this.root);
    this.build();
    addEventListener('keydown', (e) => { if (e.code === 'F2') { e.preventDefault(); this.toggle(); } });
    if (new URLSearchParams(location.search).has('sounds')) this.toggle();
    setInterval(() => { if (this.open) this.count.textContent = `voices: ${audio.voiceCount}`; }, 200);
  }

  private toggle(): void {
    this.open = !this.open;
    this.root.style.display = this.open ? 'block' : 'none';
    if (this.open) { this.audio.unlock(); this.build(); }
  }

  private slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const input = document.createElement('input');
    input.type = 'range';
    Object.assign(input, { min, max, step, value });
    input.addEventListener('input', () => onInput(Number(input.value)));
    row.append(label, input);
    return row;
  }

  private build(): void {
    const { root, audio } = this;
    root.replaceChildren();
    const title = document.createElement('div');
    title.textContent = 'SOUNDS  (F2 closes)';
    root.append(title, this.count,
      this.slider('master', 0, 1.5, 0.05, 1, (v) => audio.setVolume('master', v)),
      this.slider('sfx', 0, 1.5, 0.05, 1, (v) => audio.setVolume('sfx', v)),
      this.slider('ambience', 0, 1.5, 0.05, 1, (v) => audio.setVolume('ambience', v)),
      this.slider('music', 0, 1.5, 0.05, 1, (v) => audio.setVolume('music', v)),
      this.slider('position x', -30, 30, 1, this.x, (v) => { this.x = v; this.updateLoops(); }),
      this.slider('muffle', 0, 1, 0.05, this.muffle, (v) => { this.muffle = v; this.updateLoops(); }));
    for (const id of SOUND_IDS) {
      const def = soundDef(id);
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = `${id}${def.loop ? ' ∞' : ''}`;
      name.className = audio.fromFile.has(id) ? 'file' : 'synth';
      name.title = audio.fromFile.has(id) ? 'recording' : 'placeholder';
      const btn = document.createElement('button');
      btn.textContent = '▶';
      btn.addEventListener('click', () => {
        audio.unlock();
        if (def.loop) {
          const running = this.loops.get(id);
          if (running) { running.stop(); this.loops.delete(id); btn.classList.remove('on'); }
          else { this.loops.set(id, audio.loop(id, this.opts())); btn.classList.add('on'); }
        } else {
          audio.play(id, this.opts());
        }
      });
      row.append(name, btn);
      root.append(row);
    }
  }

  private opts(): { x: number; muffle: number } { return { x: this.x, muffle: this.muffle }; }

  private updateLoops(): void { for (const h of this.loops.values()) h.set(this.opts()); }
}
