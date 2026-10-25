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
  lives: 1,
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
  /** chance a soldier comes out of a building instead of walking in from off-screen (how much infantry, and when, is in the level file) */
  ledgeChance: 0.65,
} as const;

export const SOLDIER = {
  hp: 4,
  walkSpeed: 2.2,
  /** troops off a truck run: to cover, or off to a spot of their own */
  runSpeed: 3,
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
  spreadBase: 0.4,
  /** ...plus this much per unit of distance to the mech */
  spreadPerUnit: 0.055,
  /** vertical and depth misses are this share of the sideways one */
  spreadVertical: 0.6,
  spreadDepth: 0.5,
} as const;

/** what the blast of a destroyed gun or truck does to whoever is within its radius */
export const BLAST = {
  /** a fast-moving chunk of rubble that hits a gun, truck or horse does this much (soldiers it kills outright) */
  rubbleDamage: 2,
  /** vehicles and horses take this much at the centre... */
  vehicleDamage: 45,
  /** ...falling to this share of it at the edge. Infantry caught in it are killed outright. */
  edgeShare: 0.4,
} as const;

/** failsafe against a scene that cannot be finished (a straggler that wandered off, a kill that was never counted) */
export const STALL = {
  /** no kill and no spawn for this long (s) and nobody in sight: anyone still alive off-screen is removed... */
  offscreenAfter: 20,
  /** ...and if nobody is left alive and the whole budget is spent, the missing kills are written off */
  writeOffAfter: 22,
  /** after this long anyone still alive is removed, seen or not */
  anyoneAfter: 45,
} as const;

export const WEAPON = {
  /** shots / second (machine gun) */
  fireRate: 20,
  heatPerShot: 0.02 / 4,
  /** heat lost per second while idle / while locked out */
  coolRate: 0.25,
  lockCoolRate: 0.4,
  unlockAt: 0.35,
  damage: 1,
  /** a bullet kill flings the target along the bullet's path at this speed (units/s): a share of the bullet's momentum. Heavier things take less of it. */
  killPush: 9,
  pushShare: { soldier: 1, horse: 0.5, vehicle: 0.2 },
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
  /** when the gun itself is destroyed: blast radius and particle multiplier (a shell is 1) */
  wreckBlastRadius: 1.9,
  wreckBlastScale: 3.5,
  /** shield lost when a shell lands within the blast radius or hits the mech */
  damage: 20,
  /** most guns that ride in together (side by side, spread across the street) */
  packMax: 3,
  /** a pack's units arrive this far apart in x so they do not move in lockstep */
  packStagger: 3,
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
  /** seconds between soldiers when unloading as a stream */
  streamInterval: 0.4,
  /** or in groups of this many, this far apart (seconds) */
  groupMin: 3,
  groupMax: 4,
  groupGap: 1.6,
  /** share of the troops that run for cover, the rest scatter to spots of their own; none of them charge the mech */
  coverChance: 0.5,
  blastRadius: 2.6,
  /** particle count multiplier for its explosion (a shell is 1) */
  blastScale: 5,
  /** the blast throws the hulk up: launch speed (units/s, about 3-5 units of height) and how long it keeps burning in the air and after (s) */
  launchMin: 4,
  launchExtra: 1,
  flameTime: 2.6,
} as const;

/**
 * Enemy bomber: a slow, white WW2-style aeroplane that patrols the top of the screen, back and forth, dropping
 * bombs on the mech until it is shot down. Two at once fly at different heights.
 */
export const AIRCRAFT = {
  /** much tougher than a soldier, a bit under half a truck: a couple of seconds of sustained fire brings it down */
  hp: SOLDIER.hp * 8,
  /** world units / s: slow enough to track */
  speed: 3.4 * 1.25,
  /** most planes that fly in together, at different heights */
  packMax: 2,
  /** the highest one flies this far below the top of the screen; each further one this much lower again (units) */
  topMargin: 1.3,
  levelGap: 1.5,
  minAltitude: 5,
  /** how far past the screen edge it flies before it turns round (units) */
  turnMargin: 6,
  /** seconds between bombs while it is over the screen */
  dropInterval: 1,
  /** each bomb comes down at a depth this far (units) either side of the mech's */
  aimSpread: 1.6,
  /** shot down: the blast in the air; when it hits the ground the blast is twice as big; the wreck burns for this long (s) */
  wreckBlastRadius: 1.8,
  wreckBlastScale: 3,
  crashBlastRadius: 3.6,
  crashBlastScale: 6,
  /** how hard the crash blast shoves rubble about, as a share of what a blast that size would (the fireball is unchanged) */
  crashShock: 0.5,
  flameTime: 26,
} as const;

/** Explosive oil barrels: dark drums that go up when shot, hit by a blast, or dropped from a collapsing floor. */
export const EXPLOSIVE_BARREL = {
  /** how far the blast kills infantry and hurts vehicles: more than a bomb, less than a truck wreck */
  blastRadius: 2.2,
  blastScale: 2.6,
  /** how hard the shockwave shoves rubble */
  shock: 1.6,
  /** the blast bites the building this many times over (each pass weakens every layer in reach by one) */
  buildingPasses: 3,
  /** a barrel set off by a nearby blast goes up after this delay, longer toward the edge (seconds) */
  chainDelay: 0.08,
  chainSpread: 0.22,
  /** a barrel dropping further than this when its floor goes explodes on landing */
  fallBlast: 0.8,
  /** barrels per building: chance of having any, of a second, and where they stand */
  chance: 0.7,
  secondChance: 0.35,
  /** second-row buildings are scenery: scale the odds down */
  rearShare: 0.5,
  /** of those, the share that stand in the street against the front wall rather than in a bay (any floor) */
  streetShare: 0.35,
} as const;

/** A bomb: about the size of a soldier, falls with the plane's speed and explodes on the first thing it meets (or when shot). */
export const BOMB = {
  gravity: 5,
  blastRadius: 1.5,
  blastScale: 2,
  /** shield lost when it lands within the blast radius or hits the mech */
  damage: 20,
} as const;

/**
 * Level 1 boss: two missile silos set into the ground. They stay shut and unhurtable while the infantry wave
 * is on; once enough of it has been sent in they open together, and each arms and launches a slow ballistic
 * missile at the mech before closing again. Only an open silo can be damaged.
 */
export const SILO = {
  /** the missile inside is the weak point: far tougher than a gun, so it takes more than one opening to bring down */
  hp: SOLDIER.hp * 40,
  /** where they sit relative to the view's centre (units): side by side on the left half, a little apart, and the depth they are in */
  offsetsX: [-9, -4],
  z: -2.5,
  /** seconds the doors take to slide open / shut */
  openTime: 1.2,
  closeTime: 1.2,
  /** seconds both stay shut before they open again (counted from the moment both are shut) */
  closedTime: 3,
  /** seconds a silo sits open before it launches; the second one's countdown is this much longer */
  armTime: 4.5,
  armStagger: 0.9,
  /** seconds the missile takes to leave the silo, still a target while it does */
  fireTime: 0.8,
  /** with only one silo left it runs its whole cycle this much faster */
  enrageSpeed: 1.6,
  /** destroyed: the blast (it hurts whoever is near, as a wrecked gun's does) */
  wreckBlastRadius: 2.2,
  wreckBlastScale: 4,
} as const;

/** The silos' missile: climbs straight up, slowly, far above the view, then arcs down toward where the mech was when it turned over. */
export const MISSILE = {
  /** a missile is a target all the way: tougher than a bomb, but a second or so of sustained fire brings it down */
  hp: SOLDIER.hp * 3,
  /** climb: starting speed and acceleration (units/s, units/s²) */
  climbSpeed: 2,
  climbAccel: 3,
  /** the height it turns over at (units): well off the top of the view, so the descent is what the mech has to dodge */
  apexMin: 16,
  apexMax: 24,
  /** seconds the descent takes from the top of the climb to the aim point: slow enough to walk out from under */
  flightMin: 3,
  flightMax: 5,
  gravity: 3.2,
  /** how far from the mech's position at the turn-over the aim point may lie */
  spreadX: 2,
  spreadZ: 1,
  blastRadius: 3,
  blastScale: 5,
  /** shield lost when it lands within the blast radius: strips most of the shield at once */
  damage: 45,
  /** screen shake (world units of camera movement) for a blast on screen */
  shake: 0.45,
} as const;

/** The mech's death: a huge fireball, a mushroom cloud, and the mech's parts flung about. */
export const MECH_DEATH = {
  /** how long the screen is the mech's funeral before the next life starts or the game over screen comes up (s) */
  time: 3.8,
  /** a new mech cannot be hurt for this long (s) */
  invulnerable: 2.5,
  /** the middle of the blast, above the ground; it kills infantry and hurts vehicles within the radius */
  height: 1.2,
  blastRadius: 14,
  blastScale: 6,
  /** the biggest lobe of the fireball (diameter, units) and how many smaller lobes boil round it */
  fireballSize: 32,
  lobes: 9,
  ringLife: 1,
  /** screen shake (units of camera movement), mild, for each of the two blasts */
  shake: 0.5,
  podShake: 0.35,
  /** the blast tears buildings apart this far out (units), flinging the rubble away at up to this speed (units/s) */
  buildingRadius: 18,
  buildingSpeed: 14,
  /** smoke: the stem climbs at this speed for this long; the cap starts then and spreads this fast for capTime */
  stemSpeed: 7,
  stemTime: 3,
  capStart: 1.3,
  capTime: 1.8,
  capSpread: 4,
  /** the cockpit is launched straight up to the height the game gives it, tilting up to this much (degrees) about each axis on the way, and blows up there */
  podGravity: 6,
  podTiltDeg: 15,
  podBlastRadius: 9,
  podBlastScale: 4,
  podFireballSize: 18,
  podBuildingRadius: 10,
  podBuildingSpeed: 8,
  /** parts: how hard they are thrown, the share that burn, and for how long (s) */
  partSpeed: 5,
  burnShare: 0.25,
  burnTime: 8,
} as const;

/** Craters: every ground-level blast scorches the ground (a flat decal); the mech's death digs a real one. */
export const CRATER = {
  /** most scorch decals kept; the oldest is overwritten */
  maxScorch: 80,
  /** a blast scorches an area this many times its radius across, and none smaller than this (units) */
  scorchPerRadius: 1.5,
  scorchMin: 0.8,
  /** the mech's crater: the bowl's radius and depth, and the raised lip round it (units) */
  mechRadius: 5.5,
  mechDepth: 1.1,
  mechLip: 0.22,
  /** seconds it takes to dig itself out */
  digTime: 0.7,
} as const;

/** Bullet casings thrown out of the guns: size (units), how many per shot, speed, how far the direction may stray, how long they last */
export const CASING = {
  radius: 0.011,
  length: 0.055,
  /** casings per shot of the gun: it fires fast, so there are many */
  perShot: 2,
  /** most at once: the oldest are never dropped, new ones are just not thrown while full */
  max: 600,
  speedMin: 2.2,
  speedMax: 4.4,
  /** the random angle off the ejection direction (degrees, up to this far either way) */
  spreadDeg: 25,
  /** the bounce off the ground, and the speed (units/s) below which it stops bouncing and lies still */
  bounce: 0.35,
  restSpeed: 0.8,
  lifeMin: 2.5,
  lifeMax: 4,
  /** seconds it takes to shrink away at the end */
  fadeTime: 0.6,
} as const;
