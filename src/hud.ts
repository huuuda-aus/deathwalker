import type { LevelRunner } from './level';
import type { Weapon } from './weapon';
import type { SiloBoss } from './boss';

const $ = (id: string) => document.getElementById(id)!;

/** seconds the game over screen takes to fade in */
const GAME_OVER_FADE = 10;

export interface Player { shield: number; lives: number; over: boolean; hitFlash: number }

/** All DOM overlay writes: stat bars, lives, FPS readout, hit flash, game-over screen. */
export class Hud {
  readonly reticle = $('reticle');
  private quality = $('quality');
  private fps = $('fps');
  private go = $('go');
  private shield = $('shield');
  private heat = $('heat');
  private lives = $('lives');
  private hit = $('hit');
  private whiteout = $('flash');
  private whiteoutLevel = 0;
  private over = $('over');
  private bossBar = $('boss');
  private bossFills = [...this.bossBar.querySelectorAll<HTMLElement>('.seg > div')];
  private fpsFrames = 0;
  private fpsTime = 0;
  private fpsWorst = 0;
  private shownLives = -1;

  constructor(private readonly deps: { player: Player; level: LevelRunner; weapon: Weapon; boss: () => SiloBoss | null }) {}

  setQuality(postOn: boolean): void {
    this.quality.textContent = `Q: post-fx ${postOn ? 'on' : 'off'}  |  H: haze`;
  }

  /** the whole screen goes white (0..1) and fades back by itself: the mech blowing up */
  flash(amount: number): void { this.whiteoutLevel = amount; }

  setGameOver(on: boolean): void {
    const { style } = this.over;
    style.display = on ? 'flex' : 'none';
    // the screen comes up slowly: start clear, then fade in
    style.transition = 'none';
    style.opacity = '0';
    if (on) {
      void this.over.offsetWidth;           // let the clear state register before the fade starts
      style.transition = `opacity ${GAME_OVER_FADE}s ease-in`;
      style.opacity = '1';
    }
    document.body.classList.toggle('gameover', on);
  }

  /** FPS readout, refreshed twice a second: average rate plus the slowest frame in that window */
  updateFps(rawMs: number): void {
    this.fpsFrames++; this.fpsTime += rawMs; this.fpsWorst = Math.max(this.fpsWorst, rawMs);
    if (this.fpsTime < 500) return;
    const fps = (this.fpsFrames * 1000) / this.fpsTime;
    this.fps.textContent = `${fps.toFixed(0)} FPS  ${(this.fpsTime / this.fpsFrames).toFixed(1)} ms  (worst ${this.fpsWorst.toFixed(0)} ms)`;
    this.fps.style.color = fps >= 50 ? '#7dff9a' : fps >= 30 ? '#ffb347' : '#ff5a4a';
    this.fpsFrames = 0; this.fpsTime = 0; this.fpsWorst = 0;
  }

  update(dt: number, canFire: boolean, reticle: { x: number; y: number }, locked: boolean): void {
    const { player, level, weapon } = this.deps;
    this.go.style.display = level.phase === 'cleared' ? 'block' : 'none';
    this.shield.style.width = `${Math.max(0, player.shield)}%`;
    this.heat.style.width = `${weapon.heat * 100}%`;
    this.heat.style.background = weapon.locked ? '#ff3030' : weapon.heat > 0.7 ? '#ff8030' : '#ffb347';
    if (player.lives !== this.shownLives) {
      this.shownLives = player.lives;
      this.lives.innerHTML = `LIVES${'<i></i>'.repeat(Math.max(0, player.lives))}`;
    }
    player.hitFlash = Math.max(0, player.hitFlash - dt * 3);
    this.hit.style.opacity = String(player.hitFlash);
    this.whiteoutLevel = Math.max(0, this.whiteoutLevel - dt * 1.6);
    this.whiteout.style.opacity = String(this.whiteoutLevel);

    // the boss's health, one segment per silo; dimmed while its doors are shut and it cannot be hurt
    const boss = this.deps.boss();
    const showBoss = boss !== null && level.phase === 'active';
    this.bossBar.style.display = showBoss ? 'flex' : 'none';
    if (showBoss) {
      boss.silos.forEach((s, i) => {
        this.bossFills[i].style.width = `${s.hpFraction * 100}%`;
        this.bossFills[i].parentElement!.classList.toggle('shut', !s.vulnerable);
      });
    }

    this.reticle.style.opacity = canFire ? '1' : '0.35';
    this.reticle.style.transform = `translate(${reticle.x}px, ${reticle.y}px)`;
    this.reticle.classList.toggle('locked', locked);
  }
}
