/** One layer of a placeholder sound; see the notes in sounds.json. */
export interface SynthLayer {
  type: 'noise' | 'sine' | 'saw' | 'square';
  f0?: number;
  f1?: number;
  lp?: number;
  hp?: number;
  decay?: number;
  attack?: number;
  period?: number;
  vibrato?: number;
  delay?: number;
  amp?: number;
}

export interface SynthDef { dur: number; layers: SynthLayer[] }

/**
 * A rough stand-in for a recording: layers of noise and tones with envelopes, summed and peak-normalized. It plays
 * until a real sample is dropped into audio-src/ and `npm run audio` has been run. Loops use whole cycles so they
 * wrap without a click.
 */
export function synthBuffer(ctx: BaseAudioContext, def: SynthDef, loop: boolean): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(def.dur * sr));
  const out = new Float32Array(n);
  for (const L of def.layers) {
    const amp = L.amp ?? 1;
    // a looped tone fits whole cycles in the buffer, so its ends meet
    const snap = (f: number): number => (loop ? Math.max(1, Math.round(f * def.dur)) / def.dur : f);
    const f0 = snap(L.f0 ?? 440), f1 = snap(L.f1 ?? L.f0 ?? 440);
    const start = Math.round((L.delay ?? 0) * sr);
    let phase = 0, lo = 0, lo2 = 0;
    for (let i = start; i < n; i++) {
      const t = (i - start) / sr;
      let tt = t;
      if (L.period) tt = t % L.period;
      let env = 1;
      if (L.decay) env = Math.exp(-tt / L.decay);
      if (L.attack) env *= Math.min(1, tt / L.attack);
      let v: number;
      if (L.type === 'noise') {
        const x = Math.random() * 2 - 1;
        lo += (L.lp ?? 1) * (x - lo);
        v = lo;
        if (L.hp) { lo2 += L.hp * (v - lo2); v -= lo2; }
      } else {
        const f = f0 + (f1 - f0) * (t / def.dur) + (L.vibrato ? Math.sin(2 * Math.PI * L.vibrato * t) * f0 * 0.04 : 0);
        phase += (2 * Math.PI * f) / sr;
        const s = Math.sin(phase);
        v = L.type === 'sine' ? s : L.type === 'square' ? Math.sign(s) * 0.6 : 2 * ((phase / (2 * Math.PI)) % 1) - 1;
      }
      out[i] += v * env * amp;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 0 ? 0.9 / peak : 1;
  const buf = ctx.createBuffer(1, n, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = out[i] * k;
  return buf;
}
