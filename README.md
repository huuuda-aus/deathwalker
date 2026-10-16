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

## Controls

| Input | Action |
|---|---|
| **A / D** or **← / →** | Walk left / right along the street |
| **W / S** or **↑ / ↓** | Walk away from / toward the camera (depth lane) |
| **Mouse** | Aim the reticle |
| **Hold mouse button** | Fire both guns |
| **Q** | Toggle post-processing (bloom, motion blur, vignette, haze) |
| **H** | Toggle the volumetric haze only |
| **R** | Restart after game over |

The mech never turns around: its body always faces left. Only the cockpit and its two rigid guns rotate, and only within the forward hemisphere, so you cannot shoot behind you. The guns overheat; release to cool down, and a full overheat locks them out until they cool.

## Gameplay

- The camera is on rails. A level is a list of **scenes**, each one or more screens wide, with a spawn budget and a kill goal. The camera will not advance until the goal is met; then the scroll unlocks and you walk on to the next scene.
- Enemies arrive in waves. Most spawn **inside the buildings**, walk to a ledge and shoot from there; the rest walk in from off-screen. Soldiers on the street steer around rubble and only fire when they have a clear line of fire.
- **Buildings are destructible ruins** built from floor slabs, pillars, walls, glazing and stairwells. A load-path solver collapses whatever loses its support, and shooting out the base of a building brings the whole thing down, crushing everyone inside. A collapsed building spawns no more enemies.
- **Rubble is physical and persistent.** It piles up, blocks soldiers and bullets, is kicked aside by the mech's legs, and slows the mech down when it is dense.
- Your shield is your health; you have three lives.

## How the shooting works

Bullets are not projectiles. Each shot is an instant ray cast from the camera through the reticle into the 2.5D world (enemies, walls, rubble, ground), and the guns' effect appears where it lands. The two guns fire alternately, and the heat level widens the spread slightly. Rubble on the line between a gun and its target stops the shot, for both you and the enemy.

## Project layout

```
src/
  main.ts       game loop, input wiring, spawning waves, HUD
  level.ts      scene list, on-rails camera, kill-gate state machine
  mech.ts       procedural mech, IK legs, cockpit aiming, rubble colliders
  weapon.ts     hitscan guns, heat, jitter
  targeting.ts  ray casts against enemies / walls / ground
  enemies.ts    soldiers: steering, line of fire, ledges, corpses
  building.ts   destructible buildings, ruin generation, collapse solver
  world.ts      sky, ground, parallax city, chunk streaming
  debris.ts     rubble physics (sleeping bodies, spatial hash), dust
  fx.ts         pixel sparks, blood bursts, muzzle flash
  post.ts       post-processing: volumetric haze, bloom, depth-aware motion blur, tone map
  sky.ts        night sky shader: clouds, stars, horizon glow
  wind.ts       shared wind (gusts); drives the haze drift and the litter
  litter.ts     scarce leaves and papers blown along by the wind
  fire.ts       burning oil barrels in the ground-floor bays, fire light pool, shared flame textures
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
