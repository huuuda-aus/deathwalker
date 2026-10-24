import * as THREE from 'three';
import { Soldier, type Enemy, type SoldierEnv } from './enemies';
import { CannonUnit } from './cannon';
import { Horse } from './horse';
import { TruckUnit } from './truck';
import { AircraftUnit } from './aircraft';
import { Bomb } from './bomb';
import { SiloUnit } from './silo';
import { SiloBoss } from './boss';
import type { BossDef } from './level';
import type { Missiles } from './missiles';
import type { Explosions } from './explosions';
import type { Bullets } from './bullets';
import type { Shells } from './shells';
import type { Dust } from './dust';
import type { Fx } from './fx';
import type { World } from './world';
import type { Debris } from './debris';
import { LANE, type Mech } from './mech';
import { SPAWN, ENEMY_FIRE, CANNON, STOMP, STALL, BLAST, AIRCRAFT, SILO } from './config';
import { SCREEN_W, type LevelRunner } from './level';

const chest = new THREE.Vector3();
const shotAt = new THREE.Vector3();
const crushBox = new THREE.Box3();
const sightRay = new THREE.Ray();
const sightHit = new THREE.Vector3();

/** Spawns soldier waves from the level budget, steps them, scores kills and removes the dead and the fled. */
export interface EnemyDeps {
  scene: THREE.Scene;
  world: World;
  level: LevelRunner;
  fx: Fx;
  debris: Debris;
  mech: Mech;
  /** how soldiers query rubble and surfaces */
  env: SoldierEnv;
  shells: Shells;
  missiles: Missiles;
  dust: Dust;
  explosions: Explosions;
  bullets: Bullets;
  /** shield damage to the player (a bomb going off beside the mech) */
  onPlayerHit: (damage: number) => void;
}

export class EnemyManager {
  readonly list: Enemy[] = [];
  private spawnTimer = 1;
  /** where the screen is, for the planes: camera x, and the height of the top of the view at the gameplay depth */
  private camX = 0;
  viewTop = 9;
  /** how long the scene has gone without a kill or a spawn (see failsafe) */
  private stallT = 0;
  private stallMark = '';
  private clock = 0;
  private rubbleHit = new WeakMap<Enemy, number>();
  /** the scene's boss, once it is in place, and the scene it belongs to */
  boss: SiloBoss | null = null;
  private bossScene = -1;
  /** seconds until the boss scene sends its next truck */
  private truckT = 0;

  constructor(private readonly deps: EnemyDeps) {
    const { debris, fx } = deps;
    deps.explosions.onBlast = (at, radius) => this.blast(at, radius);
    // falling masonry crushes soldiers it touches
    debris.onContact = (pos, size) => {
      for (const e of this.list) {
        if (!e.alive) continue;
        e.getBox(crushBox).expandByScalar(size * 0.35);
        if (!crushBox.containsPoint(pos)) continue;
        if (e instanceof Soldier) { e.damage(99, fx); continue; }
        // a gun or truck shrugs rubble off: a light knock, at most a few times a second however much falls on it
        if (this.clock - (this.rubbleHit.get(e) ?? -1) < 0.25) continue;
        this.rubbleHit.set(e, this.clock);
        e.damage(BLAST.rubbleDamage, fx);
      }
    };
  }

  /** A vehicle blew up: infantry within the radius are killed, guns, trucks and horses are damaged (less toward the edge). */
  private blast(at: THREE.Vector3, radius: number): void {
    const { fx } = this.deps;
    for (const e of [...this.list]) {                        // a chain reaction can add to the list
      if (!e.alive) continue;
      const d = e.getBox(crushBox).distanceToPoint(at);
      if (d > radius) continue;
      if (e instanceof Soldier) e.damage(99, fx);
      else e.damage(BLAST.vehicleDamage * (1 - (1 - BLAST.edgeShare) * (d / radius)), fx);
    }
  }

  /** put an enemy made mid-fight (a missile) into the scene and the fight */
  add(e: Enemy): void {
    this.deps.scene.add(e.group);
    this.list.push(e);
  }

  reset(): void {
    for (const e of this.list) this.discard(e);
    this.list.length = 0;
    this.boss = null;
    this.bossScene = -1;
  }

  /** the current scene is over: whoever is left runs away */
  retreatAll(): void {
    for (const e of this.list) if (e.alive) e.retreating = true;
  }

  /** stragglers that fled the previous scene are gone by the time the next one starts */
  purgeRetreating(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].retreating) { this.discard(this.list[i]); this.list.splice(i, 1); }
    }
  }

  /**
   * A personnel carrier arrives from either side, turns to face the camera in the left half of the
   * screen and unloads its troops (as many as the scene's data says); one
   * truck at a time.
   */
  private spawnTruck(troops: number, camX: number): boolean {
    const { scene, level, mech, env, dust, explosions, debris, world } = this.deps;
    if (this.list.some((e) => e instanceof TruckUnit && e.busy)) return false;
    const fromRight = Math.random() < 0.5;
    const half = SCREEN_W / 2;
    const { dx, dz } = TruckUnit.turnShift(fromRight);
    // it comes to rest in the left half of the screen, in a lane that leaves room for the swing; steer clear of the mech's lane
    const zLow = LANE.zMin + dz + 0.3, zHigh = LANE.zMax - 0.2;
    let zEnd = zLow + Math.random() * (zHigh - zLow);
    for (let i = 0; i < 5 && Math.abs(zEnd - dz - mech.root.position.z) < 1.3; i++) zEnd = zLow + Math.random() * (zHigh - zLow);
    const stopX = camX - 1.5 - Math.random() * (half - 4);
    const unit = new TruckUnit(
      { fromRight, edgeX: camX + (fromRight ? half + 6 : -half - 6), zDrive: zEnd - dz, turnStartX: stopX - dx, troops },
      { env, dust, explosions, debris, floor: (x, z, y) => world.surfaceTop(x, z, y), add: (e) => { scene.add(e.group); this.list.push(e); } },
    );
    scene.add(unit.group);
    this.list.push(unit);
    level.spawned += 1 + troops;
    return true;
  }

  /** An unmanned gun waves in the nearest free infantryman within reach, to take over as gunner. */
  private recruit(cannon: CannonUnit): void {
    const p = cannon.group.position;
    let best: Soldier | null = null, bestD: number = CANNON.recruitRange;
    for (const e of this.list) {
      if (!(e instanceof Soldier) || !e.free) continue;
      const d = Math.hypot(e.x - p.x, e.group.position.z - p.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) cannon.claim(best);
  }

  /** Is this soldier inside one of the mech's hit spheres (a foot coming down on him, a knee, the body)? */
  private underFoot(s: Soldier): boolean {
    const floor = s.group.position.y;
    for (const c of this.deps.mech.colliders) {
      if (c.pos.y - c.r > floor + STOMP.height || c.pos.y + c.r < floor) continue;
      const reach = c.r + STOMP.reach;
      if ((c.pos.x - s.x) ** 2 + (c.pos.z - s.group.position.z) ** 2 < reach * reach) return true;
    }
    return false;
  }

  private discard(e: Enemy): void {
    this.deps.scene.remove(e.group);
    e.dispose();
  }

  /**
   * A horse-drawn cannon (or a few side by side) gallops in from behind the mech and stops somewhere between mid-screen
   * and the left edge. Only one manned group at a time.
   */
  private spawnCannon(count: number, camX: number): boolean {
    const { scene, level, mech, shells, env, debris, dust, world, explosions } = this.deps;
    // the gun and its crew all come out of the scene's spawn budget
    const cost = 1 + CANNON.crew;
    if (this.list.some((e) => e instanceof CannonUnit && e.operational)) return false;
    const half = SCREEN_W / 2;
    const lanes = this.packLanes(count, mech.root.position.z);
    for (let n = 0; n < count; n++) {
      const z = lanes[n];
      const x = camX + half + 5 + n * CANNON.packStagger;
      const stopX = camX - Math.random() * (half - 2);
      const crew = Array.from({ length: CANNON.crew }, () => new Soldier(x, z, env));
      const horse = new Horse();
      const unit = new CannonUnit(x, z, stopX, crew, horse, { shells, debris, dust, explosions, floor: (fx, fz, fy) => world.surfaceTop(fx, fz, fy) });
      for (const e of [unit, ...crew, horse]) { scene.add(e.group); this.list.push(e); }
      level.spawned += cost;
    }
    return true;
  }

  /**
   * A flight of bombers flies in over the top of the screen from the left, each at its own height so they never meet.
   * They keep coming, left to right, until shot down. One flight at a time.
   */
  private spawnAircraft(count: number, camX: number): boolean {
    const { scene, level, mech, explosions, dust, debris, world } = this.deps;
    if (this.list.some((e) => e instanceof AircraftUnit && e.alive)) return false;
    const half = SCREEN_W / 2;
    const top = this.viewTop - AIRCRAFT.topMargin;
    for (let n = 0; n < count; n++) {
      const y = Math.max(AIRCRAFT.minAltitude, top - n * AIRCRAFT.levelGap);
      // different heights, and also staggered in depth and along the way, so they never share a spot
      const z = -2 + n * 2.5 + Math.random();
      const startX = camX - half - AIRCRAFT.turnMargin - n * 6;   // in from the left, one behind the other
      const unit = new AircraftUnit(
        { startX, y, z },
        {
          add: (e) => { scene.add(e.group); this.list.push(e); },
          explosions, dust, debris, floor: (x, zz, yy) => world.surfaceTop(x, zz, yy),
          bombs: { world, explosions, colliders: mech.colliders, onPlayerHit: this.deps.onPlayerHit },
          view: () => ({ x: this.camX, half }),
        },
      );
      scene.add(unit.group);
      this.list.push(unit);
      level.spawned++;
    }
    return true;
  }

  /**
   * `count` lane depths, one per equal band of the street so neighbours are always well apart (a pack of
   * three keeps at least ~1.6 units between lines). A lone cannon may pick anywhere, but steers clear of the
   * mech's lane so it does not ride straight through it.
   */
  private packLanes(count: number, mechZ: number): number[] {
    const band = (LANE.zMax - LANE.zMin) / count;
    const jitter = count === 1 ? 0.5 * band : 0.2 * band;
    const pick = (n: number): number => LANE.zMin + (n + 0.5) * band + (Math.random() * 2 - 1) * jitter;
    const lanes = Array.from({ length: count }, (_, n) => pick(n));
    if (count === 1) for (let i = 0; i < 5 && Math.abs(lanes[0] - mechZ) < 1.5; i++) lanes[0] = pick(0);
    return lanes;
  }

  /**
   * The scene's boss: two silos set into the ground either side of the view, there from the start of the scene
   * (shut, so just scenery until the boss opens them). Both come out of the scene's spawn budget.
   */
  private spawnBoss(camX: number): void {
    const { scene, level, world, debris, dust, explosions, missiles } = this.deps;
    const def = level.scene.boss;
    if (!def || this.bossScene === level.index) return;
    this.bossScene = level.index;
    const deps = { explosions, debris, dust, missiles, floor: (x: number, z: number, y: number) => world.surfaceTop(x, z, y) };
    const silos = [-1, 1].map((side, i) => new SiloUnit(camX + side * SILO.offsetX, SILO.z, SILO.armTime + i * SILO.armStagger, deps));
    for (const s of silos) { scene.add(s.group); this.list.push(s); }
    this.boss = new SiloBoss(silos, def.opensAfter);
    this.truckT = this.nextTruck(def);
  }

  /** seconds to the next truck: the boss's interval, give or take its jitter */
  private nextTruck(def: BossDef): number { return def.truckEvery + (Math.random() * 2 - 1) * def.truckJitter; }

  /** A truck of troops every so often while the boss lives; if one is still unloading, the next waits for it. */
  private runBossTrucks(dt: number, camX: number, spawning: boolean): void {
    const { level } = this.deps;
    const def = level.scene.boss;
    if (!def || !spawning || !level.canSpawn || this.boss?.phase === 'down') return;
    this.truckT -= dt;
    if (this.truckT <= 0 && this.spawnTruck(def.truckTroops, camX)) this.truckT = this.nextTruck(def);
  }

  /** waves of 3-6 from the scene budget; most come out of buildings, the rest walk in from off-screen */
  private spawn(dt: number, camX: number): void {
    const { scene, world, level, mech, env } = this.deps;
    const mechX = mech.root.position.x;
    this.spawnTimer -= dt;
    let alive = 0;
    for (const e of this.list) if (e.alive && !(e instanceof Bomb)) alive++;
    const inf = level.scene.infantry;
    // a boss scene never runs out of infantry
    const left = level.scene.boss ? Infinity : inf.count - level.infantrySpawned;
    if (this.spawnTimer > 0 || !level.canSpawn || left <= 0 || alive >= inf.maxAlive) return;
    const half = SCREEN_W / 2;
    // a bay only qualifies if a soldier standing in it could actually hit the mech: no wall or rubble in the way
    const canFire = (from: THREE.Vector3): boolean => {
      const target = mech.pivotWorld;
      const len = sightRay.origin.copy(from).distanceTo(target);
      sightRay.direction.subVectors(target, from).divideScalar(len);
      return world.raycast(sightRay, sightHit) >= len - 0.05 && env.sight(from, target);
    };
    const wave = Math.min(inf.waveMin + Math.floor(Math.random() * inf.waveExtra), inf.maxAlive - alive, left);
    for (let w = 0; w < wave; w++) {
      const bay = Math.random() < SPAWN.ledgeChance ? world.takeLedge(camX - half * 0.85, mechX - 5, canFire) : null;
      let s: Soldier;
      if (bay) {
        s = new Soldier(bay.pos.x, bay.pos.z, env);
        s.perchAt(bay.pos, { ledgeZ: bay.ledgeZ, backZ: bay.backZ, floorTop: bay.floorTop, carrierAt: bay.carrierAt });
      } else {
        s = new Soldier(camX - half - 3 - Math.random() * 8, LANE.zMin + Math.random() * (LANE.zMax - LANE.zMin), env);
      }
      scene.add(s.group);
      this.list.push(s);
      level.spawned++;
      level.infantrySpawned++;
    }
    this.spawnTimer = inf.intervalMin + Math.random() * inf.intervalExtra;
  }

  /**
   * The scene's vehicles arrive on cue: each event goes once the scene has sent in enough of its infantry (its `at`),
   * or as soon after that as it can (one flight, one truck unloading, one manned gun at a time).
   */
  private runEvents(camX: number): void {
    const { level } = this.deps;
    if (!level.canSpawn) return;
    level.scene.events.forEach((ev, i) => {
      if (level.fired.has(i) || level.progress < ev.at) return;
      const sent = ev.type === 'cannon' ? this.spawnCannon(ev.count, camX)
        : ev.type === 'truck' ? this.spawnTruck(ev.troops, camX)
        : this.spawnAircraft(ev.count, camX);
      if (sent) level.fired.add(i);
    });
  }

  /**
   * Failsafe for a scene that cannot be finished, e.g. stuck at 47/48 with nobody in sight: after a while without
   * any kill or spawn, stragglers off-screen are removed, and if nobody is left and everything has been spawned,
   * the kills that were never counted are written off.
   */
  private failsafe(dt: number, camX: number): void {
    const { level, fx } = this.deps;
    // a boss scene ends with the boss, whatever else is alive
    if (level.phase !== 'active' || level.scene.boss || level.kills >= level.scene.spawnBudget) { this.stallT = 0; return; }
    const mark = `${level.index}:${level.kills}:${level.spawned}`;
    if (mark !== this.stallMark) { this.stallMark = mark; this.stallT = 0; return; }
    this.stallT += dt;
    if (this.stallT < STALL.offscreenAfter) return;
    const half = SCREEN_W / 2 + 1;
    let left = 0;
    for (const e of this.list) {
      if (!e.alive || e.retreating) continue;
      if (e instanceof AircraftUnit || e instanceof Bomb || e instanceof SiloUnit) { left++; continue; }   // they patrol in and out of view / cannot be hurt until they open
      const seen = Math.abs(e.x - camX) < half;
      if (seen && this.stallT < STALL.anyoneAfter) { left++; continue; }
      e.damage(9999, fx);
    }
    if (left === 0 && this.stallT >= STALL.writeOffAfter && level.spawned >= level.scene.spawnBudget) level.writeOffKills();
  }

  /**
   * @param spawning false once the player is dead
   */
  update(dt: number, camX: number, spawning: boolean): void {
    const { level, fx, mech, bullets } = this.deps;
    this.clock += dt;
    if (spawning) this.failsafe(dt, camX);
    this.camX = camX;
    if (spawning) { this.spawn(dt, camX); this.runEvents(camX); }
    if (level.canSpawn) this.spawnBoss(camX);
    if (level.index !== this.bossScene) this.boss = null;
    if (this.boss) {
      this.boss.update(level.infantrySpawned);
      if (this.boss.phase === 'down') level.bossDown = true;
      this.runBossTrucks(dt, camX, spawning);
    }
    chest.copy(mech.pivotWorld);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.update(dt, mech.root.position, fx, (from, miss) => {
        if (!spawning) return;
        // aimed at where the mech's chest is right now, off by a random amount that grows with distance: a mech
        // that keeps moving walks out of the way of the bullets
        const spread = ENEMY_FIRE.spreadBase + ENEMY_FIRE.spreadPerUnit * from.distanceTo(chest);
        shotAt.set(
          chest.x + miss.x * spread,
          chest.y + miss.y * spread * ENEMY_FIRE.spreadVertical,
          chest.z + miss.z * spread * ENEMY_FIRE.spreadDepth,
        );
        bullets.fire(from, shotAt);
      });
      if (e instanceof Soldier && e.alive && this.underFoot(e)) e.splat(fx);
      if (e instanceof CannonUnit && e.needsCrew) this.recruit(e);
      // a gun with no crew left is out of the fight: it no longer has to be destroyed to clear the scene
      if (e instanceof CannonUnit && e.alive && !e.counted && !e.retreating && !e.operational) { e.counted = true; level.addKill(); }
      // likewise an empty truck, once its troops are out
      if (e instanceof TruckUnit && e.alive && !e.counted && !e.retreating && e.empty) { e.counted = true; level.addKill(); }
      if (!e.alive && !e.counted) { e.counted = true; level.addKill(); }
      if ((!e.alive && e.deadTime > 8) || e.gone || (e.retreating && e.x < camX - 14)) {
        this.discard(e);
        this.list.splice(i, 1);
      }
    }
  }
}
