import * as THREE from 'three';
import type { World } from './world';

/**
 * Drizzle, all on the GPU. Every drop and splash is a pure function of time and a per-instance seed,
 * so the CPU does nothing per drop. Interaction comes from two cheap occluders sampled in the shader:
 *  - a top-down height-map of the destructible buildings (roofs shed the rain, ruins open to the sky get wet),
 *  - an analytic dome around the mech (drops end on its cockpit and spray).
 * Drops are slanted by the wind; muzzle fire lights the drops nearby.
 */

/** most drops that can be in the air (a downpour); the drizzle shows about the first 28% */
const DROPS = 9000;
/** share of DROPS visible at the lightest drizzle */
const MIN_DENSITY = 0.28;
/** one full cycle drizzle -> downpour -> drizzle, in seconds */
const CYCLE = 130;
/** height-map: covers x in [centre-40, centre+40] and z in [-18, 8] at 0.25 units per texel */
const MAP_W = 320, MAP_D = 104, TEXEL = 0.25, MAP_Z0 = -18;
const REBUILD_SHIFT = 8;

const COMMON = /* glsl */ `
attribute vec4 aSeed;          // x: lattice x, y: lane depth, z: phase, w: speed/length variation
attribute float aRank;         // drops with a rank above the current density are not raining right now
uniform float uClock, uCamX, uSlant, uDensity, uIntensity;
uniform vec4 uMap;             // origin x, origin z, 1/width, 1/depth
uniform vec4 uMech;            // x, z, radius, top
uniform sampler2D uHeight;
uniform vec2 uRes;
uniform vec4 uLight0, uLight1; // muzzle fire: xyz position, w intensity
const float H = 14.0;          // drops fall from this height
const float BOX = 56.0;        // wrap width around the camera
const float ZMIN = -17.0, ZMAX = 7.0;

float surfaceAt(vec2 xz) {
  vec2 uv = (xz - uMap.xy) * uMap.zw;
  float h = 0.0;
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) h = texture2D(uHeight, uv).r;
  vec2 d = xz - uMech.xy;
  float md2 = dot(d, d) / (uMech.z * uMech.z);
  if (md2 < 1.0) h = max(h, uMech.w * sqrt(1.0 - md2));
  return h;
}
vec3 lightTint(vec3 p) {
  vec3 r0 = p - uLight0.xyz, r1 = p - uLight1.xyz;
  return vec3(1.0, 0.6, 0.3) * (uLight0.w / (1.0 + 1.2 * dot(r0, r0)) + uLight1.w / (1.0 + 1.2 * dot(r1, r1)));
}
`;

const DROP_VERT = COMMON + /* glsl */ `
varying float vAlpha;
varying float vSide;
varying vec3 vTint;
void main() {
  float v = 9.0 * (0.85 + 0.3 * aSeed.w);
  float P = H / v;
  float ph = fract(uClock / P + aSeed.z);
  float xL = (fract(aSeed.x - uCamX / BOX + 0.5) - 0.5) * BOX + uCamX;   // fixed in the world as the camera moves
  float zL = mix(ZMIN, ZMAX, aSeed.y);
  float fadeRank = smoothstep(uDensity, uDensity - 0.03, aRank);          // drops fade in/out as the rain changes
  float surf = surfaceAt(vec2(xL, zL));
  float yHead = H * (1.0 - ph);
  if (fadeRank <= 0.0 || yHead < surf + 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; vSide = 0.0; vTint = vec3(0.0); return; }

  vec3 head = vec3(xL + uSlant * yHead, yHead, zL);        // slanted forward (-x is forward; the wind pushes drops that way)
  vec3 dir = normalize(vec3(uSlant, 1.0, 0.0));
  vec3 tail = head + dir * (0.32 + 0.5 * aSeed.w) * (1.0 + 0.6 * uIntensity);
  vec4 ch = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec4 ct = projectionMatrix * viewMatrix * vec4(tail, 1.0);
  vec2 sd = normalize((ct.xy / ct.w - ch.xy / ch.w) * uRes + 1e-5);
  vec2 side = vec2(-sd.y, sd.x) * ((1.5 + 0.6 * uIntensity) / uRes);            // ~1.6 px wide in NDC (x2 for the quad's +-0.5)
  float along = position.y + 0.5;                          // 0 at the head, 1 at the tail
  vec4 c = mix(ch, ct, along);
  gl_Position = c;
  gl_Position.xy += side * position.x * c.w;

  float dist = distance(cameraPosition, head);
  vAlpha = (1.0 - along) * (0.22 + 0.28 * aSeed.w) * (0.75 + 0.6 * uIntensity) * fadeRank * exp(-dist / 55.0) * smoothstep(0.0, 0.04, ph);
  vSide = position.x * 2.0;
  vTint = vec3(0.55, 0.65, 0.85) + lightTint(head) * 2.0;
}`;

const DROP_FRAG = /* glsl */ `
varying float vAlpha;
varying float vSide;
varying vec3 vTint;
void main() {
  float edge = 1.0 - abs(vSide);
  gl_FragColor = vec4(vTint, vAlpha * edge);
}`;

const SPLASH_VERT = COMMON + /* glsl */ `
varying float vAlpha;
varying vec2 vUv;
varying vec3 vTint;
void main() {
  float v = 9.0 * (0.85 + 0.3 * aSeed.w);
  float P = H / v;
  float ph = fract(uClock / P + aSeed.z);
  float xL = (fract(aSeed.x - uCamX / BOX + 0.5) - 0.5) * BOX + uCamX;
  float zL = mix(ZMIN, ZMAX, aSeed.y);
  float fadeRank = smoothstep(uDensity, uDensity - 0.03, aRank);
  float surf = surfaceAt(vec2(xL, zL));
  float age = fract(ph - (1.0 - surf / H)) * P;            // seconds since this drop reached its surface
  const float LIFE = 0.24;
  if (fadeRank <= 0.0 || age > LIFE) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; vUv = vec2(0.0); vTint = vec3(0.0); return; }
  float k = age / LIFE;
  vec3 centre = vec3(xL + uSlant * surf, surf + 0.012, zL);
  float sz = mix(0.025, 0.12, k) * (0.7 + 0.6 * aSeed.w) * (0.85 + 0.45 * uIntensity);
  vec3 wp = centre + vec3(position.x * sz * 2.0, 0.0, position.y * sz * 2.0);   // lies flat: a ripple
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vUv = position.xy * 2.0;
  float dist = distance(cameraPosition, centre);
  vAlpha = pow(1.0 - k, 1.6) * 0.55 * (0.8 + 0.5 * uIntensity) * fadeRank * exp(-dist / 45.0);
  vTint = vec3(0.6, 0.72, 0.95) + lightTint(centre) * 2.0;
}`;

const SPLASH_FRAG = /* glsl */ `
varying float vAlpha;
varying vec2 vUv;
varying vec3 vTint;
void main() {
  float r = length(vUv);
  float ring = smoothstep(0.45, 0.7, r) * (1.0 - smoothstep(0.75, 1.0, r));
  float core = 1.0 - smoothstep(0.0, 0.35, r);
  gl_FragColor = vec4(vTint, vAlpha * (ring + 0.7 * core));
}`;

export class Rain {
  private heightData = new Float32Array(MAP_W * MAP_D);
  private heightTex: THREE.DataTexture;
  private mapCentre = Infinity;
  private versionSum = -1;
  private uniforms: Record<string, THREE.IUniform>;
  private meshes: THREE.Mesh[] = [];
  private t = 0;
  private clock = 0;
  /** 0 = lightest drizzle, 1 = full downpour (read by anything that wants to react to the rain) */
  intensity = 0;
  /** debug: pin the intensity (null = follow the sine) */
  override: number | null = null;
  /** how much of the rain there is (the scene's environment): 0 = none at all, 1 = as it falls */
  scale = 1;

  constructor(scene: THREE.Scene, private world: World) {
    this.heightTex = new THREE.DataTexture(this.heightData, MAP_W, MAP_D, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.needsUpdate = true;

    this.uniforms = {
      uClock: { value: 0 }, uCamX: { value: 0 }, uSlant: { value: 0.3 },
      uDensity: { value: MIN_DENSITY }, uIntensity: { value: 0 },
      uMap: { value: new THREE.Vector4(0, MAP_Z0, 1 / (MAP_W * TEXEL), 1 / (MAP_D * TEXEL)) },
      uMech: { value: new THREE.Vector4(0, 0, 0.95, 2.2) },
      uHeight: { value: this.heightTex },
      uRes: { value: new THREE.Vector2(1280, 720) },
      uLight0: { value: new THREE.Vector4() }, uLight1: { value: new THREE.Vector4() },
    };

    const seeds = new Float32Array(DROPS * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const ranks = new Float32Array(DROPS);
    for (let i = 0; i < DROPS; i++) ranks[i] = Math.random();
    const make = (vert: string, frag: string): THREE.Mesh => {
      const g = new THREE.InstancedBufferGeometry();
      const plane = new THREE.PlaneGeometry(1, 1);
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
      g.setAttribute('aRank', new THREE.InstancedBufferAttribute(ranks, 1));
      g.instanceCount = DROPS;
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
      }));
      m.frustumCulled = false;
      scene.add(m);
      this.meshes.push(m);
      return m;
    };
    make(DROP_VERT, DROP_FRAG);
    make(SPLASH_VERT, SPLASH_FRAG);
  }

  set visible(v: boolean) { this.meshes.forEach((m) => (m.visible = v)); }
  get visible(): boolean { return this.meshes[0].visible; }

  setResolution(w: number, h: number): void {
    (this.uniforms.uRes.value as THREE.Vector2).set(w, h);
  }

  /** Rebuild the height-map when the camera has moved on or any building nearby has changed. */
  private refreshHeightMap(camX: number): void {
    const half = (MAP_W * TEXEL) / 2;
    let sum = 0;
    this.world.forEachBuilding(camX - half, camX + half, (b) => { sum += b.version + 1; });
    if (Math.abs(camX - this.mapCentre) < REBUILD_SHIFT && sum === this.versionSum) return;
    this.mapCentre = camX;
    this.versionSum = sum;
    const ox = camX - half;
    this.heightData.fill(0);
    this.world.forEachBuilding(ox, ox + MAP_W * TEXEL, (b) => {
      b.forEachColumnTop((x0, x1, z0, z1, top) => {
        const i0 = Math.max(0, Math.floor((x0 - ox) / TEXEL)), i1 = Math.min(MAP_W - 1, Math.floor((x1 - ox) / TEXEL));
        const j0 = Math.max(0, Math.floor((z0 - MAP_Z0) / TEXEL)), j1 = Math.min(MAP_D - 1, Math.floor((z1 - MAP_Z0) / TEXEL));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const k = j * MAP_W + i;
            if (top > this.heightData[k]) this.heightData[k] = top;
          }
        }
      });
    });
    this.heightTex.needsUpdate = true;
    (this.uniforms.uMap.value as THREE.Vector4).x = ox;
  }

  /** Intensity over time: a long slow wave (drizzle <-> downpour) with slight irregular variation on top. */
  private waveAt(t: number): number {
    const base = Math.sin((t / CYCLE) * Math.PI * 2 - Math.PI / 2);          // starts at the lightest drizzle
    const wobble = 0.16 * Math.sin((t / 37) * Math.PI * 2 + 1.3) + 0.07 * Math.sin((t / 13) * Math.PI * 2 + 4.1);
    return THREE.MathUtils.clamp(0.5 + 0.5 * (base * 0.8 + wobble * 0.7), 0, 1);
  }

  /**
   * @param windSpeed current wind (world units/s), used for the slant
   * @param lights two muzzle lights as (x, y, z, intensity)
   */
  update(dt: number, camX: number, mechX: number, mechZ: number, windSpeed: number, lights: THREE.Vector4[]): void {
    this.t += dt;
    this.intensity = (this.override ?? this.waveAt(this.t)) * this.scale;
    for (const m of this.meshes) m.visible = this.scale > 0.02;
    this.refreshHeightMap(camX);
    const u = this.uniforms;
    // drops fall a little faster in heavy rain; accumulate the clock so speed changes never make drops jump
    this.clock += dt * (0.92 + 0.4 * this.intensity);
    u.uClock.value = this.clock % 600;
    u.uCamX.value = camX;
    u.uIntensity.value = this.intensity;
    u.uDensity.value = MIN_DENSITY + (1 - MIN_DENSITY) * this.intensity;
    // pushed toward -x by the wind: stronger wind, flatter drops (kept within a sensible slant)
    const target = THREE.MathUtils.clamp(0.1 + windSpeed * 0.16 + 0.05 * this.intensity, 0.12, 0.65);
    u.uSlant.value += (target - u.uSlant.value) * 0.04;
    (u.uMech.value as THREE.Vector4).set(mechX, mechZ, 0.95, 2.2);
    (u.uLight0.value as THREE.Vector4).copy(lights[0]);
    (u.uLight1.value as THREE.Vector4).copy(lights[1]);
  }
}
