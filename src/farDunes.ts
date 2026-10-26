import * as THREE from 'three';

/**
 * The dune sea behind the street: broad, sinuous ridges in the manner of the Gobi's Khongoryn Els, one rank behind another
 * out to the haze, each taller and wider than the one before. Every ridge is a lopsided wave: a steep slip face looking toward
 * the camera (it falls into shade when the sun is low and off to the side), a sharp crest, and a long gentle back sloping
 * away. The crest lines wander and merge, and each ridge has its own height. A real lit surface (not a painted strip), so the
 * low sun models it: bright crests, dark slip faces, soft shadow in the hollows. A few hollows carry a patch of scrub.
 *
 * It begins at height 0 where the playable dunes (terrain.ts) fade out, so the two join without a seam.
 */

/** where it begins and ends, in z (it runs away from the camera) */
const Z0 = -26, Z1 = -235;
/** ridges per unit of log-distance: equal steps of log(z) are equal on the screen, so every rank looks about as busy */
const RIDGES = 3.6;
/** height of a ridge at the start and, growing with distance, at the far end (world units) */
const H_NEAR = 2.2, H_FAR = 34;
/** where on a ridge (0 = foot of the slip face, 1 = foot of the back) the crest stands */
const CREST = 0.28;
/** vertex spacing along x, and the rows from the start to the end (spaced evenly in log-distance) */
const STEP_X = 1, ROWS = 140;

const S_END = Math.log(-Z1 / -Z0);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (k: number): number => { const s = Math.sin(k * 127.1 + 3.1) * 43758.5453; return s - Math.floor(s); };

/** the phase of the ridges at (x, z): its integer part says which ridge, its fraction where on it */
function phase(x: number, s: number): number {
  const warp = 0.55 * Math.sin(x * 0.011 + s * 1.7 + 0.8) + 0.3 * Math.sin(x * 0.027 - s * 2.3 + 2.0) + 0.12 * Math.sin(x * 0.061 + s * 0.6);
  return RIDGES * s + 1.6 * warp;
}

/** one ridge's cross-section: the steep slip face up to the crest, then the long gentle back down; the crest sharp but a hair rounded, so it does not shimmer */
function profile(u: number): number {
  const rise = ((t: number) => t + 0.35 * (t * t * (3 - 2 * t) - t))(Math.min(1, u / CREST)) + Math.max(0, u / CREST - 1) * 3;   // steep, eased a little at the foot, and carrying on up past the crest
  const back = (u - CREST) / (1 - CREST);
  const fall = back <= 0 ? 1 - back * 3 : 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, back));
  const k = 0.07;                                                         // smooth minimum of the two: the crest where they cross
  const h = Math.max(k - Math.abs(rise - fall), 0) / k;
  return Math.min(rise, fall) - h * h * k * 0.25;
}

/** the height of the dune sea at (x, z) */
export function farDuneHeight(x: number, z: number): number {
  if (z > Z0) return 0;
  const s = Math.log(z / Z0);
  const p = phase(x, s);
  const k = Math.floor(p), u = p - k;
  const along = 0.75 + 0.25 * Math.sin(x * 0.013 + 7 * hash(k));              // a crest rises and sags along its length
  const grow = Math.pow(Math.min(1, Math.max(0, (Z0 - z) / (Z0 - Z1))), 1.3);
  const amp = (H_NEAR + (H_FAR - H_NEAR) * grow) * (0.55 + 0.9 * hash(k)) * along;
  return amp * profile(u) * smooth(Z0, Z0 - 14, z) * (1 - smooth(Z1 + 30, Z1, z));
}

const SAND_LIGHT = new THREE.Color(0xe6bd7e);
const SAND_DEEP = new THREE.Color(0xc4864a);
const SCRUB = new THREE.Color(0x77814b);
const tmp = new THREE.Color();

/** one chunk of the dune sea: x from x0 to x0 + width */
export function farDunes(x0: number, width: number, material: THREE.Material): THREE.Mesh {
  const cols = Math.round(width / STEP_X);
  const pos = new Float32Array((cols + 1) * (ROWS + 1) * 3), nor = new Float32Array(pos.length), col = new Float32Array(pos.length);
  const idx: number[] = [];
  const e = 0.6;
  for (let j = 0; j <= ROWS; j++) {
    const z = Z0 * Math.exp((S_END * j) / ROWS);
    const s = Math.log(z / Z0);
    for (let i = 0; i <= cols; i++) {
      const x = x0 + (width * i) / cols;
      const h = farDuneHeight(x, z), v = (j * (cols + 1) + i) * 3;
      pos.set([x, h + 0.02, z], v);
      // the true surface normal, so the chunks join without a crease
      const dx = (farDuneHeight(x + e, z) - farDuneHeight(x - e, z)) / (2 * e);
      const dz = (farDuneHeight(x, z + e) - farDuneHeight(x, z - e)) / (2 * e);
      const len = Math.hypot(dx, 1, dz);
      nor.set([-dx / len, 1 / len, -dz / len], v);
      // colour: golden crests, deeper, redder hollows, each ridge a little different, and scrub in a few hollows
      const p = phase(x, s), k = Math.floor(p), u = p - k;
      tmp.copy(SAND_DEEP).lerp(SAND_LIGHT, 0.45 + 0.55 * profile(u)).lerp(SAND_DEEP, 0.4 * hash(k + 1));
      // the slip face looks toward us, away from the low sun: darker toward its foot (a sky-lit surface would not show the shade the sun leaves)
      if (u < CREST) tmp.multiplyScalar(0.5 + 0.5 * smooth(0, CREST, u));
      if (hash(k + 5) > 0.8) {
        const patch = smooth(0.55, 0.8, 0.5 + 0.5 * Math.sin(x * 0.02 + k * 3.1)) * (1 - smooth(0, 0.22, Math.min(u, 1 - u)));
        tmp.lerp(SCRUB, 0.75 * patch);
      }
      col.set([tmp.r, tmp.g, tmp.b], v);
    }
  }
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}
