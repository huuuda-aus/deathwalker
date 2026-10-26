import type * as THREE from 'three';

/**
 * The desert's ground: a milder version of the dune sea behind it (farDunes.ts). The same lopsided ridges, a steep slip
 * face and a long gentle back, but low, and slanting across the street so that walking along it climbs and descends them.
 * Near the bunker the dunes are cut flat for a gravel road (`terrain.road`). `terrainHeight` is the one definition of it:
 * the CPU (things standing on the ground, bullets, falling rubble) and the ground's own vertex shader (the picture) both
 * use it, so they always agree. It is flat (0) in the city.
 */

/** the road to the bunker door: its door, how far it runs back from there, and where it lies across the street */
export interface Road {
  /** x of the door; the road runs to the right of it (the level scrolls to the left) */
  doorX: number;
  /** the road is full from this far back from the door, and the dunes have it for themselves from `to` back */
  full: number;
  to: number;
  /** its middle (z) and half width */
  zc: number;
  halfWidth: number;
}

export const terrain: { on: boolean; road: Road | null } = { on: false, road: null };

/** how much the ridges rise (crest over trough, world units) and how far apart they are */
const AMP = 0.75;
const WAVE = 16;
/** the ground is full height in front of this z and flat behind that one (the far dunes begin there) */
const FADE_NEAR = -10, FADE_FAR = -26;
/** where on a ridge (0 = foot of the slip face, 1 = foot of the back) the crest stands, and how soft the foot of the slip face is */
const CREST = 0.28, FOOT = 0.85;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** one ridge's cross-section, 0..1..0: the steep slip face up to the crest (a hair rounded), then the long gentle back down */
function profile(u: number): number {
  const t = Math.min(1, u / CREST);
  const rise = t + FOOT * (t * t * (3 - 2 * t) - t) + Math.max(0, u / CREST - 1) * 3;
  const back = (u - CREST) / (1 - CREST);
  const fall = back <= 0 ? 1 - back * 3 : 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, back));
  const k = 0.07;
  const h = Math.max(k - Math.abs(rise - fall), 0) / k;
  return Math.min(rise, fall) - h * h * k * 0.25;
}

/** how much of the road there is at (x, z): 1 on it, 0 off it */
export function roadMask(x: number, z: number): number {
  const r = terrain.road;
  if (!r) return 0;
  return (1 - smooth(r.doorX + r.full, r.doorX + r.to, x)) * (1 - smooth(r.halfWidth, r.halfWidth + 5, Math.abs(z - r.zc)));
}

/** the ground's height above the flat at (x, z) */
export function terrainHeight(x: number, z: number): number {
  if (!terrain.on) return 0;
  const warp = 0.25 * Math.sin(x * 0.031 + z * 0.05 + 1.3) + 0.12 * Math.sin(x * 0.07 - z * 0.03);
  const ph = (x * 0.9 + z * 0.45) / WAVE + warp;
  const u = ph - Math.floor(ph);
  const am = 0.7 + 0.3 * Math.sin(x * 0.013 + 2.0);
  return AMP * am * (profile(u) - 0.4) * smooth(FADE_FAR, FADE_NEAR, z) * (1 - roadMask(x, z));
}

const num = (v: number): string => v.toFixed(4);

function glsl(): string {
  const r = terrain.road;
  const road = r
    ? `float roadMask(vec2 p) {
  return (1.0 - smoothstep(${num(r.doorX + r.full)}, ${num(r.doorX + r.to)}, p.x)) * (1.0 - smoothstep(${num(r.halfWidth)}, ${num(r.halfWidth + 5)}, abs(p.y - ${num(r.zc)})));
}`
    : 'float roadMask(vec2 p) { return 0.0; }';
  return /* glsl */ `
${road}
float duneProfile(float u) {
  float t = min(1.0, u / ${num(CREST)});
  float rise = t + ${num(FOOT)} * (t * t * (3.0 - 2.0 * t) - t) + max(0.0, u / ${num(CREST)} - 1.0) * 3.0;
  float back = (u - ${num(CREST)}) / ${num(1 - CREST)};
  float fall = back <= 0.0 ? 1.0 - back * 3.0 : 0.5 + 0.5 * cos(3.14159265 * min(1.0, back));
  float h = max(0.07 - abs(rise - fall), 0.0) / 0.07;
  return min(rise, fall) - h * h * 0.07 * 0.25;
}
float terrainHeight(vec2 p) {
  float warp = 0.25 * sin(p.x * 0.031 + p.y * 0.05 + 1.3) + 0.12 * sin(p.x * 0.07 - p.y * 0.03);
  float ph = (p.x * 0.9 + p.y * 0.45) / ${num(WAVE)} + warp;
  float u = ph - floor(ph);
  float am = 0.7 + 0.3 * sin(p.x * 0.013 + 2.0);
  return ${num(AMP)} * am * (duneProfile(u) - 0.4) * smoothstep(${num(FADE_FAR)}, ${num(FADE_NEAR)}, p.y) * (1.0 - roadMask(p));
}
vec2 terrainSlope(vec2 p) {
  const float e = 0.05;
  return vec2(terrainHeight(p + vec2(e, 0.0)) - terrainHeight(p - vec2(e, 0.0)), terrainHeight(p + vec2(0.0, e)) - terrainHeight(p - vec2(0.0, e))) / (2.0 * e);
}
`;
}

/** the gravel of the road: a grey-brown, mottled, with a darker rut for each wheel, over the sand */
function roadColour(): string {
  const r = terrain.road;
  if (!r) return '';
  return /* glsl */ `
  {
    float road = roadMask(vTPos.xz);
    if (road > 0.0) {
      vec2 q = vTPos.xz;
      float n = 0.5 + 0.25 * sin(q.x * 7.3 + sin(q.y * 5.1) * 2.0) + 0.15 * sin(q.x * 19.0 - q.y * 13.0) + 0.1 * sin(q.x * 41.0 + q.y * 37.0);
      vec3 gravel = mix(vec3(0.19, 0.165, 0.135), vec3(0.34, 0.30, 0.25), n);
      float rut = exp(-pow((abs(q.y - ${num(r.zc)}) - 1.5) / 0.4, 2.0));
      gravel *= 1.0 - 0.3 * rut;
      float edge = smoothstep(${num(r.halfWidth - 0.6)}, ${num(r.halfWidth + 1.2)}, abs(q.y - ${num(r.zc)}));
      gravel = mix(gravel, diffuseColor.rgb * 0.95, edge * 0.6);      // loose sand drifts over the edges
      diffuseColor.rgb = mix(diffuseColor.rgb, gravel, road * 0.95);
    }
  }`;
}

/**
 * Make a (standard) material follow the terrain: its vertices are lifted by the ground's height at their world position
 * and its normals tilted to the slope, and the road is laid on it. Works on any mesh that lies on the ground, whatever
 * its own transform: a dent in the ground digs itself out by scaling its height, and the terrain under it is not scaled with it.
 */
export function applyTerrain(material: THREE.MeshStandardMaterial): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTPos;\n${glsl()}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        { vec4 tn = modelMatrix * vec4(position, 1.0); vec2 s = terrainSlope(tn.xz); objectNormal = normalize(objectNormal + vec3(-s.x, 0.0, -s.y)); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { vec4 tw = modelMatrix * vec4(transformed, 1.0); vTPos = tw.xyz; transformed.y += terrainHeight(tw.xz) / max(length(modelMatrix[1].xyz), 0.001); }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTPos;\n${terrain.road ? glsl() : ''}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${roadColour()}`);
  };
  material.customProgramCacheKey = () => `terrain${terrain.road ? '-road' : ''}`;
}
