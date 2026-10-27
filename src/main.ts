import { Menu } from './menu';
import { FamePanel } from './famePanel';
import { hof } from './hallOfFame';
import { settingsPanel } from './settingsPanel';
import { CodePanel } from './codePanel';
import { loadView } from './view';
import { takeAutostart } from './levelSelect';
import { audio } from './audio';
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
const codePanel = new CodePanel(() => { game?.startPlaying(); });
new Menu(
  () => { game?.startPlaying(); },
  { fame: () => fame.open(), settings: () => settingsPanel.open(), code: () => codePanel.open() },
);

// the sound recordings start downloading and decoding at once, alongside the game's own code (the game picks the same load up)
void audio.load();

void (async () => {
  progress(0.08);
  await painted();
  const { Game } = await import('./game');
  progress(0.4);
  await painted();
  game = new Game();
  progress(0.6);
  await game.precompile();
  progress(0.75);
  game.start();
  await Promise.race([game.ready, new Promise((done) => setTimeout(done, GIVE_UP))]);
  progress(1);
  game.show();
  document.body.classList.remove('booting');
  // "next level" reloads the page and goes straight in
  if (takeAutostart()) { document.body.classList.remove('menu'); game.startPlaying(); }
})();
