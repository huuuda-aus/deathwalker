import * as THREE from 'three';
import type { Dust } from './dust';
import { SCREEN_W } from './level';
import { terrainHeight } from './terrain';

/** most the wind throws up at once in the strongest gust: streamers per second, each a short line of grains */
const STREAMERS = { calm: 3, gust: 18 };
/** how far the sand is thrown (world units: the near end of the street is z = 12, the far end z = -8) */
const Z_NEAR = 12, Z_FAR = -8;

/**
 * Blown sand, close to the ground: in a gust the wind lifts it off the dunes in thin streamers ("sand snakes") that race
 * along the ground with a few grains hopping above them, and a faint veil of fine dust rises behind. Between gusts only a
 * few grains skitter by. Everything drifts the way the wind blows (toward -x). It is a second dust system (sand-coloured),
 * so it shares the dust's soft grains; this class only decides where and when.
 *
 * The desert is gusty: a gust comes every ten seconds or so and lasts several, with a smaller one riding on it, and the air is never quite
 * still. (The grains are small: fine sand, not gravel.)
 */
export class SandWind {
  private streamerDebt = 0;
  private veilDebt = 0;
  private readonly at = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private t = 0;

  /** how hard it gusts right now, 0.12 .. 1: long swells with quicker ones on them, above the threshold more than half the time */
  get gust(): number {
    const s = 0.62 * Math.sin(this.t * 0.5) + 0.38 * Math.sin(this.t * 1.31 + 1.7);
    const x = Math.min(1, Math.max(0, (s + 0.25) / 0.8));
    return 0.12 + 0.88 * x * x * (3 - 2 * x);
  }

  constructor(private readonly dust: Dust) {}

  update(dt: number, camX: number): void {
    this.t += dt;
    const gust = this.gust;
    // the harder it gusts, the more is lifted (and not in proportion: a strong gust is much more than twice a mild one)
    this.streamerDebt += (STREAMERS.calm + (STREAMERS.gust - STREAMERS.calm) * gust * gust) * dt;
    this.veilDebt += (0.8 + 14 * gust * gust) * dt;
    while (this.streamerDebt >= 1) { this.streamerDebt -= 1; this.streamer(camX, gust); }
    while (this.veilDebt >= 1) { this.veilDebt -= 1; this.veil(camX, gust); }
  }

  /** a thin line of grains, laid out along the wind, all moving together so that the line holds as it races */
  private streamer(camX: number, gust: number): void {
    const x = camX + SCREEN_W * (0.2 + Math.random() * 1.4);          // starts upwind (to the right) and blows across the view
    const z = Z_FAR + Math.random() ** 0.8 * (Z_NEAR - Z_FAR);
    const speed = (1.4 + 1.6 * gust) * (1.2 + Math.random() * 1.2) + 1.5 * gust;
    const length = 0.8 + Math.random() * 2.2 + 2 * gust;
    const grains = Math.min(16, 6 + Math.floor(length * 3));
    const hop = Math.random() * 0.12;
    for (let i = 0; i < grains; i++) {
      const gx = x + (i / grains) * length;
      this.at.set(gx, terrainHeight(gx, z) + 0.015 + Math.random() * Math.random() * (0.05 + 0.1 * gust), z + (Math.random() - 0.5) * 0.06);
      this.vel.set(-speed * (0.92 + Math.random() * 0.16), hop * Math.random() * 2.5, (Math.random() - 0.5) * 0.1);
      this.dust.billow(this.at, this.vel, 0.022 + Math.random() * 0.03, 2.5 + Math.random() * 3, 0.03, 0, 0.5 + 0.35 * gust);
    }
  }

  /** a soft, faint veil of fine dust that rises a little as it blows */
  private veil(camX: number, gust: number): void {
    const x = camX + SCREEN_W * (0.1 + Math.random() * 1.5);
    const z = Z_FAR + Math.random() * (Z_NEAR - Z_FAR);
    this.at.set(x, terrainHeight(x, z) + 0.05 + Math.random() * 0.2, z);
    this.vel.set(-(1.4 + 1.6 * gust) * (1 + Math.random()) - 1.2 * gust, 0.05 + Math.random() * 0.12, (Math.random() - 0.5) * 0.2);
    this.dust.billow(this.at, this.vel, 0.25 + Math.random() * 0.4, 3 + Math.random() * 3, 0.05, 0, 0.05 + 0.1 * gust);
  }
}
