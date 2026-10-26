import type * as THREE from 'three';

/**
 * The desert's rolling ground: long, lopsided dunes across the street, high enough that a soldier behind a crest is hidden from the mech, and easing out to flat behind the lane, where the painted dunes on the horizon take over.
 * `terrainHeight` is the one definition of it: the CPU (things standing on the ground, bullets, falling rubble) and the
 * ground's own vertex shader (the picture) both use it, so they always agree. It is flat (0) in the city.
 */
export const terrain = { on: false };

/** how high the crests rise and how deep the troughs sink (world units) */
const AMP = 1.0;
/** the ground is full height in front of this z and flat behind that one */
const FADE_NEAR = -10, FADE_FAR = -26;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the ground's height above the flat at (x, z) */
export function terrainHeight(x: number, z: number): number {
  if (!terrain.on) return 0;
  const a1 = x * 0.27 + z * 0.06 + 0.7;
  const a2 = x * 0.093 - z * 0.05 + 2.1;
  const a3 = x * 0.47 + z * 0.13;
  const f = 0.5 * Math.sin(a1 + 0.6 * Math.sin(a1 * 0.5)) + 0.35 * Math.sin(a2) + 0.15 * Math.sin(a3);
  return AMP * f * smooth(FADE_FAR, FADE_NEAR, z);
}

const GLSL = /* glsl */ `
float terrainHeight(vec2 p) {
  float a1 = p.x * 0.27 + p.y * 0.06 + 0.7;
  float a2 = p.x * 0.093 - p.y * 0.05 + 2.1;
  float a3 = p.x * 0.47 + p.y * 0.13;
  float f = 0.5 * sin(a1 + 0.6 * sin(a1 * 0.5)) + 0.35 * sin(a2) + 0.15 * sin(a3);
  return ${AMP.toFixed(3)} * f * smoothstep(${FADE_FAR.toFixed(1)}, ${FADE_NEAR.toFixed(1)}, p.y);
}
vec2 terrainSlope(vec2 p) {
  const float e = 0.05;
  return vec2(terrainHeight(p + vec2(e, 0.0)) - terrainHeight(p - vec2(e, 0.0)), terrainHeight(p + vec2(0.0, e)) - terrainHeight(p - vec2(0.0, e))) / (2.0 * e);
}
`;

/**
 * Make a (standard) material follow the terrain: its vertices are lifted by the ground's height at their world position
 * and its normals tilted to the slope. Works on any mesh that lies on the ground, whatever its own transform: a dent in
 * the ground digs itself out by scaling its height, and the terrain under it is not scaled with it.
 */
export function applyTerrain(material: THREE.MeshStandardMaterial): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        { vec4 tn = modelMatrix * vec4(position, 1.0); vec2 s = terrainSlope(tn.xz); objectNormal = normalize(objectNormal + vec3(-s.x, 0.0, -s.y)); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { vec4 tw = modelMatrix * vec4(transformed, 1.0); transformed.y += terrainHeight(tw.xz) / max(length(modelMatrix[1].xyz), 0.001); }`);
  };
  material.customProgramCacheKey = () => 'terrain';
}
