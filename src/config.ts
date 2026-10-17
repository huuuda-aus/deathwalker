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
  /** soldiers fight inside the mech's reachable area: the visible width, less this much at each side */
  arenaPad: 0.8,
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
  walkSpeed: 1.2,
  /** troops off a truck run: to cover, or off to a spot of their own */
  runSpeed: 2.6,
  /** a scattering trooper picks a spot within this far (along the street) of where it landed... */
  scatterSpread: 4,
  /** ...and never nearer the mech than a distance picked between these */
  standoffMin: 6,
  standoffMax: 11,
  /** soldiers closer than this (world units) ease apart, so a crowd does not stack on one spot */
  personalSpace: 0.3,
  separateSpeed: 2,
  /** a trooper will not pick a spot nearer than this to one someone else is standing on or heading for */
  spotGap: 0.45,
  /** a soldier killed on an upper floor (higher than this) is flung out of the building this often, to burst on the ground */
  highFloorY: 1,
  plungeChance: 0.5,
} as const;

/** the mech's feet crush infantry they come down on */
export const STOMP = {
  /** a soldier this close (horizontally) to the edge of one of the mech's hit spheres is flattened */
  reach: 0.1,
  /** how tall a soldier is for this, from the floor he stands on */
  height: 0.3,
} as const;

/** soldier fire against the mech: real bullets that fly, miss and can be dodged */
export const ENEMY_FIRE = {
  /**
   * world units / s. About what a cannon shell moves at: it covers a typical 12-unit shot in roughly two
   * seconds, plenty of time for a nimble mech (4.5 units/s) to step out of the way.
   */
  bulletSpeed: 6,
  /** each shot is aimed at the mech's chest as it is right then (no allowance for movement), off by up to this far... */
  spreadBase: 0.5,
  /** ...plus this much per unit of distance to the mech */
  spreadPerUnit: 0.07,
  /** vertical and depth misses are this share of the sideways one */
  spreadVertical: 0.6,
  spreadDepth: 0.5,
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
  /** an unmanned (but intact) gun is taken over by street infantry coming within this far of it, up to a full crew */
  recruitRange: 7,
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

/**
 * Personnel carrier: drives in from either side, swings through ~90 degrees to face the camera in the left
 * half of the screen and unloads troops, who run to the nearest big rubble or straight at the mech.
 */
export const TRUCK = {
  /** as tough as the cannon */
  hp: CANNON.hp,
  /** world units / s while driving in; it brakes through the turn */
  speed: 4.5,
  turnTime: 1.2,
  /** it ends up facing the camera, give or take this many degrees */
  facingJitterDeg: 10,
  troopsMin: 8,
  troopsMax: 12,
  /** seconds between soldiers when unloading as a stream */
  streamInterval: 0.4,
  /** or in groups of this many, this far apart (seconds) */
  groupMin: 3,
  groupMax: 4,
  groupGap: 1.6,
  /** share of the troops that run for cover, the rest scatter to spots of their own; none of them charge the mech */
  coverChance: 0.5,
  /** the first truck arrives after this long, then every min + random * extra seconds, one unloading at a time */
  firstDelay: 20,
  intervalMin: 26,
  intervalExtra: 16,
  blastRadius: 1.5,
  /** particle count multiplier for its explosion (a shell is 1) */
  blastScale: 2.2,
} as const;
