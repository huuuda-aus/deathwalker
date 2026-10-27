import * as THREE from 'three';
import { Building, type Ledge, type LedgeSpawn } from './building';
import type { Debris } from './debris';
import type { Dust } from './dust';
import { GROUND_TILE, makeGroundTextures } from './ground';
import { Craters } from './craters';
import { Coals } from './coals';
import { FireBarrel, FireLights, type BarrelContext } from './fire';
import { ExplosiveBarrel } from './explosiveBarrel';
import type { Explosions } from './explosions';
import { EXPLOSIVE_BARREL } from './config';
import type { Fx } from './fx';
import { Puddles, type Puddle } from './water';
import { mulberry32 } from './util';
import type { WorldStyle } from './levelData';
import { terrain, terrainHeight, applyTerrain, type Road } from './terrain';
import { roadside, type Scenery, type SceneryEnv } from './scenery';
import { Wreckage } from './wreckage';
import { farDunes } from './farDunes';
import { RockWall } from './rockWall';
import { BlastDoor, DOOR_OFFSET_Z } from './blastDoor';
import type { Corridor } from './corridor';
import { LANE } from './mech';
import type { Blocker } from './debris';

/** height of a soldier's gun above the floor he stands on (world units), for line-of-fire checks from a bay */
const SHOOTER_CHEST = 0.25;

/** what the world keeps of one chunk of its length: the group of things in it and the lists the game works through */
interface Chunk { group: THREE.Group; buildings: Building[]; props: Building[]; barrels: FireBarrel[]; explosives: ExplosiveBarrel[]; puddles: Puddle[]; scenery: Scenery[]; walls: RockWall[] }

/** the dry-stone walls beside the walkway: where its edges lie (z), toward the camera and away from it (the walls stand a little out from there) */
const WALL_NEAR = 6.4, WALL_FAR = -7.4;

/** Distance haze: the ground and near rows fade to near-black, not green. */
export const FOG_COLOR = 0x030d0b;

const FAR_ROWS: [z: number, scale: number, color: number, dense: boolean][] = [
  [-32, 1.8, 0x010309, false],
  [-50, 2.2, 0x03080e, true],
  [-75, 2.8, 0x02060b, true],
  [-105, 3.6, 0x010407, true],
  [-140, 4.5, 0x010204, true],
];

/**
 * Procedural city in four rows, generated in chunks around the camera:
 *  1. front row (z -5): destructible ruins that host enemies,
 *  2. second row (z -14): the same destructible ruins, scenery only,
 *  3+. far rows (z -32 ... -140): dark cut-outs of the same ruined shapes against the night sky,
 *      dense behind the third row and fading into black with distance.
 */
export class World {
  readonly group = new THREE.Group();
  private chunkSize = 120;
  private centerChunk = NaN;
  private chunks = new Map<number, Chunk>();
  private fireLights: FireLights;
  /** hot coals from shot barrels */
  readonly coals: Coals;
  /** the barrel hit by the last raycastBarrel() */
  hitBarrel: FireBarrel | null = null;
  private fx: Fx | null = null;
  private explosions: Explosions | null = null;
  private groundMaps: THREE.Texture[] = [];
  /** scorch marks and real craters in the ground */
  readonly craters: Craters;
  /** the building hit by the last raycast() */
  lastBuilding: Building | null = null;
  private takeSeq = 0;
  private fireSpot = new THREE.Vector3();

  private readonly groundMaterial: THREE.MeshStandardMaterial;
  /** the parts of broken roadside props, flying and settling */
  private readonly wreck: Wreckage;
  private readonly sceneryEnv: SceneryEnv;
  /** the roadside prop hit by the last raycastScenery() */
  hitScenery: Scenery | null = null;
  /** the bunker's blast doors, once their chunk has been built (they keep their state when it is unloaded and built again) */
  door: BlastDoor | null = null;
  /** the screen shakes for something big at x (set by the game) */
  shake: (x: number, amount: number) => void = () => {};
  private readonly wallB = new THREE.Vector3();
  /** the far dunes' surface: lit like the rest, coloured by vertex */
  private readonly farDuneMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });

  /** @param style what the world is made of: the ruined city, or open desert (no buildings: far dunes on the horizon) */
  constructor(scene: THREE.Scene, private debris: Debris, private dust: Dust, private readonly style: WorldStyle = 'city', road: Road | null = null) {
    scene.fog = new THREE.Fog(FOG_COLOR, 28, 62);
    terrain.on = style === 'desert';
    terrain.road = style === 'desert' ? road : null;
    if (style === 'desert') {
      // the mech and the vehicles keep to a walkway between two low walls; the infantry may also stand outside them, behind them
      Object.assign(LANE, { zMin: -3.2, zMax: 2.6, soldierZMin: -10.2, soldierZMax: 9.6, wallBands: [[6.2, 7.7], [-8.7, -7.1]] });
    }
    this.wreck = new Wreckage(scene);
    this.sceneryEnv = { wreck: this.wreck, dust, fx: () => this.fx! };

    // textured ground: dirt, rubble and debris, with a normal map from the same height field
    const tex = makeGroundTextures(7, style === 'desert' ? 'sand' : 'ruins');
    const GW = 4000, GD = 260;
    for (const t of [tex.albedo, tex.normal]) {
      t.repeat.set(GW / GROUND_TILE, GD / GROUND_TILE);
      t.anisotropy = 8;
    }
    this.groundMaps = [tex.albedo, tex.normal];
    const groundMaterial = this.groundMaterial = new THREE.MeshStandardMaterial({ map: tex.albedo, normalMap: tex.normal, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.95, metalness: 0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GD), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -80;
    ground.receiveShadow = true;
    if (style !== 'desert') this.group.add(ground);       // the desert's ground is cut into chunks and follows the terrain: see buildDesertChunk
    this.craters = new Craters(scene, tex);     // not in `group`: its meshes follow the camera
    this.craters.cutHoles(groundMaterial);
    if (terrain.on) applyTerrain(groundMaterial);
    groundMaterial.userData.shared = true;
    this.farDuneMaterial.userData.shared = true;

    this.fireLights = new FireLights(scene, 3);
    this.coals = new Coals(scene);
    this.coals.surface = (x, z, y) => this.surfaceTop(x, z, y);
    this.coals.solid = (x, y, z) => this.solidAt(x, y, z);
    scene.add(this.group);
  }

  /** what the ground colour is multiplied by: a bright scene lifts the dark texture */
  setGroundTint(c: THREE.Color): void { this.groundMaterial.color.copy(c); }

  /** One chunk's piece of the ground, as fine a mesh as the dunes need; mapped exactly as the flat ground plane is, so craters and textures match. */
  private groundChunk(x0: number): THREE.Mesh {
    const GW = 4000, GD = 260, GZ = -80;
    const geo = new THREE.PlaneGeometry(this.chunkSize, GD, 60, 64).rotateX(-Math.PI / 2).translate(x0 + this.chunkSize / 2, 0, GZ);
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / GW + 0.5, -(p.getZ(i) - GZ) / GD + 0.5);
    const mesh = new THREE.Mesh(geo, this.groundMaterial);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;                // the shader lifts the vertices: the flat bounds would be wrong
    return mesh;
  }

  /** The desert: no buildings, the ground, and the dune sea behind it that runs out to the haze. */
  private buildDesertChunk(index: number): Chunk {
    const g = new THREE.Group();
    const x0 = index * this.chunkSize;
    g.add(this.groundChunk(x0));
    g.add(farDunes(x0, this.chunkSize, this.farDuneMaterial));
    const chunk: Chunk = { group: g, buildings: [], props: [], barrels: [], explosives: [], puddles: [], scenery: [], walls: [] };
    // a dry-stone wall along each side of the mech's walkway (the near one toward the camera, the mech's left; the far one, its right), leaving the bunker door clear
    const wx0 = Math.max(x0, (terrain.road?.doorX ?? -Infinity) + 16);
    if (wx0 < x0 + this.chunkSize - 2) {
      for (const [side, z, outward] of [[0, WALL_NEAR, 1], [1, WALL_FAR, -1]] as const) {
        const wall = new RockWall(wx0, x0 + this.chunkSize, z, outward, side, this.debris, this.dust);
        g.add(wall.mesh);
        chunk.walls.push(wall);
      }
    }
    const r = terrain.road;
    if (r && r.doorX >= x0 && r.doorX < x0 + this.chunkSize) {
      // the bunker's blast doors, at the end of the street, facing the mech as he comes (he walks left, so they face right)
      if (!this.door) {
        this.door = new BlastDoor({
          wreck: this.wreck, dust: this.dust, debris: this.debris, fx: () => this.fx!,
          blast: (at, radius, scale) => this.explosions?.wreckBlast(at, radius, scale),
          shake: (x, amount) => this.shake(x, amount),
        });
        this.door.place(r.doorX, terrainHeight(r.doorX, r.zc + DOOR_OFFSET_Z), r.zc + DOOR_OFFSET_Z);        // a little toward the back, so more of it shows
      }
      g.add(this.door.group);
    }
    if (r) {
      // the military roadside to the bunker door
      const side = roadside(x0, x0 + this.chunkSize, { doorX: r.doorX, zc: r.zc, halfWidth: r.halfWidth, reach: r.to - 6 }, this.sceneryEnv);
      for (const s of side.scenery) { g.add(s.group); chunk.scenery.push(s); }
      let k = 0;
      for (const p of side.drums) {
        const barrel = new ExplosiveBarrel(p.setY(terrainHeight(p.x, p.z)), null, k++ % 2 ? 'crate' : 'drum');
        g.add(barrel.group);
        chunk.explosives.push(barrel);
      }
    }
    return chunk;
  }

  private buildChunk(index: number): Chunk {
    if (this.style === 'desert') return this.buildDesertChunk(index);
    const rng = mulberry32(index * 7919 + 13);
    const g = new THREE.Group();
    const buildings: Building[] = [];
    const props: Building[] = [];
    const barrels: FireBarrel[] = [];
    const explosives: ExplosiveBarrel[] = [];
    const x0 = index * this.chunkSize;

    // destructible rows: the front row hosts enemies, the second row is scenery you can still wreck
    const row = (z0: number, tint: number, offset: number, gapMin: number, gapVar: number, hosts: boolean, fire: number): void => {
      let x = x0 + offset;
      while (x < x0 + this.chunkSize) {
        const b = new Building(x, z0, tint, rng, this.debris, this.dust);
        b.hostsEnemies = hosts;
        g.add(b.object);
        buildings.push(b);
        // a few burning oil barrels in the ground-floor bays (weaker fires in the second row)
        const n = rng() < 0.55 ? (rng() < 0.3 ? 2 : 1) : 0;
        for (const spot of b.groundBaySpots(n, rng)) {
          const barrel = new FireBarrel(spot, b, fire);
          g.add(barrel.group);
          barrels.push(barrel);
        }
        x += b.width + gapMin + rng() * gapVar;
      }
    };
    row(-5, 0x82848c, 0, 2.5, 4, true, 1.0);
    row(-14, 0x78808e, rng() * 6, 3, 7, false, 0.6);

    // Far rows: the same ruined shapes as flat dark cut-outs. Row 3 stands apart with gaps; everything
    // behind it is packed dense, and each row is a little darker until it all fades into black.
    const silhouettes = (z: number, scale: number, color: number, dense: boolean): void => {
      let x = x0 - 6 * scale + rng() * 8;
      while (x < x0 + this.chunkSize) {
        const b = new Building(0, 0, 0x000000, rng, this.debris, this.dust, false);
        b.asSilhouette(color);
        b.object.scale.setScalar(scale);
        b.object.position.set(x, 0, z + (rng() - 0.5) * 4);
        g.add(b.object);
        props.push(b);
        x += b.width * scale * (dense ? 0.45 + 0.4 * rng() : 1 + 0.3 * rng()) + (dense ? 0 : 2.5);
      }
    };
    for (const [z, scale, color, dense] of FAR_ROWS) silhouettes(z, scale, color, dense);
    const water = Puddles.build(index, this.chunkSize);
    g.add(water.mesh);
    // explosive barrels use their own random stream, so adding them leaves the city's layout as it was
    const brng = mulberry32(index * 104729 + 7);
    for (const b of buildings) {
      const share = b.hostsEnemies ? 1 : EXPLOSIVE_BARREL.rearShare;
      let n = brng() < EXPLOSIVE_BARREL.chance * share ? (brng() < EXPLOSIVE_BARREL.secondChance ? 2 : 1) : 0;
      while (n-- > 0) {
        const street = brng() < EXPLOSIVE_BARREL.streetShare;
        const pos = street ? b.streetSpot(brng) : b.bayFloorSpots(1, brng)[0];
        // it must stand on a floor that is really there
        if (!pos || (!street && b.floorTop(pos.x, pos.z, pos.y + 0.05) < pos.y - 0.01)) continue;
        const barrel = new ExplosiveBarrel(pos, street ? null : b, brng() < 0.35 ? 'crate' : 'drum');
        g.add(barrel.group);
        explosives.push(barrel);
      }
    }
    return { group: g, buildings, props, barrels, explosives, puddles: water.list, scenery: [], walls: [] };
  }

  /** Visit every destructible building whose x-range overlaps [minX, maxX]. */
  forEachBuilding(minX: number, maxX: number, cb: (b: Building) => void): void {
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) if (b.x0 <= maxX && b.x0 + b.width >= minX) cb(b);
    }
  }

  /** Highest solid building surface under (x, z) at or below y; else the ground, which is 0 unless a crater has been dug there. */
  surfaceTop(x: number, z: number, y: number): number {
    let best = 0;
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        if (x < b.x0 || x > b.x0 + b.width) continue;
        const h = b.solidTop(x, z, y);
        if (h > best) best = h;
      }
    }
    return best > 0 ? best : this.groundHeight(x, z);
  }

  /** the bare ground's height at (x, z): the dunes' (0 in the city), plus the crater's floor or lip if there is one */
  groundHeight(x: number, z: number): number { return terrainHeight(x, z) + this.craters.heightAt(x, z); }

  /** Is the point inside any intact building member? */
  solidAt(x: number, y: number, z: number): boolean {
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        if (x < b.x0 || x >= b.x0 + b.width) continue;
        if (b.solidAt(x, y, z)) return true;
      }
    }
    return false;
  }

  /** 0 on dry ground, up to 1 in the middle of a puddle. */
  puddleDepth(x: number, z: number): number {
    const chunk = this.chunks.get(Math.floor(x / this.chunkSize));
    return chunk ? Puddles.depthAt(chunk.puddles, x, z) : 0;
  }

  /** Weather state for the puddles: how hard it is raining and the nearby fire/muzzle lights. */
  setWeather(seconds: number, rain: number, lights: THREE.Vector4[]): void {
    const u = Puddles.uniforms;
    u.uTime.value = seconds % 600;
    u.uRain.value = rain;
    u.uLight0.value.copy(lights[0]);
    u.uLight1.value.copy(lights[1]);
  }

  /** Needed for barrels' spark bursts; set once the effects exist. */
  setFx(fx: Fx): void { this.fx = fx; }

  setPixelRatio(r: number): void { this.coals.setPixelRatio(r); }

  /** Nearest intact barrel along a ray (distance t, point in out). */
  raycastBarrel(ray: THREE.Ray, out: THREE.Vector3): number {
    let best = Infinity;
    const p = new THREE.Vector3();
    this.hitBarrel = null;
    for (const c of this.chunks.values()) {
      for (const f of c.barrels) {
        const t = f.raycast(ray, p);
        if (t < best) { best = t; out.copy(p); this.hitBarrel = f; }
      }
    }
    return best;
  }

  /** the explosive barrel hit by the last raycastExplosive() */
  hitExplosive: ExplosiveBarrel | null = null;

  /** Nearest explosive barrel along a ray (distance t, point in out). */
  raycastExplosive(ray: THREE.Ray, out: THREE.Vector3): number {
    let best = Infinity;
    const p = new THREE.Vector3();
    this.hitExplosive = null;
    for (const c of this.chunks.values()) {
      for (const e of c.explosives) {
        const t = e.raycast(ray, p);
        if (t < best) { best = t; out.copy(p); this.hitExplosive = e; }
      }
    }
    return best;
  }

  /** Nearest roadside prop along a ray (distance t, point in out). */
  raycastScenery(ray: THREE.Ray, out: THREE.Vector3): number {
    let best = Infinity;
    const p = new THREE.Vector3();
    this.hitScenery = null;
    for (const c of this.chunks.values()) {
      for (const s of c.scenery) {
        const t = s.raycast(ray, p);
        if (t < best) { best = t; out.copy(p); this.hitScenery = s; }
      }
    }
    return best;
  }

  // ---- the dry-stone walls

  /** Does the segment a -> b cross a wall? (the line of fire, for bullets and for the infantry's eyes) */
  wallSegmentHit(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): boolean {
    for (const c of this.chunks.values()) for (const w of c.walls) if (w.segmentHit(a, b, out)) return true;
    return false;
  }

  /** Nearest wall stone along a ray (distance t, point in out). */
  raycastWalls(ray: THREE.Ray, out: THREE.Vector3): number {
    this.wallB.copy(ray.direction).multiplyScalar(80).add(ray.origin);
    return this.wallSegmentHit(ray.origin, this.wallB, out) ? out.distanceTo(ray.origin) : Infinity;
  }

  /** the wall posts near (x, z), added to a list of blockers from index n (see RockWall.blockers); returns the new count. `sideZ`: only those a soldier at that z can shelter behind */
  wallBlockers(x: number, z: number, radius: number, out: Blocker[], n: number, sideZ?: number): number {
    for (const c of this.chunks.values()) for (const w of c.walls) n = w.blockers(x, z, radius, out, n, sideZ);
    return n;
  }

  /** A blast at `at` reaching `radius` breaches the walls in it. */
  blastWalls(at: THREE.Vector3, radius: number): void {
    for (const c of this.chunks.values()) for (const w of c.walls) w.damage(at, radius, 120);
  }

  /** A bullet into a wall: the stones round the hit take a point each (four dislodge one). */
  damageWalls(at: THREE.Vector3, amount: number): void {
    for (const c of this.chunks.values()) for (const w of c.walls) w.damage(at, 0.4, amount);
  }

  /** The mech wading through a wall: whatever one of its feet or knees touches is shoved off in a moment or two. */
  crushWalls(colliders: { pos: THREE.Vector3; r: number }[], dt: number): void {
    for (const c of this.chunks.values()) for (const w of c.walls) for (const k of colliders) w.damage(k.pos, k.r + 0.08, 9 * dt, true);
  }

  /** Where a ray meets the blast doors (distance, point in out), or Infinity. */
  raycastDoor(ray: THREE.Ray, out: THREE.Vector3): number { return this.door ? this.door.raycast(ray, out) : Infinity; }

  /** the hall behind the doors (set by the game): its lamps can be shot out */
  corridor: Corridor | null = null;
  raycastHall(ray: THREE.Ray, out: THREE.Vector3): number { return this.corridor ? this.corridor.raycastShell(ray, out) : Infinity; }
  raycastLamps(ray: THREE.Ray, out: THREE.Vector3): number { return this.corridor ? this.corridor.raycast(ray, out) : Infinity; }

  /** A bullet into the doors. */
  damageDoor(amount: number, at: THREE.Vector3): void { this.door?.damage(amount, at); }

  /** A blast at `at` reaching `radius`: the blast doors take their share. */
  blastDoor(at: THREE.Vector3, radius: number): void { this.door?.blast(at, radius); }

  /** A blast at `at` reaching `radius`: every roadside prop inside it takes punishment, the nearer ones more. */
  blastScenery(at: THREE.Vector3, radius: number): void {
    for (const c of this.chunks.values()) {
      for (const s of c.scenery) {
        if (s.gone) continue;
        const d = s.distanceTo(at);
        if (d <= radius) s.damage(120 * (1 - d / radius), at);
      }
    }
  }

  /** The mech walking through roadside props: whatever one of its feet or knees touches takes `dt` seconds of a heavy shove. */
  crushScenery(colliders: { pos: THREE.Vector3; r: number }[], dt: number): void {
    for (const c of this.chunks.values()) {
      for (const s of c.scenery) {
        if (s.gone) continue;
        for (const k of colliders) if (s.distanceTo(k.pos) < k.r) { s.damage(40 * dt, k.pos); break; }
      }
    }
  }

  /** A blast at `at` reaching `radius`: every explosive barrel inside it goes up, the nearer ones sooner. */
  igniteBarrels(at: THREE.Vector3, radius: number): void {
    const { chainDelay, chainSpread } = EXPLOSIVE_BARREL;
    for (const c of this.chunks.values()) {
      for (const e of c.explosives) {
        if (e.gone) continue;
        const d = e.blastPoint.distanceTo(at);
        if (d <= radius) e.ignite(chainDelay + chainSpread * (d / radius));
      }
    }
  }

  /** The effects that make a barrel's bang; set once they exist. */
  setExplosions(e: Explosions): void { this.explosions = e; }

  /** Pick a random intact firing bay with centre x in [minX, maxX]. */
  /**
   * Pick a firing bay for an enemy to appear in. Only bays whose floor is intact all the way to the ledge qualify,
   * and (if `canFire` is given) only where a soldier standing at the ledge has a line of fire to the target.
   * Bays take turns: the one that has gone longest without a spawn goes first, so spawns spread out.
   */
  takeLedge(minX: number, maxX: number, canFire?: (from: THREE.Vector3) => boolean): LedgeSpawn | null {
    const candidates: { b: Building; l: Ledge }[] = [];
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) for (const l of b.ledgeList(minX, maxX)) candidates.push({ b, l });
    }
    // longest unused first, ties shuffled
    candidates.sort((a, b) => a.l.taken - b.l.taken || Math.random() - 0.5);
    for (const { b, l } of candidates) {
      const spawn = b.ledgeSpawn(l);
      if (!spawn) continue;
      if (canFire) {
        const front = this.fireSpot.set(spawn.pos.x, spawn.pos.y + SHOOTER_CHEST, spawn.ledgeZ);
        if (!canFire(front)) continue;
      }
      l.taken = ++this.takeSeq;
      return spawn;
    }
    return null;
  }

  /** Nearest wall hit along a ray (distance t), writing the point to out. */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    let best = Infinity;
    const p = new THREE.Vector3();
    this.lastBuilding = null;
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        const t = b.raycast(ray, p);
        if (t < best) { best = t; out.copy(p); this.lastBuilding = b; }
      }
    }
    return best;
  }

  private barrelContext(): BarrelContext {
    return { coals: this.coals, fx: this.fx ?? { sparks: () => {} }, dust: this.dust, solid: (x, y, z) => this.solidAt(x, y, z) };
  }

  /** build the chunks around `center` and drop the ones that fell out of range */
  private syncChunks(center: number): void {
    const inRange = (i: number) => i >= center - 1 && i <= center + 1;
    for (let i = center - 1; i <= center + 1; i++) {
      if (!this.chunks.has(i)) {
        const c = this.buildChunk(i);
        this.chunks.set(i, c);
        this.group.add(c.group);
      }
    }
    for (const [i, c] of this.chunks) {
      if (!inRange(i)) {
        this.group.remove(c.group);
        if (this.door) c.group.remove(this.door.group);                  // the doors outlast their chunk
        c.buildings.forEach((b) => b.dispose());
        c.props.forEach((b) => b.dispose());
        c.walls.forEach((x) => x.dispose());
        c.group.traverse((o) => {
          if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) {
            o.geometry.dispose();
            const m = o.material as THREE.Material;
            if (!m.userData.shared) m.dispose();
          }
        });
        this.chunks.delete(i);
      }
    }
  }

  update(cameraX: number, dt = 1 / 60): void {
    const center = Math.floor(cameraX / this.chunkSize);
    if (center !== this.centerChunk) {
      this.centerChunk = center;
      this.syncChunks(center);
    }
    // pre-existing wreckage appears once the camera is close enough for it to settle in time
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        if (b.hostsEnemies && Math.abs(cameraX - (b.x0 + b.width / 2)) < 45) b.spawnRuinRubble();
        b.step(dt);                                   // anything coming down
      }
    }
    // fires: animate the ones near the camera, give the closest few real light
    const live: FireBarrel[] = [];
    for (const c of this.chunks.values()) {
      for (const f of c.barrels) {
        const near = Math.abs(f.top.x - cameraX) < 40;
        f.group.visible = near && !f.gone;
        if (near) { f.update(dt, this.dust, this.barrelContext()); live.push(f); }
      }
    }
    // explosive barrels: the ones near the camera tick; whoever goes off blows up
    for (const c of this.chunks.values()) {
      for (const e of c.explosives) {
        if (e.gone) continue;
        const near = Math.abs(e.group.position.x - cameraX) < 40;
        e.group.visible = near;
        if (!near && !e.lit) continue;
        const event = e.step(dt, (x, y, z) => this.surfaceTop(x, z, y));
        if (event === 'boom') this.explosions?.barrelBlast(e.blastPoint);
        else if (event === 'pop') this.explosions?.ammoPop(e.blastPoint);
      }
    }
    this.craters.update(dt);
    this.wreck.update(dt);
    this.door?.update(dt);
    this.fireLights.update(dt, live, cameraX);
    this.coals.update(dt);
    // the city's ground plane follows the camera, so scroll its texture the other way to keep it fixed in the world (the desert's ground
    // is cut into chunks that stand in the world, so its texture is already fixed: scrolling it would slide the sand over the dunes)
    if (this.style !== 'desert') for (const t of this.groundMaps) t.offset.x = cameraX / GROUND_TILE;
    for (const o of this.group.children) if (o instanceof THREE.Mesh) o.position.x = cameraX;
  }
}
