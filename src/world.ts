import * as THREE from 'three';
import { Building, type DamageResult, type Ledge } from './building';
import type { Debris, Dust } from './debris';
import { GROUND_TILE, makeGroundTextures } from './ground';
import { Coals, FireBarrel, FireLights, type BarrelContext } from './fire';
import type { Fx } from './fx';

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  private chunks = new Map<number, { group: THREE.Group; buildings: Building[]; props: Building[]; barrels: FireBarrel[] }>();
  private fireLights: FireLights;
  /** hot coals from shot barrels */
  readonly coals: Coals;
  /** the barrel hit by the last raycastBarrel() */
  hitBarrel: FireBarrel | null = null;
  private fx: Fx | null = null;
  private groundMaps: THREE.Texture[] = [];
  /** the building hit by the last raycast() */
  lastBuilding: Building | null = null;

  constructor(scene: THREE.Scene, private debris: Debris, private dust: Dust) {
    scene.fog = new THREE.Fog(FOG_COLOR, 28, 62);

    // textured ground: dirt, rubble and debris, with a normal map from the same height field
    const tex = makeGroundTextures();
    const GW = 4000, GD = 260;
    for (const t of [tex.albedo, tex.normal]) {
      t.repeat.set(GW / GROUND_TILE, GD / GROUND_TILE);
      t.anisotropy = 8;
    }
    this.groundMaps = [tex.albedo, tex.normal];
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GW, GD),
      new THREE.MeshStandardMaterial({ map: tex.albedo, normalMap: tex.normal, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -80;
    ground.receiveShadow = true;
    this.group.add(ground);

    this.fireLights = new FireLights(scene, 3);
    this.coals = new Coals(scene);
    this.coals.surface = (x, z, y) => this.surfaceTop(x, z, y);
    this.coals.solid = (x, y, z) => this.solidAt(x, y, z);
    scene.add(this.group);
  }

  private buildChunk(index: number): { group: THREE.Group; buildings: Building[]; props: Building[]; barrels: FireBarrel[] } {
    const rng = mulberry32(index * 7919 + 13);
    const g = new THREE.Group();
    const buildings: Building[] = [];
    const props: Building[] = [];
    const barrels: FireBarrel[] = [];
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
        const b = new Building(0, 0, 0x000000, rng, this.debris, this.dust);
        b.asSilhouette(color);
        b.object.scale.setScalar(scale);
        b.object.position.set(x, 0, z + (rng() - 0.5) * 4);
        g.add(b.object);
        props.push(b);
        x += b.width * scale * (dense ? 0.45 + 0.4 * rng() : 1 + 0.3 * rng()) + (dense ? 0 : 2.5);
      }
    };
    for (const [z, scale, color, dense] of FAR_ROWS) silhouettes(z, scale, color, dense);
    return { group: g, buildings, props, barrels };
  }

  /** Damage destructible buildings at a point on the gameplay plane. */
  damage(x: number, y: number, radius: number): DamageResult {
    const total = { hit: false, destroyed: 0 };
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        const r = b.damage(x, y, radius);
        total.hit ||= r.hit;
        total.destroyed += r.destroyed;
      }
    }
    return total;
  }

  /** Visit every destructible building whose x-range overlaps [minX, maxX]. */
  forEachBuilding(minX: number, maxX: number, cb: (b: Building) => void): void {
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) if (b.x0 <= maxX && b.x0 + b.width >= minX) cb(b);
    }
  }

  /** Highest solid building surface under (x, z) at or below y; 0 = ground. */
  surfaceTop(x: number, z: number, y: number): number {
    let best = 0;
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        if (x < b.x0 || x > b.x0 + b.width) continue;
        const h = b.solidTop(x, z, y);
        if (h > best) best = h;
      }
    }
    return best;
  }

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

  /** Pick a random intact firing bay with centre x in [minX, maxX]. */
  takeLedge(minX: number, maxX: number): ReturnType<Building['ledgeSpawn']> | null {
    const candidates: { b: Building; l: Ledge }[] = [];
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) for (const l of b.ledgeList(minX, maxX)) candidates.push({ b, l });
    }
    if (candidates.length === 0) return null;
    const pick = candidates[(Math.random() * candidates.length) | 0];
    return pick.b.ledgeSpawn(pick.l);
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

  update(cameraX: number, dt = 1 / 60): void {
    const center = Math.floor(cameraX / this.chunkSize);
    const wanted = new Set([center - 1, center, center + 1]);
    for (const i of wanted) {
      if (!this.chunks.has(i)) {
        const c = this.buildChunk(i);
        this.chunks.set(i, c);
        this.group.add(c.group);
      }
    }
    for (const [i, c] of this.chunks) {
      if (!wanted.has(i)) {
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
    // pre-existing wreckage appears once the camera is close enough for it to settle in time
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        if (b.hostsEnemies && Math.abs(cameraX - (b.x0 + b.width / 2)) < 45) b.spawnRuinRubble();
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
    this.fireLights.update(dt, live, cameraX);
    this.coals.update(dt);
    // the ground plane follows the camera, so scroll its texture the other way to keep it fixed in the world
    for (const t of this.groundMaps) t.offset.x = cameraX / GROUND_TILE;
    this.group.children.forEach((o) => { if (o instanceof THREE.Mesh) o.position.x = cameraX; });
  }
}
