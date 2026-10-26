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

/** height of a soldier's gun above the floor he stands on (world units), for line-of-fire checks from a bay */
const SHOOTER_CHEST = 0.25;

/** Distance haze: the ground and near rows fade to near-black, not green. */
export const FOG_COLOR = 0x030d0b;

const FAR_ROWS: [z: number, scale: number, color: number, dense: boolean][] = [
  [-32, 1.8, 0x010309, false],
  [-50, 2.2, 0x03080e, true],
  [-75, 2.8, 0x02060b, true],
  [-105, 3.6, 0x010407, true],
  [-140, 4.5, 0x010204, true],
];

/** the desert's dune ranks, nearest first: depth (z), height, wavelength and a phase */
const DUNE_ROWS: [z: number, amp: number, wave: number, phase: number][] = [
  [-24, 1.5, 31, 0.4],
  [-40, 2.8, 46, 1.9],
  [-62, 4.4, 64, 3.1],
  [-92, 6.5, 88, 0.8],
  [-135, 9, 120, 2.4],
];
const DUNE_TOP = new THREE.Color(0xe8c48a);
const DUNE_BASE = new THREE.Color(0x8a6238);

/** a dune's height at x: lopsided crests (a long gentle slope and a steeper far side), never the same twice, continuous across chunks */
const duneHeight = (x: number, amp: number, wave: number, phase: number): number => {
  const a = (x / wave) * Math.PI * 2 + phase;
  return amp * (0.55 + 0.3 * Math.sin(a + 0.5 * Math.sin(a)) + 0.15 * Math.sin(a * 2.3 + phase * 3));
};

/** one rank of dunes across a chunk: a ribbon with a light crest and a darker foot */
function duneRidge(x0: number, width: number, z: number, amp: number, wave: number, phase: number): THREE.Mesh {
  const N = 80;
  const pos = new Float32Array((N + 1) * 6), col = new Float32Array((N + 1) * 6);
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const x = x0 + (width * i) / N;
    pos.set([x, duneHeight(x, amp, wave, phase), z, x, -1, z], i * 6);
    col.set([DUNE_TOP.r, DUNE_TOP.g, DUNE_TOP.b, DUNE_BASE.r, DUNE_BASE.g, DUNE_BASE.b], i * 6);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  return mesh;
}

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
  private chunks = new Map<number, { group: THREE.Group; buildings: Building[]; props: Building[]; barrels: FireBarrel[]; explosives: ExplosiveBarrel[]; puddles: Puddle[] }>();
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

  /** @param style what the world is made of: the ruined city, or open desert (no buildings: far dunes on the horizon) */
  constructor(scene: THREE.Scene, private debris: Debris, private dust: Dust, private readonly style: WorldStyle = 'city') {
    scene.fog = new THREE.Fog(FOG_COLOR, 28, 62);

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
    this.group.add(ground);
    this.craters = new Craters(scene, tex);     // not in `group`: its meshes follow the camera
    this.craters.cutHoles(groundMaterial);

    this.fireLights = new FireLights(scene, 3);
    this.coals = new Coals(scene);
    this.coals.surface = (x, z, y) => this.surfaceTop(x, z, y);
    this.coals.solid = (x, y, z) => this.solidAt(x, y, z);
    scene.add(this.group);
  }

  /** what the ground colour is multiplied by: a bright scene lifts the dark texture */
  setGroundTint(c: THREE.Color): void { this.groundMaterial.color.copy(c); }

  /** The desert: no buildings, only ranks of dunes on the horizon, each fainter in the haze than the one before. */
  private buildDesertChunk(index: number): { group: THREE.Group; buildings: Building[]; props: Building[]; barrels: FireBarrel[]; explosives: ExplosiveBarrel[]; puddles: Puddle[] } {
    const g = new THREE.Group();
    const x0 = index * this.chunkSize;
    DUNE_ROWS.forEach(([z, amp, wave, phase], row) => g.add(duneRidge(x0, this.chunkSize, z, amp, wave, phase + row * 1.7)));
    return { group: g, buildings: [], props: [], barrels: [], explosives: [], puddles: [] };
  }

  private buildChunk(index: number): { group: THREE.Group; buildings: Building[]; props: Building[]; barrels: FireBarrel[]; explosives: ExplosiveBarrel[]; puddles: Puddle[] } {
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
        const barrel = new ExplosiveBarrel(pos, street ? null : b);
        g.add(barrel.group);
        explosives.push(barrel);
      }
    }
    return { group: g, buildings, props, barrels, explosives, puddles: water.list };
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
    return best > 0 ? best : this.craters.heightAt(x, z);
  }

  /** the bare ground's height at (x, z): 0, or the crater's floor or lip */
  groundHeight(x: number, z: number): number { return this.craters.heightAt(x, z); }

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
        c.buildings.forEach((b) => b.dispose());
        c.props.forEach((b) => b.dispose());
        c.group.traverse((o) => {
          if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) {
            o.geometry.dispose(); (o.material as THREE.Material).dispose();
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
        if (e.step(dt, (x, y, z) => this.surfaceTop(x, z, y)) === 'boom') this.explosions?.barrelBlast(e.blastPoint);
      }
    }
    this.craters.update(dt);
    this.fireLights.update(dt, live, cameraX);
    this.coals.update(dt);
    // the ground plane follows the camera, so scroll its texture the other way to keep it fixed in the world
    for (const t of this.groundMaps) t.offset.x = cameraX / GROUND_TILE;
    for (const o of this.group.children) if (o instanceof THREE.Mesh) o.position.x = cameraX;
  }
}
