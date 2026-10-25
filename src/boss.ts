import { SILO } from './config';
import type { SiloUnit } from './silo';

/**
 * siege:   the silos stay shut and unhurtable while the infantry wave is on.
 * assault: they open together and run their cycle; each launch is a missile at the mech.
 * down:    both are destroyed (what is left of the infantry is the scene's to clear).
 */
export type BossPhase = 'siege' | 'assault' | 'down';

/**
 * The level boss: two silos and the rule that ties them together. It opens them in unison, and keeps them
 * opening in unison after every cycle, but each then runs its own countdown, so shooting one does not hold up
 * the other. With one silo destroyed the survivor runs its cycle faster. The silos are ordinary enemies in the
 * manager's list (bullets, lock-on and the kill count find them there); this only decides when they open.
 */
export class SiloBoss {
  phase: BossPhase = 'siege';

  /** @param opensAfter how many infantry must have been sent in before the silos open */
  constructor(readonly silos: readonly SiloUnit[], private readonly opensAfter: number) {}

  get enraged(): boolean { return this.silos.some((s) => !s.alive) && this.phase !== 'down'; }

  /** @param infantrySent how many infantry the scene has sent in so far */
  update(infantrySent: number): void {
    const alive = this.silos.filter((s) => s.alive);
    if (alive.length === 0) { this.phase = 'down'; return; }
    for (const s of alive) s.speed = this.enraged ? SILO.enrageSpeed : 1;
    if (this.phase === 'siege') {
      if (infantrySent < this.opensAfter) return;
      this.phase = 'assault';
      for (const s of alive) s.open();
      return;
    }
    // each cycle ends with both shut; once both have rested, they open again together
    if (alive.every((s) => s.state === 'closed' && s.rest >= SILO.closedTime)) for (const s of alive) s.open();
  }
}
