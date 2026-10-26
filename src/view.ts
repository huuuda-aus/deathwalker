const KEY = 'walker.mirror';

/**
 * Which way the game scrolls. The game itself always runs the classic way (the mech faces left, the level scrolls right to
 * left); "mirrored" flips the finished picture, and the things that go with it (the mouse, the walk keys, the stereo pan),
 * so the mech faces right and the level scrolls left to right.
 */
export const view = { mirror: false };

/** the arrow that tells the player the scene is rolling on: it points the way the mech faces */
const GO = ['&#9668; GO', 'GO &#9658;'];

function apply(): void {
  document.body.classList.toggle('mirror', view.mirror);
  const go = document.getElementById('go');
  if (go) go.innerHTML = GO[view.mirror ? 1 : 0];
}

/** read the remembered choice (call once at start-up, before the first frame) */
export function loadView(): void {
  try { view.mirror = localStorage.getItem(KEY) === 'on'; } catch { /* storage blocked: the classic direction */ }
  apply();
}

export function setMirror(on: boolean): void {
  view.mirror = on;
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* not remembered */ }
  apply();
}

/** the screen x (CSS px) of a camera-space NDC x: mirrored, the picture is flipped on the screen */
export function ndcToPx(ndcX: number, width: number): number {
  return ((view.mirror ? -ndcX : ndcX) + 1) / 2 * width;
}
