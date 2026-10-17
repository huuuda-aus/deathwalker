import * as THREE from 'three';
import { mulberry32 } from './util';

/** World units covered by one repeat of the ground texture. */
export const GROUND_TILE = 10;
const SIZE = 1024;

/** Tileable value-noise fbm sampled on the pixel grid (lattice wraps, so the texture repeats cleanly). */
function tileableFbm(size: number, periods: number[], rnd: () => number): Float32Array {
  const out = new Float32Array(size * size);
  const total = periods.reduce((a, _p, i) => a + 1 / 2 ** i, 0);
  periods.forEach((period, o) => {
    const lat = new Float32Array(period * period);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const amp = 1 / 2 ** o;
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * period, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * period, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = lat[(y0 % period) * period + (x0 % period)], b = lat[(y0 % period) * period + ((x0 + 1) % period)];
        const c = lat[((y0 + 1) % period) * period + (x0 % period)], d = lat[((y0 + 1) % period) * period + ((x0 + 1) % period)];
        out[y * size + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy) / total;
      }
    }
  });
  return out;
}

interface Textures { albedo: THREE.CanvasTexture; normal: THREE.CanvasTexture }

/**
 * Procedural war-zone ground: packed dirt, broken concrete slabs and bricks, pebbles, sticks and rebar,
 * cracks, shallow craters and soot. The same height field produces both the albedo and the normal map,
 * so the relief and the colour always agree.
 */
export function makeGroundTextures(seed = 7): Textures {
  const rnd = mulberry32(seed);
  const N = SIZE;
  const wrap = (v: number) => ((v % N) + N) % N;

  // ---- height field (0..1) and a per-pixel material tag for colouring
  const h = tileableFbm(N, [3, 6, 12, 24, 48], rnd);
  for (let i = 0; i < h.length; i++) h[i] = 0.3 + 0.28 * h[i];
  const kind = new Uint8Array(N * N);           // 0 dirt, 1 concrete, 2 brick, 3 stone/metal
  const shade = new Float32Array(N * N).fill(1); // per-piece brightness

  const bump = (cx: number, cy: number, r: number, amp: number, k: number, sh: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = (dx * dx + dy * dy) / (r * r);
        if (d2 >= 1) continue;
        const i = wrap(cy + dy) * N + wrap(cx + dx);
        h[i] += amp * (1 - d2) ** 0.7;
        if (d2 < 0.6) { kind[i] = k; shade[i] = sh; }
      }
    }
  };

  // craters first so debris lands in and around them
  for (let n = 0; n < 14; n++) {
    const cx = (rnd() * N) | 0, cy = (rnd() * N) | 0, r = 26 + ((rnd() * 40) | 0);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d2 = (dx * dx + dy * dy) / (r * r);
      if (d2 >= 1) continue;
      const i = wrap(cy + dy) * N + wrap(cx + dx);
      h[i] -= 0.16 * (1 - d2) - (d2 > 0.7 ? -0.05 * (d2 - 0.7) : 0); // bowl with a faint raised lip
    }
  }

  // pebbles and gravel
  for (let n = 0; n < 2600; n++) {
    const r = 1 + ((rnd() * 4) | 0);
    bump((rnd() * N) | 0, (rnd() * N) | 0, r, 0.08 + rnd() * 0.22, rnd() < 0.7 ? 3 : 1, 0.7 + rnd() * 0.6);
  }

  // broken slabs and bricks: convex polygons with bevelled edges and a tilt
  const slabs = 95;
  for (let n = 0; n < slabs; n++) {
    const cx = rnd() * N, cy = rnd() * N, size = 12 + rnd() * 50;
    const sides = 4 + ((rnd() * 4) | 0);
    const rot = rnd() * Math.PI * 2;
    const pts: [number, number][] = [];
    for (let k = 0; k < sides; k++) {
      const a = rot + (k / sides) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const rr = size * (0.6 + rnd() * 0.5);
      pts.push([Math.cos(a) * rr * (0.7 + rnd() * 0.6), Math.sin(a) * rr]);
    }
    const top = 0.22 + rnd() * 0.4;
    const tiltX = (rnd() - 0.5) * 0.012, tiltY = (rnd() - 0.5) * 0.012;
    const k = rnd() < 0.28 ? 2 : 1; // some are brick
    const sh = 0.75 + rnd() * 0.6;
    const R = Math.ceil(size * 1.3);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        // inside test + distance to the nearest edge (for the bevel)
        let inside = true, minD = 1e9;
        for (let e = 0; e < sides; e++) {
          const [x1, y1] = pts[e], [x2, y2] = pts[(e + 1) % sides];
          const ex = x2 - x1, ey = y2 - y1, len = Math.hypot(ex, ey) || 1;
          const cross = (ex * (dy - y1) - ey * (dx - x1)) / len; // signed distance to this edge line
          if (cross < 0) { inside = false; break; }
          if (cross < minD) minD = cross;
        }
        if (!inside) continue;
        const i = wrap(Math.round(cy) + dy) * N + wrap(Math.round(cx) + dx);
        const bevel = Math.min(1, minD / 3.5);
        h[i] = Math.max(h[i], 0.3 + top * bevel * bevel * (3 - 2 * bevel) + dx * tiltX + dy * tiltY + (rnd() - 0.5) * 0.012);
        kind[i] = k;
        shade[i] = sh * (0.9 + 0.2 * (minD > 3.5 ? 1 : minD / 3.5));
      }
    }
  }

  // sticks, rebar and planks: thin rotated ridges
  for (let n = 0; n < 70; n++) {
    const cx = rnd() * N, cy = rnd() * N, len = 30 + rnd() * 90, wid = 1.5 + rnd() * 3, a = rnd() * Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a), metal = rnd() < 0.35;
    for (let t = -len / 2; t <= len / 2; t += 0.7) {
      for (let w = -wid; w <= wid; w += 0.7) {
        const x = Math.round(cx + ca * t - sa * w), y = Math.round(cy + sa * t + ca * w);
        const i = wrap(y) * N + wrap(x);
        h[i] = Math.max(h[i], 0.42 + 0.16 * (1 - Math.abs(w) / wid) ** 0.6);
        kind[i] = metal ? 3 : 2;
        shade[i] = metal ? 0.55 : 0.8;
      }
    }
  }

  // cracks: random walks that cut the surface
  for (let n = 0; n < 34; n++) {
    let x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2;
    const steps = 80 + ((rnd() * 140) | 0);
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 0.7;
      x += Math.cos(a) * 2; y += Math.sin(a) * 2;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = wrap(Math.round(y) + dy) * N + wrap(Math.round(x) + dx);
        h[i] = Math.max(0.02, h[i] - (dx === 0 && dy === 0 ? 0.16 : 0.07));
        shade[i] *= 0.8;
      }
    }
  }

  // ---- soot / ash patches darken the colour only
  const soot = tileableFbm(N, [4, 8, 16], rnd);

  // ---- albedo (dark: this is a night scene) with a cold tint
  const albedo = document.createElement('canvas');
  albedo.width = albedo.height = N;
  const ag = albedo.getContext('2d')!;
  const img = ag.createImageData(N, N);
  const dirtA = [30, 26, 24], dirtB = [46, 40, 36];
  const palette: Record<number, number[]> = { 1: [58, 58, 60], 2: [70, 38, 32], 3: [46, 47, 50] };
  for (let i = 0; i < N * N; i++) {
    const hv = h[i];
    let r: number, g: number, b: number;
    if (kind[i] === 0) {
      const t = Math.min(1, Math.max(0, (hv - 0.2) / 0.5));
      r = dirtA[0] + (dirtB[0] - dirtA[0]) * t; g = dirtA[1] + (dirtB[1] - dirtA[1]) * t; b = dirtA[2] + (dirtB[2] - dirtA[2]) * t;
    } else {
      const c = palette[kind[i]];
      r = c[0]; g = c[1]; b = c[2];
    }
    const sootK = 0.55 + 0.65 * Math.min(1, Math.max(0, (soot[i] - 0.25) * 2.2)); // dark where the soot is thick
    const k = shade[i] * sootK * (0.9 + 0.2 * (rnd() - 0.5) * 2 * 0.5);
    img.data[i * 4] = Math.min(255, r * k * 0.96);
    img.data[i * 4 + 1] = Math.min(255, g * k * 0.99);
    img.data[i * 4 + 2] = Math.min(255, b * k * 1.05);
    img.data[i * 4 + 3] = 255;
  }
  ag.putImageData(img, 0, 0);

  // ---- normal map from the height field (OpenGL convention: +Y up in texture space)
  const normal = document.createElement('canvas');
  normal.width = normal.height = N;
  const ng = normal.getContext('2d')!;
  const nimg = ng.createImageData(N, N);
  const strength = 14;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dhdu = (h[y * N + wrap(x + 1)] - h[y * N + wrap(x - 1)]) * 0.5;
      const dhdv = (h[wrap(y - 1) * N + x] - h[wrap(y + 1) * N + x]) * 0.5; // canvas rows run top-down, v runs up
      let nx = -dhdu * strength, ny = -dhdv * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * N + x) * 4;
      nimg.data[o] = (nx * 0.5 + 0.5) * 255;
      nimg.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      nimg.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
    }
  }
  ng.putImageData(nimg, 0, 0);

  const aTex = new THREE.CanvasTexture(albedo);
  aTex.colorSpace = THREE.SRGBColorSpace;
  const nTex = new THREE.CanvasTexture(normal);
  nTex.colorSpace = THREE.NoColorSpace;
  for (const t of [aTex, nTex]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
  }
  return { albedo: aTex, normal: nTex };
}
