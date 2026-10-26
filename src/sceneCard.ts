import { LEVEL, LEVELS, LEVEL_NO } from './levelData';

/**
 * The title card at the start of a scene: the level's name, the scene's name big, and how far through the level it is.
 * It fades in and out by itself (a CSS animation, index.html `#card`) and never gets in the way.
 */
export class SceneCard {
  private readonly root = document.getElementById('card')!;
  private readonly level = document.getElementById('card-level')!;
  private readonly name = document.getElementById('card-name')!;
  private readonly count = document.getElementById('card-count')!;

  /** @param index the scene (0-based) */
  show(index: number): void {
    this.level.textContent = LEVELS[LEVEL_NO - 1].name.toUpperCase();
    this.name.textContent = LEVEL[index].name.toUpperCase();
    this.count.textContent = `SCENE ${index + 1} / ${LEVEL.length}`;
    this.root.classList.remove('show');
    void this.root.offsetWidth;            // restart the animation
    this.root.classList.add('show');
  }
}
