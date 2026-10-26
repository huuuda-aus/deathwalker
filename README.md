# Deathwalker

A browser remake, inspired by **Walker** (DMA Design / Psygnosis, Amiga, 1993): a bipedal mech advances right to left through a ruined city, aiming with the mouse and walking with the keyboard, while infantry fire back from the streets and the buildings.

Built with **TypeScript**, **Three.js** and **Vite**. All art is procedural placeholder geometry; nothing is taken from the original game.

> Status: playable prototype (milestones M1–M3 plus scene/camera work). See [Roadmap](#roadmap).

## Run it

```bash
npm install
npm run dev       # dev server with hot reload
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build
```

Needs a browser with WebGL2.

## Main menu

The game opens on a main menu over the first level's skyline (rain, fires and all). Pick with the mouse, or up/down and Enter. The corner has a stack of named soundtrack buttons (or the keys 1, 2, 3; the last choice is remembered) with the music on/off switch (M) under them. **Start game** begins the level; **Enter level code**, **Hall of fame** shows the best runs, **Settings** is described below, and **Credits** is a placeholder for now. The QR code in the corner links to [ko-fi.com/huuuda](https://ko-fi.com/huuuda) (the image is `public/kofi-qr.svg`).

## Settings

**Settings** (main menu) holds the scroll direction, remembered between visits. *Right to left* is the classic way: the mech faces left and the level scrolls to the left. *Left to right* mirrors the whole picture: the mech faces right, the level scrolls to the right, and the gauges move to the top left corner, and the mouse, the A/D keys and the stereo pan are flipped to match (`src/view.ts`; the game itself always runs the classic way).

## Controls

| Input | Action |
|---|---|
| **A / D** or **← / →** | Walk left / right along the street |
| **W / S** or **↑ / ↓** | Walk away from / toward the camera (depth lane) |
| **Mouse** | Aim the reticle |
| **Hold left mouse button** | Fire both guns |
| **Hold right mouse button** | Lock on: the reticle sticks to the middle of the enemy under it (or nearest to it) for as long as you hold the button, or until it dies. Hold both buttons to keep the lock and fire |
| **Q** | Toggle post-processing (bloom, motion blur, vignette, haze) |
| **H** | Toggle the volumetric haze only |
| **Esc** | Pause menu: resume, or back to the main menu |

The mech never turns around: its body always faces left. Only the cockpit and its two rigid guns rotate, and only within the forward hemisphere, so you cannot shoot behind you. The guns overheat; release to cool down, and a full overheat locks them out until they cool.

## Gameplay

- The camera is on rails. A level is a list of **scenes**, each one or more screens wide, with a spawn budget and a kill goal. The camera will not advance until the goal is met; then the scroll unlocks and you walk on to the next scene.
- Enemies arrive in waves. Most spawn **inside the buildings**, walk to a ledge and shoot from there; the rest walk in from off-screen. Soldiers on the street steer around rubble and only fire when they have a clear line of fire.
- **Buildings are destructible ruins** built from floor slabs, pillars, walls, glazing and stairwells. A load-path solver collapses whatever loses its support, and shooting out the base of a building brings the whole thing down, crushing everyone inside. A collapsed building spawns no more enemies.
- **Heavy machine gunners** run in from the left with their gun over their shoulder, pick a spot with a clear line of fire, drop to the ground, set the gun up and fire long bursts at the mech, much more accurately than the riflemen and with faster bullets. They take twice the hits of a rifleman and are worth six times the points. If rubble blocks their line of fire they pick the gun up and move.
- **Tracked rocket launchers** roll in from the left, stop a good way from the mech, tip up their rack and fire a salvo of three rockets, which climb, turn over and come down on where the mech stood, then lower the rack and reload. The rockets can be shot down. A launcher takes half as much fire again as a cannon, and blows up with its remaining rockets going off.
- **The zeppelin** hangs over the battlefield: a vast airship, longer than the screen is wide, of which only the belly shows, bobbing at the top of the view. Hatches under it open and paratroopers drop out: they fall, open their canopy and float down (a good target, canopy and all, and killing one in the air scores extra), and fight as infantry once they land. It can be shot down, but it takes a long, sustained effort: the belly catches fire, the paratroopers still aboard jump at once, and it comes down behind the city in a chain of explosions. Only the paratroopers count toward clearing the scene.
- **A thunderstorm** rolls over the city while it rains (the harder, the more often): a bolt far behind the skyline, a flash that lights the clouds and throws a hard light from above on everything, then the thunder, which arrives later the farther off the strike was: a sharp crack for a near one, a clap and a long roll a few seconds on, or a low rumble well after.
- **Rubble is physical and persistent.** It piles up, blocks soldiers and bullets, is kicked aside by the mech's legs, and slows the mech down when it is dense.
- **Level 1 boss: the missile silos** (last scene). Two silos sit in the ground side by side on the left of the view, shut and unhurtable while the infantry wave is on. Once enough of it has been sent in they open together; only an open silo can be damaged (shut doors just spark). Each launches a slow missile that climbs, then arcs down onto where you were standing, so keep moving. Missiles can be shot down, and loop up well off the top of the screen before they come back, so you have a few seconds to walk away. They close and reopen in unison, but each has its own countdown, so shooting one does not hold up the other; with one gone the survivor works faster. The scene has no kill count: infantry keeps coming, with a truck of troops every 30 seconds or so, until both silos are destroyed (or you die).
- Your shield is your health; you have a single life: when the shield is gone the mech blows up and the game is over.

## How the shooting works

Bullets are not projectiles. Each shot is an instant ray cast from the camera through the reticle into the 2.5D world (enemies, walls, rubble, ground), and the guns' effect appears where it lands. The two guns fire alternately, and the heat level widens the spread slightly. Rubble on the line between a gun and its target stops the shot, for both you and the enemy.

## Score and hall of fame

Every enemy is worth points (a soldier 10, a heavy machine gunner 60, a horse 25, a gun 120, a rocket launcher 300, a truck 200, a plane 250, the zeppelin 800, a silo 1500), and the level's spawns are fixed, so the points available are the same for everyone. What tells two players who kill everything apart:

- **Combo:** kills less than 1.5 s apart build a multiplier (up to x3). Stomping a soldier (+15) or crushing him under falling rubble (+10) pays extra.
- **Scene bonuses:** each cleared scene pays for **speed** (up to 1000, against the scene's `parTime` in `level1.json`: full at 60% of it or faster, none at 150%), **shield left** (up to 500), **no damage taken** (500) and **no overheat** (300). The boss scene has no kill count, so its speed bonus is the point of it.
- **Grade:** a cleared level is graded S to D by its score as a share of the level's nominal total (every enemy once, every bonus in full, no combos).

The **hall of fame** (main menu) keeps the ten best runs on this machine, in `localStorage`. They are ranked by how far the run got (a cleared level beats any unfinished one), then score, then time, so identical scores are told apart by speed. A run that makes the list asks for three letters on the game over / level complete screen; leaving without typing enters it as AAA.

## Sound

Web Audio, with a thin engine in `src/audio.ts` (buses, limiter, voice cap, pan and distance muffling) and game events turned into sounds in `src/sfx.ts`. Every sound event is listed in `src/sounds.json` with the loudness it is normalized to, so that file is the mix. Press **F2** in the game for a panel that plays each one. The recordings are free CC0 packs (see `public/audio/CREDITS.md`):

```bash
npm run audio:samples   # download the packs (once) and cut/layer/loop them into audio-src/<sound>/
npm run audio           # loudness-normalize and encode them into public/audio (Opus)
```

A sound with no recording falls back to a synthesized placeholder.

## Project layout

```
src/
  main.ts       game loop, input wiring, spawning waves, HUD
  level.ts      scene list, on-rails camera, kill-gate state machine
  mech.ts       procedural mech, IK legs, cockpit aiming, rubble colliders
  weapon.ts     hitscan guns, heat, jitter
  targeting.ts  ray casts against enemies / walls / ground
  enemies.ts    soldiers: steering, line of fire, ledges, corpses
  gunner.ts     the heavy machine gunner: run in, set up, fire bursts, move
  launcher.ts   the tracked rocket launcher: roll in, tip the rack, fire salvos
  zeppelin.ts   the zeppelin set piece: arrive, drop paratroopers, leave or burn and fall
  paratrooper.ts  a paratrooper: free fall, canopy, float down, then infantry
  boss.ts       level boss: opens the two silos in unison, enrages the survivor
  silo.ts       one silo: closed/opening/exposed/firing/closing, hit box, wreck
  missiles.ts   the silos' missiles: slow climb off-screen, then a lob onto the mech; shootable
  building.ts   destructible buildings, ruin generation, collapse solver
  world.ts      sky, ground, parallax city, chunk streaming
  debris.ts     rubble physics (sleeping bodies, spatial hash), dust
  fx.ts         pixel sparks, blood bursts, muzzle flash
  post.ts       post-processing: volumetric haze, bloom, depth-aware motion blur, tone map
  sky.ts        night sky shader: clouds, stars, horizon glow
  wind.ts       shared wind (gusts); drives the haze drift and the litter
  litter.ts     scarce leaves and papers blown along by the wind
  fire.ts       burning oil barrels in the ground-floor bays, fire light pool, shared flame textures
  water.ts      puddles on the ground and the splashes the mech's feet make in them
  rain.ts       GPU drizzle: wind-slanted drops and splashes that land on roofs and the mech
  haze.ts       low-res raymarched volumetric haze pass
  ground.ts     procedural rubble/dirt ground texture + normal map
  input.ts      keyboard and mouse
```

Handy tuning knobs:

| File | What |
|---|---|
| `src/level.ts` | `LEVEL` (scene widths, kill goals, spawn budgets), `SCREEN_W` |
| `src/main.ts` | `WALK_SPEED`, `MAX_ALIVE`, wave size and interval |
| `src/weapon.ts` | fire rate, heat per shot, cooling, spread |
| `src/mech.ts` | `MECH_SCALE`, gait (`STEP`, `LIFT`, `STANCE`), collider radii |
| `src/building.ts` | `CELL` size, member hit points, `SPAN`, `BEARING_MIN` |
| `src/debris.ts` | sleep thresholds, chunk cap, blocking sizes |
| `src/post.ts` | exposure, bloom, motion-blur shutter, haze density/colour/steps |
| `src/wind.ts`, `src/litter.ts` | wind strength and gusts, amount of flying litter |

## Roadmap

Done: scrolling scene and parallax city, mech with decoupled aiming, hitscan guns with heat, infantry, destructible buildings with collapse physics, persistent rubble, post-processing, on-rails scenes with kill gates.

Next (M4): more enemy types (tanks, planes with paratroopers, grenade throwers), HUD polish, a complete first level (Berlin 1944), radio-chatter audio. Later: the remaining stages (Los Angeles 2019, Middle East, 2420), bosses, lock-on missiles, difficulty modes, and more variety in what the player faces.

## Credits and legal

*Walker* is the work of DMA Design and Psygnosis; this project is an unofficial, non-commercial homage and contains none of the original's assets, code or music.
