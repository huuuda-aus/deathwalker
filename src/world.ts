import * as THREE from 'three';
import { Building, type DamageResult, type Ledge } from './building';
import type { Debris, Dust } from './debris';

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
  private chunks = new Map<number, { group: THREE.Group; buildings: Building[]; props: Building[] }>();
  /** the building hit by the last raycast() */
  lastBuilding: Building | null = null;

  constructor(scene: THREE.Scene, private debris: Debris, private dust: Dust) {
    scene.fog = new THREE.Fog(FOG_COLOR, 35, 140);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 260),
      new THREE.MeshStandardMaterial({ color: 0x121a2e, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -80;
    ground.receiveShadow = true;
    this.group.add(ground);

    scene.add(this.group);
  }

  private buildChunk(index: number): { group: THREE.Group; buildings: Building[]; props: Building[] } {
    const rng = mulberry32(index * 7919 + 13);
    const g = new THREE.Group();
    const buildings: Building[] = [];
    const props: Building[] = [];
    const x0 = index * this.chunkSize;

    // destructible rows: the front row hosts enemies, the second row is scenery you can still wreck
    const row = (z0: number, tint: number, offset: number, gapMin: number, gapVar: number, hosts: boolean): void => {
      let x = x0 + offset;
      while (x < x0 + this.chunkSize) {
        const b = new Building(x, z0, tint, rng, this.debris, this.dust);
        b.hostsEnemies = hosts;
        g.add(b.object);
        buildings.push(b);
        x += b.width + gapMin + rng() * gapVar;
      }
    };
    row(-5, 0x82848c, 0, 2.5, 4, true);
    row(-14, 0x78808e, rng() * 6, 3, 7, false);

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
    return { group: g, buildings, props };
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

  update(cameraX: number): void {
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
    this.group.children.forEach((o) => { if (o instanceof THREE.Mesh) o.position.x = cameraX; });
  }
}
