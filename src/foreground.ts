import { mulberry32 } from './util';
import { SCREEN_W } from './level';

/** the silhouette: plain black, no outline or highlight */
const COLOR = '#000';
/** the layer is drawn this much larger than it is authored (shapes, gaps and tallest points alike) */
const SIZE = 1.5;
/** one strip of the layer: authored in "720p pixels", scaled to the real viewport height */
const STRIP_W = 1400;
const STRIP_H = 112;
/** the layer's tallest points, in 720p pixels */
const PEAK = 100;
/** how much faster than the street it scrolls (it is much nearer the camera) */
const PARALLAX = 2.3;

type Pt = [number, number];

/** Heap of broken ground: a jagged top that falls away at both ends. Returns the heap's height at x. */
function heap(ctx: CanvasRenderingContext2D, rnd: () => number, x0: number, w: number, height: number): (x: number) => number {
  const n = Math.max(5, Math.floor(w / 13));
  const tops: number[] = [];
  const pts: Pt[] = [[x0, STRIP_H]];
  for (let i = 0; i <= n; i++) {
    const edge = Math.pow(Math.sin((Math.PI * i) / n), 0.6);
    const h = 2 + (0.35 + rnd() * 0.65) * height * edge;
    tops.push(h);
    pts.push([x0 + (w * i) / n, STRIP_H - h]);
  }
  pts.push([x0 + w, STRIP_H]);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  return (x) => tops[Math.max(0, Math.min(n, Math.round(((x - x0) / w) * n)))];
}

/** A slab of concrete leaning on the heap. */
function slab(ctx: CanvasRenderingContext2D, rnd: () => number, cx: number, baseY: number, maxTop: number): void {
  const angle = (rnd() < 0.5 ? -1 : 1) * (0.25 + rnd() * 0.9);
  let len = 34 + rnd() * 70;
  const thick = 6 + rnd() * 8;
  // keep the high end under the ceiling
  const rise = (l: number): number => (l * Math.abs(Math.sin(angle))) / 2 + thick;
  while (len > 18 && baseY - rise(len) < maxTop) len -= 6;
  ctx.save();
  ctx.translate(cx, baseY - rise(len) * 0.5);
  ctx.rotate(angle);
  ctx.fillRect(-len / 2, -thick / 2, len, thick);
  // a chipped corner
  ctx.beginPath();
  ctx.moveTo(len / 2, -thick / 2);
  ctx.lineTo(len / 2 + 5 + rnd() * 7, thick / 2 - rnd() * 3);
  ctx.lineTo(len / 2, thick / 2);
  ctx.fill();
  ctx.restore();
}

/** Bent reinforcing bars sticking out of the rubble. */
function rebar(ctx: CanvasRenderingContext2D, rnd: () => number, x: number, y: number, maxLen: number): void {
  ctx.lineWidth = 1.4 + rnd() * 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + 4);
  const a = (rnd() - 0.5) * 0.9;
  const len = 14 + rnd() * Math.max(8, maxLen - 14);
  const mx = x + Math.sin(a) * len * 0.6, my = y - Math.cos(a) * len * 0.6;
  ctx.lineTo(mx, my);
  const b = a + (rnd() - 0.5) * 1.6;                       // the bend
  ctx.lineTo(mx + Math.sin(b) * len * 0.4, my - Math.cos(b) * len * 0.4);
  ctx.stroke();
}

/** A stump of wall with a stepped, broken top. */
function wall(ctx: CanvasRenderingContext2D, rnd: () => number, x0: number, w: number, top: number): void {
  const steps = 3 + Math.floor(rnd() * 3);
  const pts: Pt[] = [[x0, STRIP_H]];
  let y = STRIP_H - top * (0.45 + rnd() * 0.2);
  for (let i = 0; i < steps; i++) {
    const x = x0 + (w * i) / steps;
    y = i === 0 ? y : Math.max(STRIP_H - top, y + (rnd() - 0.6) * top * 0.4);
    pts.push([x, y], [x + w / steps, y]);
  }
  pts.push([x0 + w, STRIP_H]);
  ctx.beginPath();
  pts.forEach(([x, py], i) => (i ? ctx.lineTo(x, py) : ctx.moveTo(x, py)));
  ctx.closePath();
  ctx.fill();
  // window notch
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(x0 + w * 0.3, STRIP_H - top * 0.35, w * 0.22, top * 0.2);
  ctx.restore();
}

/** A snapped column: narrow, with a jagged broken top. */
function pillar(ctx: CanvasRenderingContext2D, rnd: () => number, x: number, top: number): void {
  const w = 9 + rnd() * 9;
  ctx.beginPath();
  ctx.moveTo(x, STRIP_H);
  ctx.lineTo(x, STRIP_H - top * (0.7 + rnd() * 0.2));
  ctx.lineTo(x + w * 0.3, STRIP_H - top);
  ctx.lineTo(x + w * 0.55, STRIP_H - top * (0.78 + rnd() * 0.12));
  ctx.lineTo(x + w * 0.8, STRIP_H - top * (0.9 + rnd() * 0.1));
  ctx.lineTo(x + w, STRIP_H - top * (0.6 + rnd() * 0.2));
  ctx.lineTo(x + w, STRIP_H);
  ctx.closePath();
  ctx.fill();
}

/** One pile of rubble and debris, `w` wide with its highest point near `peak`. */
function cluster(ctx: CanvasRenderingContext2D, rnd: () => number, x0: number, w: number, peak: number): void {
  const heapH = Math.min(peak * 0.7, 14 + rnd() * 34);
  const at = heap(ctx, rnd, x0, w, heapH);
  if (peak > 55 && rnd() < 0.7) wall(ctx, rnd, x0 + w * (0.1 + rnd() * 0.4), 24 + rnd() * 34, peak);
  if (peak > 45 && rnd() < 0.8) pillar(ctx, rnd, x0 + w * (0.55 + rnd() * 0.35), peak * (0.75 + rnd() * 0.25));
  const slabs = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < slabs; i++) {
    const x = x0 + w * (0.15 + rnd() * 0.7);
    slab(ctx, rnd, x, STRIP_H - at(x) + 6, STRIP_H - peak);
  }
  const bars = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < bars; i++) {
    const x = x0 + w * (0.1 + rnd() * 0.8);
    rebar(ctx, rnd, x, STRIP_H - at(x), peak * (0.5 + rnd() * 0.5));
  }
  // loose bricks and chunks resting on top
  const bits = 3 + Math.floor(rnd() * 6);
  for (let i = 0; i < bits; i++) {
    const x = x0 + w * (0.05 + rnd() * 0.9);
    const s = 3 + rnd() * 7;
    ctx.save();
    ctx.translate(x, STRIP_H - at(x) - s * 0.4);
    ctx.rotate((rnd() - 0.5) * 1.4);
    ctx.fillRect(-s, -s / 2, s * 2, s);
    ctx.restore();
  }
}

/** A strip of the layer, drawn once: clusters of rubble with gaps between them, so it is broken, not continuous. */
function drawStrip(index: number, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(STRIP_W * scale);
  c.height = Math.ceil(STRIP_H * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = ctx.strokeStyle = COLOR;
  const rnd = mulberry32(index * 7919 + 31);
  let x = -40 + rnd() * 80;                         // clusters may straddle the seam; a little overlap hides it
  while (x < STRIP_W) {
    const w = 90 + rnd() * 200;
    const tall = rnd() < 0.34;
    cluster(ctx, rnd, x, w, tall ? 72 + rnd() * (PEAK - 72) : 28 + rnd() * 42);
    x += w * (0.6 + rnd() * 0.4) + 10 + rnd() * 130;   // overlaps now and then, and leaves gaps
  }
  return c;
}

/**
 * The frontmost parallax layer: a black silhouette of rubble and debris along the bottom of the screen, broken
 * into piles with gaps between, never more than about 150 pixels (at 720p) tall. It scrolls faster than the
 * street. A 2D canvas laid over the 3D view.
 */
export class Foreground {
  readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d')!;
  private strips = new Map<number, HTMLCanvasElement>();
  private scale = 1;
  private lastU = NaN;

  constructor() {
    Object.assign(this.canvas.style, { position: 'fixed', left: '0', bottom: '0', width: '100vw', pointerEvents: 'none' });
    this.resize();
  }

  /** call when the window changes size */
  resize(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    this.scale = (innerHeight / 720) * dpr * SIZE;            // layer pixels per authored pixel
    this.canvas.width = Math.ceil(innerWidth * dpr);
    this.canvas.height = Math.ceil(STRIP_H * this.scale);
    this.canvas.style.height = `${(this.canvas.height / dpr)}px`;
    this.strips.clear();
    this.lastU = NaN;
  }

  /** @param camX the camera's x in the world */
  update(camX: number): void {
    const { canvas, ctx, scale } = this;
    // how far the layer has scrolled, in device pixels: world units -> screen pixels, times the parallax factor
    const u = camX * PARALLAX * (canvas.width / SCREEN_W);
    if (u === this.lastU) return;
    this.lastU = u;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const stripPx = STRIP_W * scale;
    const first = Math.floor(u / stripPx), last = Math.floor((u + canvas.width) / stripPx);
    for (let i = first; i <= last; i++) {
      let s = this.strips.get(i);
      if (!s) { s = drawStrip(i, scale); this.strips.set(i, s); }
      ctx.drawImage(s, Math.round(i * stripPx - u), 0);
    }
    if (this.strips.size > 12) for (const k of [...this.strips.keys()]) if (k < first - 3 || k > last + 3) this.strips.delete(k);
  }
}
