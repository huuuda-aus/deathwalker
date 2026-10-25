// Fetches the free (CC0) sound packs the game's sounds are made from, and cuts, layers and loops them into the
// recordings that scripts/audio.mjs then normalizes and encodes.
//   npm run audio:samples      download the packs (once) and build audio-src/<sound id>/*.wav
//   npm run audio              normalize and encode them into public/audio
// Sources and licenses are listed in public/audio/CREDITS.md.
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import ffmpeg from 'ffmpeg-static';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'audio-src');
const packs = join(src, '_packs');
const OGA = 'https://opengameart.org/sites/default/files/';

/** pack name -> file to download; zips are unpacked into audio-src/_packs/<name>/ */
const PACKS = {
  bangs: '25-CC0-bang-sfx.zip',
  guns: 'sounds.zip',
  sfx100: '100-CC0-SFX_0.zip',
  sfx100b: 'sfx_100_v2.zip',
  owlish: 'Owlish%20Media%20Sound%20Effects.zip',
  yelling: 'yelling%20sounds.zip',
  rain: 'Rain%20OGG.zip',
  wind: 'wind.zip',
  stomp: 'stomp.flac',
  missile: 'missile.wav',
  whoosh: 'whoosh2_0.wav',
  rumble: 'rumble.wav',
  mech: ['clank1.wav', 'mechanical1.wav', 'mechanical2.wav', 'rattle1.wav', 'squeakyclick1.wav'],
};

async function fetchFile(name, file) {
  const dir = join(packs, name);
  const out = join(dir, decodeURIComponent(file));
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  console.log(`downloading ${file}`);
  const res = await fetch(OGA + file);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
  if (out.endsWith('.zip')) new AdmZip(out).extractAllTo(dir, true);
  return out;
}

// ---- recipes ------------------------------------------------------------------------------------------------
const P = (p) => join(packs, p);
/** a numbered file in a pack folder of the owlish / yelling / wind zips etc. */
const X = {
  bang: (n) => P(`bangs/${n}.ogg`),
  a: (n) => P(`sfx100/${n}.ogg`),
  b: (n) => P(`sfx100b/sfx100v2_${n}.ogg`),
  gun: (n) => P(`guns/sounds/${n}.wav`),
  owl: (n) => P(`owlish/${n}.wav`),
  yell: (n) => P(`yelling/yelling sounds/${n}.wav`),
  mech: (n) => P(`mech/${n}.wav`),
  stomp: P('stomp/stomp.flac'),
  missile: P('missile/missile.wav'),
  whoosh: P('whoosh/whoosh2_0.wav'),
  rumble: P('rumble/rumble.wav'),
};

/** `d` seconds crossfaded across the seam, so a sound of length `len` repeats without a click; reads label `from`, ends the graph */
const loopify = (from, len, d) =>
  `[${from}]asplit=3[l1][l2][l3];` +
  `[l1]atrim=start=${d}:end=${len - d},asetpts=PTS-STARTPTS[mid];` +
  `[l2]atrim=start=${len - d}:end=${len},afade=t=out:d=${d}:curve=qsin,asetpts=PTS-STARTPTS[tl];` +
  `[l3]atrim=start=0:end=${d},afade=t=in:d=${d}:curve=qsin,asetpts=PTS-STARTPTS[hd];` +
  `[tl][hd]amix=inputs=2:normalize=0:duration=longest[x];[mid][x]concat=n=2:v=0:a=1`;

/** every input at 48 kHz, so mixing and pitch changes work the same whatever the source */
const R = '[0:a]aresample=48000';
const slow = (k) => `asetrate=${Math.round(48000 * k)},aresample=48000`;
/** cap a sound at `len` seconds with a fade out of `f` */
const cap = (len, f = 0.1) => `atrim=0:${len},afade=t=out:st=${Math.max(0, len - f)}:d=${f}`;
/** a plain cut-and-fade of one file */
const one = (file, chain) => ({ inputs: [file], fc: `${R},${chain}` });
const shot = (file, t, len = 0.6) => ({ inputs: [file], fc: `${R},atrim=start=${Math.max(0, t - 0.02)}:end=${t + len},asetpts=PTS-STARTPTS,afade=t=out:st=${len - 0.15}:d=0.15` });
const mix = (a, b, chainA, chainB, after = 'anull') => ({
  inputs: [a, b],
  fc: `[0:a]aresample=48000,${chainA}[a];[1:a]aresample=48000,${chainB}[b];[a][b]amix=inputs=2:normalize=0,${after}`,
});
const verb = 'aecho=0.8:0.6:90|180:0.4|0.25';

/**
 * The machine gun: one second of 20 shots (the gun's fire rate), as a loop that repeats cleanly. The shots take turns among five
 * different recordings, each a little off the beat and a little different in volume, and between them the action clicks:
 * a faint metallic tick from the bolt (high-passed, 12 ms) half-way through each round.
 */
function gunLoop() {
  const SHOTS = 20, SHOT_LEN = 0.05, CLICK_LEN = 0.012;
  const shots = [[X.bang('shot_03'), 0], [X.bang('shot_01'), 0], [X.a('shot_02'), 0], [X.gun('cz'), 0.21], [X.bang('shot_02'), 0]];
  const clicks = [X.a('metal_02'), X.a('metal_11'), X.mech('mechanical1')];
  // a repeatable shuffle, so the loop is the same every build
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const order = Array.from({ length: SHOTS }, (_, i) => (i * 2 + Math.floor(i / 5)) % shots.length);
  const useCount = shots.map((_, j) => order.filter((x) => x === j).length);
  const clickCount = clicks.map((_, j) => Array.from({ length: SHOTS }, (_, i) => i % clicks.length).filter((x) => x === j).length);
  const mono = 'aresample=48000,aformat=channel_layouts=mono';
  const parts = [];
  shots.forEach(([, start], j) => parts.push(
    `[${j}:a]${mono},atrim=start=${start}:end=${start + 0.4},asetpts=PTS-STARTPTS,silenceremove=start_periods=1:start_threshold=-35dB,atrim=0:${SHOT_LEN},asetpts=PTS-STARTPTS,afade=t=out:st=0.034:d=0.016,apad=whole_dur=${SHOT_LEN},asplit=${Math.max(2, useCount[j])}${Array.from({ length: Math.max(2, useCount[j]) }, (_, k) => `[s${j}_${k}]`).join('')}`));
  clicks.forEach((_, j) => parts.push(
    `[${shots.length + j}:a]${mono},atrim=0:${CLICK_LEN},asetpts=PTS-STARTPTS,highpass=f=2500,afade=t=out:st=0.006:d=0.006,asplit=${Math.max(2, clickCount[j])}${Array.from({ length: Math.max(2, clickCount[j]) }, (_, k) => `[c${j}_${k}]`).join('')}`));
  const used = shots.map(() => 0), usedC = clicks.map(() => 0);
  const labels = [];
  for (let i = 0; i < SHOTS; i++) {
    const j = order[i], jit = i === 0 ? 0 : Math.round((rnd() - 0.5) * 3), at = i * 50 + jit;
    parts.push(`[s${j}_${used[j]++}]volume=${(0.8 + rnd() * 0.2).toFixed(2)},adelay=delays=${at}:all=1[p${i}]`);
    const c = i % clicks.length;
    parts.push(`[c${c}_${usedC[c]++}]volume=${(0.22 + rnd() * 0.1).toFixed(2)},adelay=delays=${i * 50 + 20}:all=1[q${i}]`);
    labels.push(`[p${i}]`, `[q${i}]`);
  }
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,apad=whole_dur=1,atrim=0:1`);
  return { inputs: [...shots.map(([f]) => f), ...clicks], fc: parts.join(';') };
}

const RECIPES = {
  gun: [gunLoop()],
  impactFlesh: ['hit', 'slap2', 'fruit1', 'fruit2'].map((n) => one(X.owl(`Impacts/${n}`), `${cap(0.4)},lowpass=f=4500`)),
  impactMetal: [X.a('metal_02'), X.a('metal_11'), X.a('metal_03'), X.a('metal_01'), X.b('metal_hit_01')].map((f) => one(f, cap(0.5))),
  impactWall: [X.b('hit_01'), X.b('hit_02'), X.a('hit_04'), X.a('hit_03')].map((f) => one(f, cap(0.4))),
  impactGround: [X.b('footstep_wet_01'), X.b('footstep_wet_02'), X.b('footstep_wet_03')].map((f) => one(f, `${cap(0.4)},lowpass=f=2500`)),
  impactRubble: [X.b('stones_01'), X.b('stones_02'), X.b('stones_03'), X.mech('rattle1')].map((f) => one(f, cap(0.5))),
  enemyShot: [shot(X.gun('cz'), 0.23), shot(X.gun('cz'), 2.82), shot(X.gun('sks'), 2.3), shot(X.gun('sks'), 0.35), shot(X.gun('mosin'), 0.44), shot(X.gun('mosin'), 1.66)],
  soldierScream: ['1yell12', '2yell11', '2yell7', '3yell10', '3yell12', 'yell4', 'yell7', '3yell15'].map((n) => one(X.yell(n), `silenceremove=start_periods=1:start_threshold=-45dB,${cap(1.4, 0.4)}`)),
  soldierFall: [
    ...['3yell1', 'yell1', '3yell14'].map((n) => one(X.yell(n), `silenceremove=start_periods=1:start_threshold=-45dB,${cap(3, 0.6)}`)),
    one(X.owl('Human/SCREAM'), `${slow(0.9)},${cap(2, 0.4)}`),
  ],
  cannonFire: [1, 2, 3, 4, 5].map((n) => one(X.bang(`cannon_0${n}`), cap(1.6, 0.3))),
  explosionSmall: [X.bang('bang_03'), X.bang('bang_09'), X.bang('bang_01'), X.a('explosion')].map((f) => one(f, `${cap(1, 0.2)},aecho=0.7:0.5:70:0.3`)),
  explosionMedium: [[X.bang('cannon_01'), 0.9], [X.bang('cannon_04'), 0.85], [X.bang('bang_03'), 0.8], [X.bang('bang_09'), 0.75]]
    .map(([f, k]) => one(f, `${slow(k)},lowpass=f=5000,${verb}`)),
  explosionHuge: [
    mix(X.bang('bang_03'), X.rumble, `${slow(0.5)},lowpass=f=3000`, 'atrim=0:5,afade=t=in:d=0.15,afade=t=out:st=2.5:d=2.5,lowpass=f=300', 'aecho=0.8:0.7:120|260|420:0.45|0.3|0.2'),
    mix(X.bang('cannon_01'), X.rumble, `${slow(0.55)},lowpass=f=3500`, 'atrim=2:7,afade=t=in:d=0.2,afade=t=out:st=2.5:d=2.5,lowpass=f=350', 'aecho=0.8:0.7:140|300|480:0.45|0.3|0.2'),
  ],
  explosionDistant: [
    mix(X.bang('cannon_04'), X.rumble, `${slow(0.6)},lowpass=f=1200`, 'atrim=0:4,afade=t=out:st=2:d=2,lowpass=f=250', 'aecho=0.8:0.8:200|400|700:0.5|0.35|0.25'),
    mix(X.bang('bang_09'), X.rumble, `${slow(0.5)},lowpass=f=1000`, 'atrim=5:9,afade=t=in:d=0.5,afade=t=out:st=2:d=2,lowpass=f=250', 'aecho=0.8:0.8:200|400|700:0.5|0.35|0.25'),
  ],
  // the mech's foot: a stomp, layered with metal
  step: [
    one(X.stomp, 'volume=2'),
    mix(X.stomp, X.a('metal_09'), slow(0.85), 'atrim=0:0.4,volume=0.6'),
    mix(X.stomp, X.a('slam_04'), slow(1.1), 'volume=0.7'),
    mix(X.stomp, X.mech('clank1'), 'anull', 'adelay=20,volume=0.5,atrim=0:0.5'),
  ],
  servoBurst: [X.owl('Scifi/robotics1'), X.owl('Scifi/robotics2'), X.mech('mechanical1'), X.mech('mechanical2'), X.mech('squeakyclick1')]
    .map((f) => one(f, cap(0.4, 0.15))),
  rocketLaunch: [one(X.missile, `${cap(2.7, 0.3)},lowpass=f=7000`)],
  rocketFlight: [{
    inputs: [X.whoosh, P('sfx100b/sfx100v2_loop_machine_01.ogg')],
    fc: `[0:a]aresample=48000,atrim=0:5,asetpts=PTS-STARTPTS,lowpass=f=2500[a];[1:a]aresample=48000,atrim=0:5,asetpts=PTS-STARTPTS,volume=1.2[b];[a][b]amix=inputs=2:normalize=0[m];${loopify('m', 5, 1)}`,
  }],
  aircraft: [{ inputs: [X.b('loop_machine_04')], fc: `${R},atrim=0:4.5,asetpts=PTS-STARTPTS,lowpass=f=1800[m];${loopify('m', 4.5, 0.8)}` }],
  // no free recording of a falling bomb: a descending whistle with some air
  bombWhistle: [{
    lavfi: 'aevalsrc=0.5*sin(2*PI*(2400*t-583.33*t*t))*min(t*8\\,1)*(1-t/1.2):d=1.2:s=48000',
    inputs: [X.whoosh],
    fc: '[1:a]aresample=48000,atrim=0:1.2,highpass=f=2000,volume=0.3[w];[0:a][w]amix=inputs=2:normalize=0',
  }],
  siloDoor: [
    mix(X.a('slam_02'), X.mech('mechanical2'), slow(0.8), slow(0.7)),
    mix(X.a('metal_08'), X.mech('clank1'), slow(0.7), slow(0.8)),
    one(X.a('door_open'), `${slow(0.6)},lowpass=f=3500`),
  ],
  rain: [one(P('rain/4.ogg'), 'anull')],
  wind: [{ inputs: [P('wind/wind/Wind2.ogg')], fc: `${R},atrim=0:6.6,asetpts=PTS-STARTPTS[m];${loopify('m', 6.6, 1.5)}` }],
  thunder: [
    one(X.b('thunder_01'), 'afade=t=out:st=4:d=1.2'),
    mix(X.b('thunder_01'), X.rumble, slow(0.8), 'atrim=2:9,afade=t=in:d=0.4,afade=t=out:st=4:d=3,lowpass=f=350', 'aecho=0.8:0.6:200|450:0.35|0.2'),
    one(X.rumble, `atrim=3:11,afade=t=in:d=1,afade=t=out:st=4:d=4,lowpass=f=400,${verb}`),
  ],
};

// ---- run ----------------------------------------------------------------------------------------------------
mkdirSync(packs, { recursive: true });
for (const [name, files] of Object.entries(PACKS)) for (const f of [files].flat()) await fetchFile(name, f);
// the zips unpack into their own folders: bangs/, guns/sounds/, sfx100/, sfx100b/, owlish/..., yelling/..., rain/, wind/wind/
const only = process.argv[2];
for (const [id, variants] of Object.entries(RECIPES)) {
  if (only && only !== id) continue;
  const dir = join(src, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  variants.forEach((v, i) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (v.lavfi) args.push('-f', 'lavfi', '-i', v.lavfi);
    for (const f of v.inputs) args.push('-i', f);
    args.push('-filter_complex', v.fc, '-ac', '1', '-ar', '48000', join(dir, `${String(i + 1).padStart(2, '0')}.wav`));
    execFileSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  });
  console.log(`${id}: ${variants.length}`);
}
