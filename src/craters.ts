import * as THREE from 'three';
import { GROUND_TILE } from './ground';
import { mulberry32 } from './util';
import { CRATER } from './config';

/** the ground plane's size and place (world.ts): the crater meshes must map the ground textures exactly as it does */
const GROUND_W = 4000, GROUND_D = 260, GROUND_Z = -80;
/** most real craters at once (the ground shader cuts one hole for each) */
const MAX_DENTS = 4;
const DENT_RINGS_INNER = 26, DENT_RINGS_OUTER = 6, DENT_SEGMENTS = 72;
/** the dent's profile in bowl radii: the lip runs from the bowl's rim to here, the scorched ring to there */
const LIP_END = 1.35, SCORCH_END = 2.1;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height of a crater's ground at `u` bowl radii from its middle (negative in the bowl, positive on the lip). */
function profile(u: number, depth: number, lip: number): number {
  if (u < 1) { const c = Math.cos((Math.PI / 2) * u); return -depth * c * c; }
  if (u < LIP_END) return lip * Math.sin((Math.PI * (u - 1)) / (LIP_END - 1));
  return 0;
}

interface Dent { x: number; z: number; radius: number; depth: number; lip: number; age: number; mesh: THREE.Mesh }

/** Scorch decal textures: a soot-black blast mark with a rim of fresh dirt, and the matching relief. */
function scorchTextures(): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const N = 256, rnd = mulberry32(21);
  const h = new Float32Array(N * N);
  const img = document.createElement('canvas');
  img.width = img.height = N;
  const g = img.getContext('2d')!;
  const data = g.createImageData(N, N);
  const lobes = Array.from({ length: 9 }, () => ({ a: rnd() * Math.PI * 2, w: 0.1 + rnd() * 0.3, k: 0.7 + rnd() * 0.3 }));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = (x + 0.5) / N * 2 - 1, ny = (y + 0.5) / N * 2 - 1;
      const r = Math.hypot(nx, ny), a = Math.atan2(ny, nx);
      // ragged edge: rays of soot thrown out further in some directions
      let reach = 0.78;
      for (const l of lobes) reach += l.k * 0.2 * Math.exp(-((Math.atan2(Math.sin(a - l.a), Math.cos(a - l.a)) / l.w) ** 2));
      const edge = smoothstep(reach, reach * 0.45, r);
      const grain = 0.82 + 0.18 * rnd();
      const core = smoothstep(0.55, 0.0, r);
      const i = (y * N + x) * 4;
      data.data[i] = (12 + 38 * (1 - core)) * grain;
      data.data[i + 1] = (10 + 32 * (1 - core)) * grain;
      data.data[i + 2] = (9 + 26 * (1 - core)) * grain;
      data.data[i + 3] = 255 * edge * (0.75 + 0.25 * core);
      // relief: a shallow bowl with a lip and some grit
      const u = r / 0.55;
      h[y * N + x] = u < 1 ? -0.5 * (1 - u * u) : 0.05 * Math.exp(-(((u - 1.1) / 0.18) ** 2)) + 0.012 * (rnd() - 0.5) * (r < 0.9 ? 1 : 0);
    }
  }
  g.putImageData(data, 0, 0);
  const nc = document.createElement('canvas');
  nc.width = nc.height = N;
  const ng = nc.getContext('2d')!;
  const nd = ng.createImageData(N, N);
  const wrap = (v: number): number => Math.min(N - 1, Math.max(0, v));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dhdu = (h[y * N + wrap(x + 1)] - h[y * N + wrap(x - 1)]) * 0.5;
      const dhdv = (h[wrap(y - 1) * N + x] - h[wrap(y + 1) * N + x]) * 0.5;
      let nx = -dhdu * 22, ny = -dhdv * 22, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * N + x) * 4;
      nd.data[o] = (nx * 0.5 + 0.5) * 255; nd.data[o + 1] = (ny * 0.5 + 0.5) * 255; nd.data[o + 2] = (nz * 0.5 + 0.5) * 255; nd.data[o + 3] = 255;
    }
  }
  ng.putImageData(nd, 0, 0);
  const map = new THREE.CanvasTexture(img);
  map.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.CanvasTexture(nc);
  normal.colorSpace = THREE.NoColorSpace;
  return { map, normal };
}

/**
 * Marks on the ground. Every blast at ground level leaves a scorch: a flat decal, one instanced draw, the oldest
 * overwritten. `dent` digs a real crater: a disc of ground, displaced into a bowl with a raised lip, takes the
 * place of a round hole cut in the ground plane, and `heightAt` tells everything that stands or falls on the
 * ground how deep it is there.
 */
export class Craters {
  private readonly scorch: THREE.InstancedMesh;
  private scorchCount = 0;
  private scorchNext = 0;
  private readonly dents: Dent[] = [];
  private readonly holes = Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 0, -1, 0));
  private readonly dentMaterial: THREE.MeshStandardMaterial;
  private readonly dummy = new THREE.Object3D();

  /** @param ground the ground plane's textures: the dents are made of the same dirt, so they join it seamlessly */
  constructor(private readonly parent: THREE.Object3D, ground: { albedo: THREE.Texture; normal: THREE.Texture }) {
    const tex = scorchTextures();
    this.scorch = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        map: tex.map, normalMap: tex.normal, normalScale: new THREE.Vector2(1.4, 1.4), transparent: true, depthWrite: false,
        roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
      CRATER.maxScorch,
    );
    this.scorch.count = 0;
    this.scorch.frustumCulled = false;
    this.scorch.receiveShadow = true;
    this.scorch.renderOrder = 1;
    parent.add(this.scorch);

    // the dent's own copies of the ground textures, repeating once per world tile (its UVs are world coordinates)
    const own = (t: THREE.Texture): THREE.Texture => {
      const c = t.clone();
      c.repeat.set(1, 1);
      c.offset.set(0, 0);
      c.needsUpdate = true;
      return c;
    };
    this.dentMaterial = new THREE.MeshStandardMaterial({
      map: own(ground.albedo), normalMap: own(ground.normal), normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.95, vertexColors: true,
    });
  }

  /** Make the ground material cut the dents' holes (the plane has to be gone where the bowl is). */
  cutHoles(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHoles = { value: this.holes };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCraterPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCraterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vCraterPos;\nuniform vec4 uHoles[${MAX_DENTS}];`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          for (int i = 0; i < ${MAX_DENTS}; i++) {
            if (uHoles[i].z > 0.0 && distance(vCraterPos.xz, uHoles[i].xy) < uHoles[i].z) discard;
          }`);
    };
  }

  /** A scorch mark `diameter` across, flat on the ground at (x, z). */
  stamp(x: number, z: number, diameter: number): void {
    const { dummy, scorch } = this;
    dummy.position.set(x, 0.02, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.set(diameter, 1, diameter);
    dummy.updateMatrix();
    scorch.setMatrixAt(this.scorchNext, dummy.matrix);
    this.scorchNext = (this.scorchNext + 1) % CRATER.maxScorch;
    this.scorchCount = Math.min(CRATER.maxScorch, this.scorchCount + 1);
    scorch.count = this.scorchCount;
    scorch.instanceMatrix.needsUpdate = true;
  }

  /** Dig a real crater at (x, z): a bowl `radius` across (to its rim), `depth` deep, with a lip, and scorched ground round it. */
  dent(x: number, z: number, radius: number, depth: number, lip: number): void {
    if (this.dents.length >= MAX_DENTS) return;
    const outer = radius * SCORCH_END;
    // rings dense across the bowl and its lip, a few more out to the edge of the scorch
    const radii: number[] = [];
    for (let i = 0; i <= DENT_RINGS_INNER; i++) radii.push((i / DENT_RINGS_INNER) * LIP_END * radius);
    for (let i = 1; i <= DENT_RINGS_OUTER; i++) radii.push((LIP_END + (i / DENT_RINGS_OUTER) * (SCORCH_END - LIP_END)) * radius);
    const rows = radii.length, cols = DENT_SEGMENTS + 1;
    const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2), col = new Float32Array(rows * cols * 3);
    for (let i = 0; i < rows; i++) {
      const r = radii[i], u = r / radius;
      // soot-black in the middle, fading to the ground's own colour at the edge of the scorch
      const shade = 0.16 + 0.84 * smoothstep(0, SCORCH_END, u) ** 0.8;
      for (let j = 0; j < cols; j++) {
        const a = (j / DENT_SEGMENTS) * Math.PI * 2;
        const lx = Math.cos(a) * r, lz = Math.sin(a) * r, k = i * cols + j;
        pos.set([lx, profile(u, depth, lip) + 0.003, lz], k * 3);
        // the ground plane's own mapping of its textures, so the dirt carries on across the join
        uv.set([(x + lx) / GROUND_TILE + GROUND_W / 2 / GROUND_TILE, -(z + lz - GROUND_Z) / GROUND_TILE + GROUND_D / 2 / GROUND_TILE], k * 2);
        col.set([shade, shade, shade * 0.97], k * 3);
      }
    }
    const index: number[] = [];
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
        index.push(a, b, c, c, b, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.dentMaterial);
    mesh.position.set(x, 0, z);
    mesh.scale.y = 0;           // it digs itself out: see update()
    mesh.receiveShadow = true;
    this.parent.add(mesh);
    const hole = this.holes[this.dents.length];
    hole.set(x, z, outer * 0.985, 0);
    this.dents.push({ x, z, radius, depth, lip, age: 0, mesh });
  }

  update(dt: number): void {
    for (const d of this.dents) {
      if (d.age >= CRATER.digTime) continue;
      d.age += dt;
      const t = Math.min(1, d.age / CRATER.digTime);
      d.mesh.scale.y = 1 - (1 - t) * (1 - t);
    }
  }

  /** How far the ground is above (+) or below (-) the flat, at (x, z). 0 away from every dent. */
  heightAt(x: number, z: number): number {
    for (const d of this.dents) {
      const dx = x - d.x, dz = z - d.z;
      if (Math.abs(dx) > d.radius * LIP_END || Math.abs(dz) > d.radius * LIP_END) continue;
      const u = Math.hypot(dx, dz) / d.radius;
      if (u < LIP_END) return profile(u, d.depth, d.lip) * d.mesh.scale.y;
    }
    return 0;
  }

  clear(): void {
    this.scorchCount = this.scorchNext = 0;
    this.scorch.count = 0;
    for (const d of this.dents) { this.parent.remove(d.mesh); d.mesh.geometry.dispose(); }
    this.dents.length = 0;
    for (const h of this.holes) h.set(0, 0, -1, 0);
  }
}
