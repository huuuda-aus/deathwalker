import type * as THREE from 'three';
import { audio, type LoopHandle, type PlayOpts, type SoundId } from './audio';

/**
 * What the game says to the speaker: events in game terms ("a soldier died", "something blew up"), turned into
 * the right sounds here, so the call sites stay one line. Sounds the game makes continuously (the gun, an engine)
 * are held: whoever owns one calls `hold` every frame it should play, and it fades out by itself soon after the calls stop.
 */

interface Held { handle: LoopHandle; seen: number; ttl: number }
const held = new Map<unknown, Held>();
let clock = 0;

/** the fraction of dying soldiers that scream, and of those thrown off a building */
const SCREAM_CHANCE = 0.5;
const FALL_SCREAM_CHANCE = 0.9;
/** the blast radius (world units) up to which an explosion is small, and up to which it is medium */
const SMALL_BLAST = 2;
const MEDIUM_BLAST = 5;
/** seconds between the far-off explosions, give or take (the thunder is the lightning's: see lightning.ts) */
const DISTANT_EVERY = [5, 14] as const;
/** how long the servo sound is as recorded (s), to fit it to the swing of the leg */
const SERVO_LEN = 0.3;
/** a collapsing piece of a building must be at least this many layers to be heard, and this many to be heard in full */
const COLLAPSE_MIN = 12;
const COLLAPSE_FULL = 160;
/** wind loop volume: it follows the gusts (their speed is about 0.4 .. 3) */
const WIND_MAX = 3;

let distantT = 4;

const range = (r: readonly [number, number]): number => r[0] + Math.random() * (r[1] - r[0]);

export const sfx = {
  /** Keep a looping sound going (call every frame it should play); `key` says whose it is. Moves it if it is already running. */
  hold(key: unknown, id: SoundId, opts: PlayOpts = {}, ttl = 0.2): void {
    let h = held.get(key);
    if (!h) {
      if (audio.ctx.state !== 'running') return;
      h = { handle: audio.loop(id, opts), seen: clock, ttl };
      held.set(key, h);
    }
    h.seen = clock;
    h.ttl = ttl;
    h.handle.set(opts, 0.08);
  },

  /** Per frame: fades out whatever nobody is holding any more, and runs the weather. */
  update(dt: number, rain: number, wind: number): void {
    clock += dt;
    for (const [key, h] of held) {
      if (clock - h.seen > h.ttl) { h.handle.stop(0.15); held.delete(key); }
    }
    if (!audio.ready || audio.ctx.state !== 'running') return;
    sfx.hold('rain', 'rain', { gain: rain < 0.02 ? 0 : 0.2 + 0.8 * rain }, 0.5);
    sfx.hold('wind', 'wind', { gain: Math.min(1, wind / WIND_MAX) }, 0.5);
    // the war goes on out of sight: heavy blasts far off, muffled by distance and walls, and thunder
    distantT -= dt;
    if (distantT <= 0) {
      distantT = range(DISTANT_EVERY);
      const side = Math.random() < 0.5 ? -1 : 1;
      audio.play('explosionDistant', { x: audio.listenerX + side * (30 + Math.random() * 25), muffle: 0.55 + Math.random() * 0.3, gain: 0.5 + Math.random() * 0.5 });
    }
  },

  /** the mech's guns: held while they fire; pitch climbs a little as they heat up */
  gun(heat: number): void { sfx.hold('gun', 'gun', { rate: 1 + heat * 0.12 }, 0.15); },

  /** a bullet hits something */
  impact(kind: 'flesh' | 'metal' | 'wall' | 'ground' | 'rubble', at: THREE.Vector3): void {
    audio.play(`impact${kind[0].toUpperCase()}${kind.slice(1)}` as SoundId, { x: at.x });
  },

  enemyShot(from: THREE.Vector3): void { audio.play('enemyShot', { x: from.x }); },
  /** a round from a heavy machine gun: deeper and harder than a rifle's */
  gunnerShot(from: THREE.Vector3): void { audio.play('gunnerShot', { x: from.x }); },

  /** a soldier is killed; one thrown off a building screams more, and longer */
  soldierDeath(x: number, plunge: boolean): void {
    if (plunge) { if (Math.random() < FALL_SCREAM_CHANCE) audio.play('soldierFall', { x }); }
    else if (Math.random() < SCREAM_CHANCE) audio.play('soldierScream', { x });
  },

  /** anything blowing up, by how big the blast is */
  explosion(at: THREE.Vector3, radius: number): void {
    const id: SoundId = radius < SMALL_BLAST ? 'explosionSmall' : radius < MEDIUM_BLAST ? 'explosionMedium' : 'explosionHuge';
    audio.play(id, { x: at.x });
  },

  /** a piece of a building lets go: a low, heavy rumble, fuller the more of it there is (a handful of bricks makes none) */
  buildingRumble(x: number, mass: number, rate = 1): void {
    if (mass < COLLAPSE_MIN) return;
    audio.play('buildingRumble', { x, gain: 0.45 + 0.55 * Math.min(1, mass / COLLAPSE_FULL), rate });
  },

  /** a block of a building hits the ground: a heavy thud and a crash of rubble, harder for a bigger block and a longer fall */
  buildingCrash(x: number, mass: number, fall: number): void {
    if (mass < COLLAPSE_MIN) return;
    const weight = Math.min(1, (mass / COLLAPSE_FULL) * (0.6 + 0.4 * Math.min(1, fall / 3)));
    audio.play('buildingCrash', { x, gain: 0.4 + 0.6 * weight, rate: 1.1 - 0.25 * weight });
  },

  /** a very big bang, wherever it is (the zeppelin coming down) */
  explosionHuge(at: THREE.Vector3): void { audio.play('explosionHuge', { x: at.x }); },

  cannon(from: THREE.Vector3): void { audio.play('cannonFire', { x: from.x }); },
  rocketLaunch(from: THREE.Vector3): void { audio.play('rocketLaunch', { x: from.x }); },
  bombDropped(from: THREE.Vector3): void { audio.play('bombWhistle', { x: from.x }); },
  siloDoor(x: number): void { audio.play('siloDoor', { x }); },
  /** the launcher's rack tips up or down: hydraulics */
  rack(x: number): void { audio.play('rackMove', { x }); },

  step(x: number, strength: number): void { audio.play('step', { x, gain: 0.5 + 0.5 * strength }); },

  /** a leg's servos whine as it swings forward ("zzzzt"), before the foot comes down ("THUD"): squeezed or stretched to fit the swing */
  servoBurst(x: number, strength: number, seconds: number): void {
    audio.play('servoBurst', { x, gain: 0.5 + 0.5 * strength, rate: Math.min(2.2, Math.max(0.8, SERVO_LEN / seconds)) });
  },
};
