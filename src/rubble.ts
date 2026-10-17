import * as THREE from 'three';

// Rubble shapes and the per-shape instanced batches that draw them.

/** deterministic per-vertex jitter so vertices shared between faces move together */
function jitter(x: number, y: number, z: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return h - Math.floor(h) - 0.5;
}

function jittered(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + amount * 2 * jitter(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100, seed);
    pos.setXYZ(i, x * k, y * (k * 0.5 + 0.5 + amount * jitter(z, x, y, seed + 3)), z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** a right-triangle prism: a broken slab corner */
function wedgeGeometry(): THREE.BufferGeometry {
  const v = [
    // front (z +0.5), back (z -0.5)
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5],
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5],
  ];
  const f = [[0, 1, 2], [3, 5, 4], [0, 3, 4], [0, 4, 1], [0, 2, 5], [0, 5, 3], [1, 4, 5], [1, 5, 2]];
  const pos: number[] = [];
  for (const tri of f) for (const i of tri) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export const SHAPES: THREE.BufferGeometry[] = [
  new THREE.BoxGeometry(1, 1, 1),                                                                 // 0 box
  wedgeGeometry(),                                                                                 // 1 wedge
  jittered(new THREE.TetrahedronGeometry(0.75), 0.22, 1),                                          // 2 shard
  jittered(new THREE.TetrahedronGeometry(0.75), 0.3, 2),                                           // 3 shard
  jittered(new THREE.IcosahedronGeometry(0.58, 0), 0.2, 3),                                        // 4 lump
  jittered(new THREE.IcosahedronGeometry(0.58, 0), 0.28, 4),                                       // 5 lump
];
const SHAPE_WEIGHTS = [0.3, 0.18, 0.1, 0.1, 0.16, 0.16];

export function pickShape(): number {
  let r = Math.random();
  for (let i = 0; i < SHAPE_WEIGHTS.length; i++) { r -= SHAPE_WEIGHTS[i]; if (r < 0) return i; }
  return 0;
}

/** Proportions with a product of ~1: blocks, slabs, beams or chunky pieces, each a little different. */
export function randomDims(): THREE.Vector3 {
  const r = Math.random();
  const base = r < 0.35 ? [1, 1, 1] : r < 0.65 ? [1.7, 0.45, 1.4] : r < 0.85 ? [2.3, 0.6, 0.6] : [1.2, 0.8, 1.1];
  const d = base.map((v) => v * (0.85 + Math.random() * 0.3));
  const k = 1 / Math.cbrt(d[0] * d[1] * d[2]);
  return new THREE.Vector3(d[0] * k, d[1] * k, d[2] * k);
}

/** One InstancedMesh per rubble shape, each with its own slot allocator. */
export class Batch {
  readonly mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private high = 0;
  private dMin = Infinity;
  private dMax = -1;
  private colorDirty = false;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  alloc(): number {
    const i = this.free.length > 0 ? this.free.pop()! : this.high++;
    this.mesh.count = this.high;
    return i;
  }

  release(i: number): void {
    this.free.push(i);
    this.mesh.setMatrixAt(i, this.zero);
    this.mark(i);
  }

  setColor(i: number, c: THREE.Color): void { this.mesh.setColorAt(i, c); this.colorDirty = true; }

  setMatrix(i: number, m: THREE.Matrix4): void { this.mesh.setMatrixAt(i, m); this.mark(i); }

  private mark(i: number): void { if (i < this.dMin) this.dMin = i; if (i > this.dMax) this.dMax = i; }

  /** upload only what changed */
  flush(): void {
    if (this.dMax >= this.dMin) {
      const attr = this.mesh.instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(this.dMin * 16, (this.dMax - this.dMin + 1) * 16);
      attr.needsUpdate = true;
      this.dMin = Infinity; this.dMax = -1;
    }
    if (this.colorDirty && this.mesh.instanceColor) { this.mesh.instanceColor.needsUpdate = true; this.colorDirty = false; }
  }
}
