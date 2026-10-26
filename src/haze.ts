import * as THREE from 'three';
import { Pass } from 'postprocessing';

function makeHazeNoise(size = 32): THREE.Data3DTexture {
  const periodic = (period: number): Float32Array => {
    const lat = new Float32Array(period ** 3);
    for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
    return lat;
  };
  const octaves = [4, 8, 16].map((period) => ({ period, lat: periodic(period), amp: 1 / period ** 0.6 }));
  const total = octaves.reduce((a, o) => a + o.amp, 0);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const data = new Uint8Array(size ** 3);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (const { period, lat, amp } of octaves) {
      const fx = (x / size) * period, fy = (y / size) * period, fz = (z / size) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
      const tx = smooth(fx - x0), ty = smooth(fy - y0), tz = smooth(fz - z0);
      const at = (i: number, j: number, k: number) => lat[((k % period) * period + (j % period)) * period + (i % period)];
      const c00 = at(x0, y0, z0) * (1 - tx) + at(x0 + 1, y0, z0) * tx;
      const c10 = at(x0, y0 + 1, z0) * (1 - tx) + at(x0 + 1, y0 + 1, z0) * tx;
      const c01 = at(x0, y0, z0 + 1) * (1 - tx) + at(x0 + 1, y0, z0 + 1) * tx;
      const c11 = at(x0, y0 + 1, z0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1) * tx;
      v += amp * ((c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz);
    }
    data[(z * size + y) * size + x] = Math.round((v / total) * 255);
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}


const BASE_DENSITY = 0.04;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

/** Low-resolution raymarch: writes scattered light (rgb) and transmittance (a) per pixel. */
const MARCH_FRAG = /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler3D uNoise;
uniform float cameraNear, cameraFar;
uniform vec3 uCamPos;
uniform mat3 uCamRot;
uniform vec2 uTan;
uniform float uTime, uWind, uDensity, uMaxDist;
uniform vec3 uColor;
uniform vec4 uLight0, uLight1;     // xyz position, w intensity: muzzle fire lighting the smoke

float density(vec3 p) {
  // drifting puffs with clear gaps between them; a little thinner high up
  vec3 q = p * 0.021 + vec3(uWind * 0.021, uTime * 0.003, uTime * 0.0015);
  float n = texture(uNoise, q).r * 0.66 + texture(uNoise, q * 2.9 + vec3(0.31, 0.77, 0.12)).r * 0.34;
  // an even haze everywhere, a bit denser in the street where it is close enough to read as clouds
  float bank = exp(-pow((p.z + 2.0) / 10.0, 2.0)) * exp(-max(p.y, 0.0) * 0.09);
  float h = 0.7 + 0.3 * exp(-max(p.y, 0.0) * 0.08) + 1.1 * bank;
  // a steady veil everywhere with puffs a little denser than the gaps: the screen never goes clear while a
  // cloud drifts in, and never clogs when several overlap
  return (0.27 + 0.16 * smoothstep(0.43, 0.70, n)) * h;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 d = vec3(ndc.x * uTan.x, ndc.y * uTan.y, -1.0);   // view-space ray, z = -1 per unit of view depth
  vec3 wd = uCamRot * d;
  float depth = texture2D(tDepth, vUv).r;
  float sEnd = min(-perspectiveDepthToViewZ(depth, cameraNear, cameraFar), uMaxDist);
  float dl = length(d);
  const int N = 16;
  float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233)) + uTime * 7.0) * 43758.5453);
  float ds = sEnd / float(N);
  float T = 1.0;
  vec3 L = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = uCamPos + wd * ((float(i) + jitter) * ds);
    float dens = density(p);
    float a = exp(-dens * uDensity * ds * dl);
    // denser, higher puffs catch more of the moonlight
    // the haze lights up less the farther away it is, so the back stays dark
    float far = exp(-length(p - uCamPos) / 70.0);
    vec3 c = uColor * far * (0.55 + 0.9 * dens * (0.6 + 0.6 * clamp(p.y / 10.0, 0.0, 1.0)));
    vec3 r0 = p - uLight0.xyz, r1 = p - uLight1.xyz;
    c += dens * vec3(1.0, 0.55, 0.22) * (uLight0.w / (1.0 + 1.4 * dot(r0, r0)) + uLight1.w / (1.0 + 1.4 * dot(r1, r1)));
    L += T * (1.0 - a) * c;
    T *= a;
  }
  gl_FragColor = vec4(L, T);
}`;

/**
 * Full-resolution composite: scene * transmittance + scattered light. Over the far ground at the horizon the picture also
 * shimmers: hot air near the ground bends the light, so distant things waver sideways, most just at the horizon line and
 * fading out above it. Only what is far away (by the depth buffer) shimmers, never the mech or the street.
 */
const COMP_FRAG = /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tHaze;
uniform sampler2D tDepth;
uniform float cameraNear, cameraFar, uTime, uShimmer, uHorizon;
void main() {
  vec2 uv = vUv;
  if (uShimmer > 0.001) {
    float dist = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).r, cameraNear, cameraFar);
    float far = smoothstep(70.0, 130.0, dist);
    float band = exp(-pow((vUv.y - uHorizon) / 0.06, 2.0));
    float w = 0.6 * sin(vUv.y * 260.0 + uTime * 2.6 + sin(vUv.x * 9.0 + uTime) * 1.5) + 0.4 * sin(vUv.y * 110.0 - uTime * 1.7 + vUv.x * 5.0);
    uv.x += w * 0.0022 * uShimmer * far * band;
  }
  vec4 scene = texture2D(tScene, uv);
  vec4 haze = texture2D(tHaze, uv);
  gl_FragColor = vec4(scene.rgb * haze.a + haze.rgb, scene.a);
}`;

/**
 * Volumetric haze, ray-marched against the scene depth at a fraction of the screen resolution
 * (the smoke is low-frequency, so it upsamples cleanly) and composited at full resolution.
 */
export class HazePass extends Pass {
  /** multiplies the haze density (heavy rain thickens the air) */
  densityScale = 1;
  setColor(c: THREE.Color): void { this.march.uniforms.uColor.value.copy(c); }

  /** how much the far ground shimmers (the scene's environment): 0 = not at all */
  shimmer = 0;

  /** haze buffer resolution relative to the screen */
  scale = 0.3;
  private rt: THREE.WebGLRenderTarget;
  private march: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  private noise = makeHazeNoise();
  private readonly horizon = new THREE.Vector3();

  constructor(private sceneCamera: THREE.PerspectiveCamera) {
    super('HazePass');
    this.needsDepthTexture = true;
    this.needsSwap = true;
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.march = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: MARCH_FRAG, depthWrite: false, depthTest: false,
      uniforms: {
        tDepth: { value: null }, uNoise: { value: this.noise },
        cameraNear: { value: 0.5 }, cameraFar: { value: 400 },
        uCamPos: { value: new THREE.Vector3() }, uCamRot: { value: new THREE.Matrix3() },
        uTan: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 }, uWind: { value: 0 },
        uDensity: { value: BASE_DENSITY }, uMaxDist: { value: 110 },
        uColor: { value: new THREE.Color(0.02, 0.027, 0.042) },
        uLight0: { value: new THREE.Vector4() }, uLight1: { value: new THREE.Vector4() },
      },
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMP_FRAG, depthWrite: false, depthTest: false,
      uniforms: { tScene: { value: null }, tHaze: { value: this.rt.texture }, tDepth: { value: null }, cameraNear: { value: 0.5 }, cameraFar: { value: 400 }, uTime: { value: 0 }, uShimmer: { value: 0 }, uHorizon: { value: 0.5 } },
    });
    this.fullscreenMaterial = this.comp;
  }

  setDepthTexture(depthTexture: THREE.Texture): void {
    this.march.uniforms.tDepth.value = depthTexture;
    this.comp.uniforms.tDepth.value = depthTexture;
  }

  setSize(width: number, height: number): void {
    this.rt.setSize(Math.max(1, Math.floor(width * this.scale)), Math.max(1, Math.floor(height * this.scale)));
  }

  /** @param lights two muzzle lights as (x, y, z, intensity) */
  set(time: number, wind: number, lights: THREE.Vector4[]): void {
    const u = this.march.uniforms;
    const cam = this.sceneCamera;
    u.uCamPos.value.copy(cam.position);
    u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    u.uTan.value.set(tanHalf * cam.aspect, tanHalf);
    u.cameraNear.value = cam.near;
    u.cameraFar.value = cam.far;
    u.uTime.value = time;
    u.uWind.value = wind;
    u.uDensity.value = BASE_DENSITY * this.densityScale;
    u.uLight0.value.copy(lights[0]);
    u.uLight1.value.copy(lights[1]);
    // the composite's shimmer: strongest on the horizon line, which sits where the far end of the ground is on the screen
    const c = this.comp.uniforms;
    c.uTime.value = time; c.cameraNear.value = cam.near; c.cameraFar.value = cam.far; c.uShimmer.value = this.shimmer;
    c.uHorizon.value = this.horizon.set(cam.position.x, 0, cam.position.z - 3000).project(cam).y * 0.5 + 0.5;
  }

  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget | null): void {
    // 1. march the haze at low resolution
    this.fullscreenMaterial = this.march;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    // 2. composite over the scene at full resolution
    this.comp.uniforms.tScene.value = inputBuffer.texture;
    this.fullscreenMaterial = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.rt.dispose();
    this.march.dispose();
    this.comp.dispose();
    this.noise.dispose();
    super.dispose();
  }
}
