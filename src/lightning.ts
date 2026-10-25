import * as THREE from 'three';
import { audio, type SoundId } from './audio';
import { STORM } from './config';

type Kind = (typeof STORM.kinds)[number];

/**
 * The flashes of the lightning: a few quick strokes, each fading fast, with a short dark gap between, and a dying glow after.
 * [start, how long it lasts, how bright] in seconds.
 */
const STROKES: [number, number, number][] = [[0, 0.07, 1], [0.13, 0.09, 0.6], [0.28, 0.2, 0.9]];
const GLOW_START = 0.28;
const BOLT_SHOWN = 0.5;
const range = (r: readonly [number, number]): number => r[0] + Math.random() * (r[1] - r[0]);

/** A jagged line from (x0, top) to (x1, bottom), with side branches, as pairs of points for a line-segments mesh. */
function boltPoints(x0: number, x1: number): number[] {
  const out: number[] = [];
  const walk = (ax: number, ay: number, bx: number, by: number, jitter: number, depth: number): void => {
    if (depth === 0) { out.push(ax, ay, 0, bx, by, 0); return; }
    const mx = (ax + bx) / 2 + (Math.random() - 0.5) * jitter, my = (ay + by) / 2 + (Math.random() - 0.5) * jitter * 0.3;
    walk(ax, ay, mx, my, jitter * 0.55, depth - 1);
    walk(mx, my, bx, by, jitter * 0.55, depth - 1);
    // now and then a branch splits off and wanders down and out
    if (depth >= 3 && Math.random() < 0.45) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      walk(mx, my, mx + dir * (4 + Math.random() * 12), my - (8 + Math.random() * 16), jitter * 0.6, depth - 2);
    }
  };
  walk(x0, STORM.boltTop, x1, STORM.boltBottom, 14, 6);
  return out;
}

/**
 * Lightning and its thunder. While it rains, a strike comes every so often: a bolt in the sky far behind the city, a flash that lights the
 * clouds and throws a hard overhead light on the scene, and then, once the sound has had time to travel, the thunder: a sharp crack
 * for a near strike, a clap and a long roll for a middling one, a low rumble for a far one. The game applies `level` to its lights and sky.
 */
export class Lightning {
  /** how lit the scene is by the flash now, 0..1 */
  level = 0;
  /** where the bolt is (world), for the sky's glow and the overhead light */
  readonly boltAt = new THREE.Vector3();
  private readonly bolt: THREE.LineSegments;
  private readonly boltMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(5, 5.5, 7), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  private t = -1;
  private power = 1;
  private wait: number = range(STORM.first);
  private thunder: { id: SoundId; delay: number; shake: number } | null = null;

  /** @param shake the screen shakes (world units) when a close thunderclap lands */
  constructor(scene: THREE.Scene, private readonly shake: (amount: number) => void) {
    this.bolt = new THREE.LineSegments(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 4;
    scene.add(this.bolt);
  }

  /** Set off a strike now (a kind, or by chance), over `camX`. */
  strike(camX: number, kind?: Kind): void {
    let k = kind;
    if (!k) {
      let r = Math.random();
      k = STORM.kinds[STORM.kinds.length - 1];
      for (const c of STORM.kinds) { if ((r -= c.chance) < 0) { k = c; break; } }
    }
    this.t = 0;
    this.power = k.power;
    const x = camX + (Math.random() * 2 - 1) * STORM.boltSpread;
    this.boltAt.set(x, STORM.boltTop * 0.4, STORM.boltZ);
    // three slightly offset copies of the line make it thicker than a pixel
    const pts = boltPoints(x, x + (Math.random() - 0.5) * 16);
    const all: number[] = [];
    for (const dx of [-0.36, -0.18, 0, 0.18, 0.36]) for (let i = 0; i < pts.length; i += 3) all.push(pts[i] + dx, pts[i + 1], STORM.boltZ);
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    this.thunder = { id: k.id, delay: range(k.delay), shake: k.shake };
  }

  /** @param rain how hard it is raining now, 0..1 */
  update(dt: number, camX: number, rain: number): void {
    // the next strike: it comes sooner the harder it rains, and not at all in a drizzle
    if (this.t < 0 && rain >= STORM.minRain) {
      this.wait -= dt * (0.4 + rain);
      if (this.wait <= 0) { this.strike(camX); this.wait = range(STORM.every); }
    }

    if (this.t >= 0) {
      this.t += dt;
      let a = 0, bolt = false;
      for (const [s, len, amp] of STROKES) {
        if (this.t >= s && this.t < s + len) { a = Math.max(a, amp * (1 - (this.t - s) / len)); bolt = true; }
      }
      // the sky stays lit a while after the last stroke, fading away
      if (this.t > GLOW_START) a = Math.max(a, 0.28 * Math.exp(-(this.t - GLOW_START) / 0.35));
      this.level = a * this.power;
      this.bolt.visible = bolt && this.t < BOLT_SHOWN;
      this.boltMat.opacity = Math.min(1, 0.4 + this.power);
      if (this.t > 1.2) { this.t = -1; this.level = 0; }
    }

    // the thunder arrives once the sound has travelled
    if (this.thunder) {
      this.thunder.delay -= dt;
      if (this.thunder.delay <= 0) {
        audio.play(this.thunder.id, { x: this.boltAt.x });
        if (this.thunder.shake > 0) this.shake(this.thunder.shake);
        this.thunder = null;
      }
    }
  }

  /** the flash is over and the thunder has sounded */
  get quiet(): boolean { return this.t < 0 && !this.thunder; }
}
