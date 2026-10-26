const LEVEL_KEY = 'walker.level';
const AUTOSTART_KEY = 'walker.autostart';
const UNLOCKED_KEY = 'walker.unlocked';

/**
 * Which level this page plays: `?level=N` in the address, or else the one the last page asked for ("next level": the world
 * cannot be put back, so a fresh page is the clean way into the next level), or else the first. The ask is used up at once, so
 * going back to the main menu (a reload) starts again from level 1.
 */
export function pickLevel(count: number): number {
  let n = 1;
  try {
    const fromUrl = Number(new URLSearchParams(location.search).get('level'));
    const fromLast = Number(sessionStorage.getItem(LEVEL_KEY));
    sessionStorage.removeItem(LEVEL_KEY);
    n = fromUrl || fromLast || 1;
  } catch { /* storage blocked: level 1 */ }
  return Math.min(count, Math.max(1, Math.floor(n)));
}

/** the next page (a reload) plays level `n` and starts it without the main menu */
export function queueLevel(n: number): void {
  try { sessionStorage.setItem(LEVEL_KEY, String(n)); sessionStorage.setItem(AUTOSTART_KEY, '1'); } catch { /* the main menu will do */ }
}

/** was this page opened to go straight into a level? (once only) */
export function takeAutostart(): boolean {
  try {
    const go = sessionStorage.getItem(AUTOSTART_KEY) === '1';
    sessionStorage.removeItem(AUTOSTART_KEY);
    return go;
  } catch { return false; }
}

/** the levels the player has reached (or been given the password of), as numbers, always including the first */
export function unlockedLevels(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? '[1]') as unknown;
    if (Array.isArray(raw)) return [...new Set([1, ...raw.filter((n): n is number => Number.isInteger(n) && n > 0)])].sort((a, b) => a - b);
  } catch { /* storage blocked or damaged */ }
  return [1];
}

/** remember that level `n` has been reached */
export function unlockLevel(n: number): void {
  const have = unlockedLevels();
  if (have.includes(n)) return;
  try { localStorage.setItem(UNLOCKED_KEY, JSON.stringify([...have, n])); } catch { /* not remembered */ }
}
