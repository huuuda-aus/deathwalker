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
