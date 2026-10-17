/** Gameplay tuning in one place. Geometry/visual constants stay next to the code that draws them. */

export const PLAYER = {
  /** nimble enough to dodge grenades */
  walkSpeed: 4.5,
  walkAccel: 14,
  /** rubble underfoot: speed multiplier = 1 - slowPerBulk * density, never below slowMin */
  rubbleSlowPerBulk: 0.07,
  rubbleSlowMin: 0.4,
  /** how quickly the slowdown eases in and out (1/s) */
  rubbleSlowEase: 6,
  maxShield: 100,
  lives: 3,
  /** shield lost per enemy hit */
  hitDamage: 4,
} as const;

export const CAMERA = {
  height: 3.5,
  /** the mech is kept within this fraction of the visible half-width */
  mechMargin: 0.92,
  /** debris farther than this many screens from the camera is culled */
  cullScreens: 2.5,
} as const;

export const SPAWN = {
  /** enemies alive at once */
  maxAlive: 12,
  waveMin: 3,
  waveExtra: 4,
  /** chance a soldier comes out of a building instead of walking in from off-screen */
  ledgeChance: 0.65,
  /** seconds between waves: min + random * extra */
  intervalMin: 3,
  intervalExtra: 2.5,
} as const;

export const SOLDIER = {
  hp: 4,
} as const;

/** soldier fire against the mech */
export const ENEMY_FIRE = {
  hitChance: 0.5,
} as const;

export const WEAPON = {
  /** shots / second (machine gun) */
  fireRate: 20,
  heatPerShot: 0.02 / 6,
  /** heat lost per second while idle / while locked out */
  coolRate: 0.25,
  lockCoolRate: 0.4,
  unlockAt: 0.35,
  damage: 1,
  wallRadius: 0.3,
  /** camera distance the jitter radii were tuned at */
  refDist: 24,
} as const;

/**
 * Horse-drawn cannon: rides in from the right with two soldiers aboard, unhitches, then the crew lobs slow
 * shells at the mech. The gun, each crew member and the horse can all be shot.
 */
export const CANNON = {
  /** the gun is far tougher than any soldier */
  hp: SOLDIER.hp * 15,
  horseHp: SOLDIER.hp * 2,
  /** world units / s while the horse drags the cannon in (30% slower than it first galloped) */
  rideSpeed: 6.3,
  /** once unhitched the horse bolts this much faster than it was pulling */
  horseBoltFactor: 1.2,
  /** soldiers aboard; they man the gun once it is deployed */
  crew: 2,
  /** seconds between rounds with a full crew; fewer crew load proportionally slower, none cannot fire */
  fireInterval: 4,
  firstShotDelay: 1.2,
  /** shell time of flight, seconds: slow enough to walk out from under */
  flightMin: 2.3,
  flightMax: 2.9,
  /** low gravity keeps the lob flat: apex ~2.5 units for a 2.6 s flight (it used to climb to ~7) */
  shellGravity: 3.2,
  /** how far a shell may land from the mech's position when fired (no lead on its movement) */
  spreadX: 2.5,
  spreadZ: 1.5,
  blastRadius: 1.1,
  /** shield lost when a shell lands within the blast radius or hits the mech */
  damage: 20,
  /** each time a cannon is due, 1..packMax of them ride in side by side, spread across the street */
  packMax: 3,
  /** a pack's units arrive this far apart in x so they do not move in lockstep */
  packStagger: 3,
  /** a cannon crew rides in at most this often, and never while another is still manned */
  firstDelay: 12,
  intervalMin: 16,
  intervalExtra: 12,
} as const;
