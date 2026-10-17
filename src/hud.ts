import { LEVEL, type LevelRunner } from './level';
import type { Weapon } from './weapon';

const $ = (id: string) => document.getElementById(id)!;

/** Sets text only when it changed, so static HUD frames cost no DOM work. */
function setText(el: HTMLElement, s: string): void {
  if (el.textContent !== s) el.textContent = s;
}

export interface Player { shield: number; lives: number; over: boolean; hitFlash: number }

/** All DOM overlay writes: stat bars, scene progress, FPS readout, hit flash, game-over screen. */
export class Hud {
  readonly reticle = $('reticle');
  private quality = $('quality');
  private scene = $('scene');
  private fps = $('fps');
  private go = $('go');
  private shield = $('shield');
  private heat = $('heat');
  private lives = $('lives');
  private hit = $('hit');
  private over = $('over');
  private fpsFrames = 0;
  private fpsTime = 0;
  private fpsWorst = 0;
  private sceneHtml = '';

  constructor(private readonly deps: { player: Player; level: LevelRunner; weapon: Weapon }) {}

  setQuality(postOn: boolean): void {
    this.quality.textContent = `Q: post-fx ${postOn ? 'on' : 'off'}  |  H: haze`;
  }

  setGameOver(on: boolean): void { this.over.style.display = on ? 'flex' : 'none'; }

  /** FPS readout, refreshed twice a second: average rate plus the slowest frame in that window */
  updateFps(rawMs: number): void {
    this.fpsFrames++; this.fpsTime += rawMs; this.fpsWorst = Math.max(this.fpsWorst, rawMs);
    if (this.fpsTime < 500) return;
    const fps = (this.fpsFrames * 1000) / this.fpsTime;
    this.fps.textContent = `${fps.toFixed(0)} FPS  ${(this.fpsTime / this.fpsFrames).toFixed(1)} ms  (worst ${this.fpsWorst.toFixed(0)} ms)`;
    this.fps.style.color = fps >= 50 ? '#7dff9a' : fps >= 30 ? '#ffb347' : '#ff5a4a';
    this.fpsFrames = 0; this.fpsTime = 0; this.fpsWorst = 0;
  }

  update(dt: number, canFire: boolean, mousePx: { x: number; y: number }): void {
    const { player, level, weapon } = this.deps;
    this.go.style.display = level.phase === 'cleared' ? 'block' : 'none';
    const html = LEVEL.map((def, i) => {
      const k = level.killsByScene[i];
      if (i > level.index) return `SCENE ${i + 1}  --`;
      const done = i < level.index || level.phase === 'cleared' || level.phase === 'complete';
      const tag = done ? '  CLEARED' : '';
      return `SCENE ${i + 1}  KILLED ${k}/${def.spawnBudget}${tag}`;
    }).join('<br>');
    if (html !== this.sceneHtml) { this.sceneHtml = html; this.scene.innerHTML = html; }

    this.shield.style.width = `${Math.max(0, player.shield)}%`;
    this.heat.style.width = `${weapon.heat * 100}%`;
    this.heat.style.background = weapon.locked ? '#ff3030' : weapon.heat > 0.7 ? '#ff8030' : '#ffb347';
    setText(this.lives, `LIVES ${'■'.repeat(Math.max(0, player.lives))}`);
    player.hitFlash = Math.max(0, player.hitFlash - dt * 3);
    this.hit.style.opacity = String(player.hitFlash);

    this.reticle.style.opacity = canFire ? '1' : '0.35';
    this.reticle.style.transform = `translate(${mousePx.x}px, ${mousePx.y}px)`;
  }
}
