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

function windowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8c8680'; g.fillRect(0, 0, 64, 64);
  for (let y = 4; y < 64; y += 16) {
    for (let x = 4; x < 64; x += 16) {
      g.fillStyle = Math.random() < 0.15 ? '#ffb347' : '#2a2a30';
      g.fillRect(x, y, 8, 10);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  // deep blue night, faint radioactive green glow right at the horizon (~half way down the screen)
  grad.addColorStop(0, '#02040d');
  grad.addColorStop(0.25, '#050d2b');
  grad.addColorStop(0.42, '#0a2448');
  grad.addColorStop(0.5, '#1c8a50');
  grad.addColorStop(0.58, '#0e3a2e');
  grad.addColorStop(1, '#070f16');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const FOG_COLOR = 0x0d4a38;

interface Layer { z: number; minH: number; maxH: number; minW: number; maxW: number; gap: number; tint: number }

const LAYERS: Layer[] = [
  { z: -14, minH: 4, maxH: 10, minW: 5, maxW: 10, gap: 2, tint: 0x4a587c },
  { z: -32, minH: 6, maxH: 14, minW: 8, maxW: 16, gap: 1, tint: 0x3c4a6c },
  { z: -60, minH: 8, maxH: 18, minW: 10, maxW: 22, gap: 0, tint: 0x30405e },
];

/** Procedural parallax city. Buildings are generated in chunks around the camera. */
export class World {
  readonly group = new THREE.Group();
  private chunkSize = 120;
  private chunks = new Map<number, { group: THREE.Group; buildings: Building[] }>();
  private winTex = windowTexture();

  constructor(scene: THREE.Scene, private debris: Debris, private dust: Dust) {
    scene.background = skyTexture();
    scene.fog = new THREE.Fog(FOG_COLOR, 35, 140);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 200),
      new THREE.MeshStandardMaterial({ color: 0x121a2e, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -50;
    ground.receiveShadow = true;
    this.group.add(ground);

    scene.add(this.group);
  }

  private buildChunk(index: number): { group: THREE.Group; buildings: Building[] } {
    const rng = mulberry32(index * 7919 + 13);
    const g = new THREE.Group();
    const buildings: Building[] = [];
    const x0 = index * this.chunkSize;

    // Destructible front row, just behind the gameplay lane.
    let fx = x0;
    while (fx < x0 + this.chunkSize) {
      const b = new Building(fx, -5, 0x82848c, rng, this.debris, this.dust);
      g.add(b.object);
      buildings.push(b);
      fx += b.width + 2.5 + rng() * 4;
    }

    for (const L of LAYERS) {
      let x = x0;
      while (x < x0 + this.chunkSize) {
        const w = L.minW + rng() * (L.maxW - L.minW);
        const h = L.minH + rng() * (L.maxH - L.minH);
        const tex = this.winTex.clone();
        tex.needsUpdate = true;
        tex.repeat.set(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
        const mat = new THREE.MeshStandardMaterial({ color: L.tint, map: tex, roughness: 0.9 });
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.8), mat);
        b.position.set(x + w / 2, h / 2, L.z + (rng() - 0.5) * 2);
        b.castShadow = b.receiveShadow = true;
        // ruined: chop top with tilted slab for gameplay-layer silhouette variety
        if (rng() < 0.4) b.rotation.z = (rng() - 0.5) * 0.06;
        g.add(b);
        x += w + L.gap + rng() * 3;
      }
    }
    return { group: g, buildings };
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
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        const t = b.raycast(ray, p);
        if (t < best) { best = t; out.copy(p); }
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
        if (Math.abs(cameraX - (b.x0 + b.width / 2)) < 45) b.spawnRuinRubble();
      }
    }
    this.group.children.forEach((o) => { if (o instanceof THREE.Mesh) o.position.x = cameraX; });
  }
}
