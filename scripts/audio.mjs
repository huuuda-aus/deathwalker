// Turns the raw recordings in audio-src/<sound id>/* into the game's files: public/audio/<id>_<n>.opus plus index.json.
// Each is trimmed of silence, converted to mono 48 kHz, loudness-normalized to the target in src/sounds.json (LUFS), and
// encoded as Opus. Run: npm run audio   (add -- <id> to redo one sound)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'audio-src');
const out = join(root, 'public', 'audio');
const sounds = JSON.parse(readFileSync(join(root, 'src', 'sounds.json'), 'utf8')).sounds;
const only = process.argv[2];
const EXT = /\.(wav|mp3|ogg|oga|flac|m4a|aif|aiff|opus)$/i;

const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=1:stop_duration=0.3:stop_threshold=-55dB';

/** ffmpeg's log (stderr) for an analysis pass over the trimmed file */
const analyse = (file, filter) => spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', `${trim},${filter}`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr ?? '';

/** integrated loudness of the trimmed file, or null if it is too short or quiet to measure */
function loudness(file) {
  // padded with silence: a very short sound is under the 0.4 s the loudness meter needs, and the silence is gated out of the result
  const m = analyse(file, 'apad=whole_dur=3,loudnorm=I=-24:print_format=json').match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  const v = parseFloat(JSON.parse(m[0]).input_i);
  return Number.isFinite(v) && v > -70 ? v : null;
}

mkdirSync(out, { recursive: true });
const index = existsSync(join(out, 'index.json')) ? JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) : {};
if (!existsSync(src)) { console.log('no audio-src/ folder: nothing to do'); process.exit(0); }

for (const id of Object.keys(sounds)) {
  if (only && id !== only) continue;
  const dir = join(src, id);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => EXT.test(f)).sort();
  if (files.length === 0) continue;
  for (const f of readdirSync(out)) if (f.startsWith(`${id}_`)) rmSync(join(out, f));
  const target = sounds[id].lufs;
  files.forEach((f, i) => {
    const input = join(dir, f);
    const lufs = loudness(input);
    // too short or quiet to measure loudness: bring its peak to -3 dB instead
    let gain;
    if (lufs !== null) gain = target - lufs;
    else {
      const m = analyse(input, 'volumedetect');
      gain = -3 - parseFloat((m.match(/max_volume: (-?[\d.]+) dB/) ?? [0, 0])[1]);
    }
    const filters = [trim, `volume=${gain.toFixed(2)}dB`, 'alimiter=limit=0.89:level=disabled'];
    const dest = join(out, `${id}_${i + 1}.opus`);
    run(['-y', '-i', input, '-af', filters.join(','), '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '56k', dest]);
    console.log(`${id}_${i + 1}.opus  <- ${f}  (${lufs === null ? 'unmeasured' : `${lufs.toFixed(1)} LUFS`} -> ${target})`);
  });
  index[id] = files.length;
}

// music: audio-src/music/<name>.* -> public/audio/music_<name>.opus, stereo, loudness-normalized (the game streams it)
const MUSIC_LUFS = -20;
const musicDir = join(src, 'music');
if (existsSync(musicDir) && (!only || only === 'music')) {
  for (const f of readdirSync(musicDir).filter((f) => EXT.test(f))) {
    const name = f.replace(/\.[^.]+$/, '');
    const input = join(musicDir, f);
    const lufs = loudness(input);
    const gain = lufs === null ? 0 : MUSIC_LUFS - lufs;
    run(['-y', '-i', input, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-map_metadata', '-1', join(out, `music_${name}.opus`)]);
    console.log(`music_${name}.opus  <- ${f}  (${lufs === null ? 'unmeasured' : `${lufs.toFixed(1)} LUFS`} -> ${MUSIC_LUFS})`);
  }
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
