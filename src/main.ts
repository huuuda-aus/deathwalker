import { Menu } from './menu';
import { FamePanel } from './famePanel';
import { hof } from './hallOfFame';
import { settingsPanel } from './settingsPanel';
import { loadView } from './view';
import type { Game } from './game';

/**
 * The page opens on a loading screen (index.html, `body.booting`) and nothing else: the game itself (the city, the shaders,
 * the sounds) loads behind it, and while it builds the page cannot answer clicks. Only once the game has drawn its first
 * frame, decoded its sounds and buffered the menu's soundtrack does the menu fade in, with all its buttons working.
 */
let game: Game | null = null;

const progress = (p: number): void => { document.getElementById('loading')?.style.setProperty('--p', String(p)); };
/** let the browser paint before the next long, blocking step */
const painted = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
/** a hung download never keeps the player out of the menu */
const GIVE_UP = 20000;

loadView();
const fame = new FamePanel(hof);
new Menu(
  () => { game?.startPlaying(); },
  { fame: () => fame.open(), settings: () => settingsPanel.open() },
);

void (async () => {
  progress(0.08);
  await painted();
  const { Game } = await import('./game');
  progress(0.4);
  await painted();
  game = new Game();
  game.start();
  progress(0.75);
  await Promise.race([game.ready, new Promise((done) => setTimeout(done, GIVE_UP))]);
  progress(1);
  game.show();
  document.body.classList.remove('booting');
})();
