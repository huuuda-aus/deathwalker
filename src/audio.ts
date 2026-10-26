import raw from './sounds.json';
import { synthBuffer, type SynthDef } from './synth';
import { view } from './view';

export type BusName = 'sfx' | 'ambience' | 'music';

interface SoundDef {
  bus: 'sfx' | 'ambience';
  priority: number;
  voices: number;
  gap: number;
  pitch: number;
  gain: number;
  lufs: number;
  loop?: boolean;
  synth: SynthDef;
}

const DEFS = (raw as unknown as { sounds: Record<string, SoundDef> }).sounds;
export type SoundId = keyof typeof raw.sounds;
export const SOUND_IDS = Object.keys(DEFS) as SoundId[];
export const soundDef = (id: SoundId): SoundDef => DEFS[id];

/**
 * most one-shot sounds playing at once; past it the lowest priority is dropped. Loops (the machine gun, engines, the weather)
 * are not counted and never dropped: there are only a handful, and the gun must never be cut off by a burst of explosions.
 */
const MAX_VOICES = 64;
/** the lowest the low-pass goes for a far or muffled sound (Hz), and its open setting */
const CUT_MIN = 450;
const CUT_OPEN = 20000;
/** sounds beyond the screen edge fade by this much per world unit */
const FAR_FALLOFF = 0.07;
/** a muffled-by-distance sound loses this much cutoff (octaves) per world unit beyond the screen */
const FAR_MUFFLE = 0.16;

export interface PlayOpts {
  /** where it happens (world x): it is panned and softened by distance from the view */
  x?: number;
  /** 0 = clear .. 1 = as muffled as it gets (a blast heard through walls and distance) */
  muffle?: number;
  gain?: number;
  /** speed multiplier (1 = as recorded) on top of the random variation */
  rate?: number;
  /** seconds from now */
  delay?: number;
}

interface Voice {
  id: SoundId;
  loop?: boolean;
  priority: number;
  src: AudioBufferSourceNode;
  out: GainNode;
}

/** A running loop: its volume and speed (and where it is) can be moved while it plays. */
export interface LoopHandle {
  set(opts: { gain?: number; rate?: number; x?: number; muffle?: number }, ramp?: number): void;
  stop(fade?: number): void;
}

/**
 * The game's sound. Web Audio does the mixing off the main thread; this keeps the graph (sfx and ambience buses
 * into a limiter), loads the samples (or their synthesized stand-ins), and places each sound in the stereo field with
 * a pan and a distance low-pass. A voice cap with priorities and per-sound rate limits keep many simultaneous
 * sounds cheap.
 */
export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly master = this.ctx.createGain();
  private readonly buses: Record<BusName, GainNode> = { sfx: this.ctx.createGain(), ambience: this.ctx.createGain(), music: this.ctx.createGain() };
  /** the music playing (streamed from a file, not decoded whole), and whether it is wanted: it starts as soon as the browser allows */
  private music: { el: HTMLAudioElement; gain: GainNode; fade: number } | null = null;
  /** settles once the track chosen last has buffered enough to play right through (or failed to: sound is never worth hanging the game for) */
  musicReady: Promise<void> = Promise.resolve();
  private readonly buffers = new Map<SoundId, AudioBuffer[]>();
  /** which sounds are real recordings and which are placeholders (for the test panel) */
  readonly fromFile = new Set<SoundId>();
  private readonly voices = new Set<Voice>();
  /** how many of them are one-shots (what the voice cap counts) */
  private oneShots = 0;
  private readonly active = new Map<SoundId, number>();
  private readonly lastPlay = new Map<SoundId, number>();
  private readonly lastPick = new Map<SoundId, number>();
  private camX = 0;
  private half = 12;
  /** where the view is (world x) */
  get listenerX(): number { return this.camX; }
  ready = false;

  constructor() {
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    this.buses.sfx.connect(limiter);
    this.buses.ambience.connect(limiter);
    this.buses.music.connect(limiter);
    limiter.connect(this.master);
    this.master.connect(this.ctx.destination);
    // placeholders at once, so every event has a sound; recordings replace them as they load
    for (const id of SOUND_IDS) this.buffers.set(id, [synthBuffer(this.ctx, DEFS[id].synth, !!DEFS[id].loop)]);
  }

  /** Fetch whatever recordings exist (public/audio/index.json lists them) and decode them. Missing ones stay placeholders. */
  async load(): Promise<void> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio/index.json`);
      if (!res.ok) throw new Error(String(res.status));
      const index = (await res.json()) as Record<string, number>;
      await Promise.all(Object.entries(index).map(async ([id, count]) => {
        if (!(id in DEFS)) return;
        const list: AudioBuffer[] = [];
        for (let n = 1; n <= count; n++) {
          const r = await fetch(`${import.meta.env.BASE_URL}audio/${id}_${n}.opus`);
          if (r.ok) list.push(await this.ctx.decodeAudioData(await r.arrayBuffer()));
        }
        if (list.length) { this.buffers.set(id as SoundId, list); this.fromFile.add(id as SoundId); }
      }));
    } catch { /* no recordings yet: the placeholders play */ }
    this.ready = true;
  }

  /** Browsers keep audio off until the player has done something: call this from a click or key press. */
  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.startMusic();
  }

  /** Play a track from public/audio/music_<name>.opus on a loop, fading in. It waits for the browser to allow sound (a click or key press). */
  playMusic(name: string, fade = 2): void {
    this.stopMusic(Math.min(fade, 1));
    const el = new Audio(`${import.meta.env.BASE_URL}audio/music_${name}.opus`);
    el.loop = true;
    el.preload = 'auto';
    this.musicReady = new Promise((done) => {
      el.addEventListener('canplaythrough', () => done(), { once: true });
      el.addEventListener('error', () => done(), { once: true });
    });
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    this.ctx.createMediaElementSource(el).connect(gain);
    gain.connect(this.buses.music);
    this.music = { el, gain, fade };
    this.startMusic();
  }

  /** Fade the music out and let it go. */
  stopMusic(fade = 1.5): void {
    const m = this.music;
    if (!m) return;
    this.music = null;
    m.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    m.gain.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.02, fade / 3));
    setTimeout(() => { m.el.pause(); m.gain.disconnect(); }, fade * 1000 + 200);
  }

  private startMusic(): void {
    const m = this.music;
    if (!m || !m.el.paused) return;
    // refused until the player has clicked or pressed something: unlock() tries again then
    m.el.play().then(() => {
      if (this.music === m) m.gain.gain.setTargetAtTime(1, this.ctx.currentTime, m.fade / 3);
    }).catch(() => {});
  }
  suspend(): void { void this.ctx.suspend(); }
  resume(): void { void this.ctx.resume(); }

  /** @param ramp seconds to glide there (0 = at once) */
  setVolume(bus: BusName | 'master', v: number, ramp = 0): void {
    const g = (bus === 'master' ? this.master : this.buses[bus]).gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    if (ramp > 0) g.setTargetAtTime(v, this.ctx.currentTime, ramp / 3);
    else g.value = v;
  }

  get voiceCount(): number { return this.voices.size; }

  /** Tell it where the view is (camera x, half the visible width): positions are relative to it. */
  setListener(camX: number, half: number): void { this.camX = camX; this.half = half; }

  /** Play a sound once. Returns false if it was dropped (rate limit, too many of it, or no room). */
  play(id: SoundId, opts: PlayOpts = {}): boolean {
    const def = DEFS[id];
    const { ctx } = this;
    const now = ctx.currentTime;
    if (ctx.state !== 'running') return false;
    if (now - (this.lastPlay.get(id) ?? -1) < def.gap) return false;
    if ((this.active.get(id) ?? 0) >= def.voices) return false;
    if (this.oneShots >= MAX_VOICES && !this.makeRoom(def.priority)) return false;
    const bufs = this.buffers.get(id)!;
    let pick = Math.floor(Math.random() * bufs.length);
    if (bufs.length > 1 && pick === this.lastPick.get(id)) pick = (pick + 1) % bufs.length;
    this.lastPick.set(id, pick);
    this.lastPlay.set(id, now);

    const src = ctx.createBufferSource();
    src.buffer = bufs[pick];
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * def.pitch);
    const out = ctx.createGain();
    const { chain, gain } = this.place(src, def, opts);
    out.gain.value = gain;
    chain.connect(out);
    out.connect(this.buses[def.bus]);
    const voice: Voice = { id, priority: def.priority, src, out };
    this.voices.add(voice);
    this.oneShots++;
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    src.onended = () => this.release(voice);
    src.start(now + (opts.delay ?? 0));
    return true;
  }

  /** Start a looping sound (engine, rain, gun fire). It runs until `stop`; the handle moves its gain and speed. */
  loop(id: SoundId, opts: PlayOpts = {}): LoopHandle {
    const def = DEFS[id];
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(id)![0];
    src.loop = true;
    src.playbackRate.value = opts.rate ?? 1;
    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const pan = ctx.createStereoPanner();
    src.connect(filter);
    filter.connect(pan);
    pan.connect(out);
    out.connect(this.buses[def.bus]);
    const voice: Voice = { id, priority: def.priority, src, out, loop: true };
    this.voices.add(voice);
    const apply = (o: PlayOpts, ramp: number): void => {
      const s = this.spatial(o);
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(def.gain * (o.gain ?? 1) * s.gain, t, Math.max(0.001, ramp));
      filter.frequency.setTargetAtTime(s.cutoff, t, Math.max(0.001, ramp));
      pan.pan.setTargetAtTime(s.pan, t, Math.max(0.001, ramp));
      if (o.rate !== undefined) src.playbackRate.setTargetAtTime(o.rate, t, Math.max(0.001, ramp));
    };
    apply(opts, 0.05);
    src.start();
    let stopped = false;
    let last: PlayOpts = { ...opts };
    return {
      set: (o, ramp = 0.1) => { if (stopped) return; last = { ...last, ...o }; apply(last, ramp); },
      stop: (fade = 0.2) => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(0, t, fade / 3);
        src.stop(t + fade * 1.5 + 0.05);
        src.onended = () => this.release(voice);
      },
    };
  }

  /** pan, loudness and low-pass cutoff for a sound at `opts.x` (world) and `opts.muffle` */
  private spatial(opts: PlayOpts): { pan: number; gain: number; cutoff: number } {
    let pan = 0, gain = 1, octaves = 0;
    if (opts.x !== undefined) {
      const dx = opts.x - this.camX;
      pan = Math.max(-1, Math.min(1, dx / this.half)) * 0.8 * (view.mirror ? -1 : 1);
      const beyond = Math.max(0, Math.abs(dx) - this.half);
      gain = 1 / (1 + beyond * FAR_FALLOFF);
      octaves += beyond * FAR_MUFFLE;
    }
    const m = Math.max(0, Math.min(1, opts.muffle ?? 0));
    const cutoff = Math.max(CUT_MIN, CUT_OPEN * Math.pow(2, -octaves) * Math.pow(CUT_MIN / CUT_OPEN, m));
    return { pan, gain, cutoff };
  }

  /** wire `src` through a low-pass (only when it is far or muffled) and a pan; returns the end of the chain */
  private place(src: AudioBufferSourceNode, def: SoundDef, opts: PlayOpts): { chain: AudioNode; gain: number } {
    const { ctx } = this;
    const s = this.spatial(opts);
    let node: AudioNode = src;
    if (s.cutoff < CUT_OPEN * 0.9) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = s.cutoff;
      node.connect(f);
      node = f;
    }
    if (opts.x !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = s.pan;
      node.connect(p);
      node = p;
    }
    return { chain: node, gain: def.gain * (opts.gain ?? 1) * s.gain };
  }

  /** Drop the quietest-priority voice that is below `priority`; true if there is room now. */
  private makeRoom(priority: number): boolean {
    let worst: Voice | null = null;
    for (const v of this.voices) if (!v.loop && v.priority < priority && (!worst || v.priority < worst.priority)) worst = v;
    if (!worst) return false;
    const t = this.ctx.currentTime;
    worst.out.gain.cancelScheduledValues(t);
    worst.out.gain.setTargetAtTime(0, t, 0.01);
    worst.src.stop(t + 0.05);
    this.release(worst);
    return true;
  }

  private release(v: Voice): void {
    if (!this.voices.delete(v)) return;
    if (!v.loop) this.oneShots--;
    this.active.set(v.id, Math.max(0, (this.active.get(v.id) ?? 1) - 1));
    v.src.disconnect();
    v.out.disconnect();
  }
}

/** The game's one speaker: sound is a global service (like the screen), so any system can make noise without plumbing. */
export const audio = new AudioEngine();
