/**
 * One shared wind. It gusts slowly; the haze and the flying litter both follow it, so the drift
 * of the smoke and the speed of the leaves and papers agree. Blows toward -x (the way the mech walks).
 */
export class Wind {
  /** current speed (world units/s), always blowing toward -x */
  speed = 1.5;
  /** distance the air has travelled so far; drives the haze texture offset */
  travelled = 0;
  private t = 0;

  update(dt: number): void {
    this.t += dt;
    // slow gusts: roughly 0.5 .. 3.0
    this.speed = 1.6 + 0.9 * Math.sin(this.t * 0.17) + 0.5 * Math.sin(this.t * 0.53 + 1.3);
    this.speed = Math.max(0.4, this.speed);
    this.travelled += this.speed * dt;
  }

  /** a quicker, patchier gust factor for light things like paper (0.3 .. 1.8) */
  gust(x: number, t: number): number {
    return 1 + 0.55 * Math.sin(t * 0.9 + x * 0.12) + 0.25 * Math.sin(t * 2.3 + x * 0.31);
  }
}
