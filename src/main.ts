import { Menu } from './menu';
import { FamePanel } from './famePanel';
import { hof } from './hallOfFame';
import type { Game } from './game';

/**
 * The main menu comes alive at once: the game itself (the city, the shaders, the sounds) loads behind it, which takes a while,
 * and the scene fades in only once it has drawn its first frame. Choosing "start game" before the game is ready starts it the
 * moment it is.
 */
let game: Game | null = null;
let startWhenReady = false;

const fame = new FamePanel(hof);
new Menu(
  () => {
    if (game) { game.startPlaying(); return; }
    startWhenReady = true;
    document.body.classList.add('loading');
  },
  { fame: () => fame.open() },
);

void import('./game').then(({ Game }) => {
  game = new Game();
  game.start();
  if (startWhenReady) game.startPlaying();
});
