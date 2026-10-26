import * as THREE from 'three';

/** One look for a scene: the light, the air and the sky. Scenes name one (`"environment"` in the level file) and the game fades to it. */
export interface EnvDef {
  fog: { color: number; near: number; far: number };
  hemi: { sky: number; ground: number; intensity: number };
  /** the sun (or moon): its colour and strength, and where it stands, as an offset from the camera */
  sun: { color: number; intensity: number; offset: [number, number, number] };
  /** the backlight from behind the skyline */
  rim: { color: number; intensity: number };
  /** 0 = the night sky (stars, storm clouds), 1 = a day sky with a sun */
  day: number;
  /** how much of the rain there is: 0 = dry (no rain, no rain sound, no lightning), 1 = the usual */
  rain: number;
  /** the volumetric haze: its colour (linear light) and how thick it is */
  haze: { color: [number, number, number]; density: number };
  /** what the ground colour is multiplied by (linear): the ground texture is dark, a bright scene lifts it */
  ground: [number, number, number];
  /** the day sky: its colour overhead and half way down, and where the sun hangs in it (a direction from the camera; the light itself comes from `sun.offset`) */
  sky: { zenith: [number, number, number]; mid: [number, number, number]; sun: [number, number, number] };
  /** how much the air shimmers over the far ground (0 = not at all) */
  shimmer: number;
  /** the colour of the dust a blast or a footfall throws up */
  dust: number;
}

export const ENVIRONMENTS: Record<string, EnvDef> = {
  /** the wet night of the ruined city */
  night: {
    fog: { color: 0x030d0b, near: 28, far: 62 },
    hemi: { sky: 0x34447a, ground: 0x0a2a22, intensity: 0.75 },
    sun: { color: 0x98a6d8, intensity: 1.15, offset: [-30, 25, 20] },
    rim: { color: 0x40ff90, intensity: 0.15 },
    day: 0,
    rain: 1,
    haze: { color: [0.02, 0.027, 0.042], density: 1 },
    ground: [1, 1, 1],
    sky: { zenith: [0, 0, 0], mid: [0, 0, 0], sun: [0, 1, 0] },
    shimmer: 0,
    dust: 0x4f5c66,
  },
  /** the desert at sunset: a low red sun behind the mech (the right of the screen), long shadows pointing the way it faces, dust-reddened air */
  dunes: {
    fog: { color: 0xdc9468, near: 80, far: 340 },
    hemi: { sky: 0x8480b8, ground: 0xa87a52, intensity: 0.8 },
    sun: { color: 0xffa866, intensity: 3.0, offset: [34, 6, 4] },
    rim: { color: 0xffffff, intensity: 0 },
    day: 1,
    rain: 0,
    haze: { color: [0.55, 0.28, 0.14], density: 0.3 },
    ground: [1, 0.93, 0.82],
    sky: { zenith: [0.08, 0.12, 0.34], mid: [0.52, 0.33, 0.42], sun: [0.3, 0.11, -0.95] },
    shimmer: 1,
    dust: 0xc78a58,
  },
};

/** the blendable numbers of a look */
interface State {
  fogColor: THREE.Color; fogNear: number; fogFar: number;
  hemiSky: THREE.Color; hemiGround: THREE.Color; hemiIntensity: number;
  sunColor: THREE.Color; sunIntensity: number; sunOffset: THREE.Vector3;
  rimColor: THREE.Color; rimIntensity: number;
  day: number; rain: number;
  hazeColor: THREE.Color; hazeDensity: number;
  groundTint: THREE.Color;
  skyZenith: THREE.Color; skyMid: THREE.Color; skySun: THREE.Vector3;
  shimmer: number;
  dustColor: THREE.Color;
}

const stateOf = (d: EnvDef): State => ({
  fogColor: new THREE.Color(d.fog.color), fogNear: d.fog.near, fogFar: d.fog.far,
  hemiSky: new THREE.Color(d.hemi.sky), hemiGround: new THREE.Color(d.hemi.ground), hemiIntensity: d.hemi.intensity,
  sunColor: new THREE.Color(d.sun.color), sunIntensity: d.sun.intensity, sunOffset: new THREE.Vector3(...d.sun.offset),
  rimColor: new THREE.Color(d.rim.color), rimIntensity: d.rim.intensity,
  day: d.day, rain: d.rain,
  hazeColor: new THREE.Color(...d.haze.color), hazeDensity: d.haze.density,
  groundTint: new THREE.Color(...d.ground),
  skyZenith: new THREE.Color(...d.sky.zenith), skyMid: new THREE.Color(...d.sky.mid), skySun: new THREE.Vector3(...d.sky.sun),
  shimmer: d.shimmer,
  dustColor: new THREE.Color(d.dust),
});

const mix = (a: number, b: number, k: number): number => a + (b - a) * k;

function blend(out: State, a: State, b: State, k: number): void {
  out.fogColor.lerpColors(a.fogColor, b.fogColor, k); out.fogNear = mix(a.fogNear, b.fogNear, k); out.fogFar = mix(a.fogFar, b.fogFar, k);
  out.hemiSky.lerpColors(a.hemiSky, b.hemiSky, k); out.hemiGround.lerpColors(a.hemiGround, b.hemiGround, k); out.hemiIntensity = mix(a.hemiIntensity, b.hemiIntensity, k);
  out.sunColor.lerpColors(a.sunColor, b.sunColor, k); out.sunIntensity = mix(a.sunIntensity, b.sunIntensity, k); out.sunOffset.lerpVectors(a.sunOffset, b.sunOffset, k);
  out.rimColor.lerpColors(a.rimColor, b.rimColor, k); out.rimIntensity = mix(a.rimIntensity, b.rimIntensity, k);
  out.day = mix(a.day, b.day, k); out.rain = mix(a.rain, b.rain, k);
  out.hazeColor.lerpColors(a.hazeColor, b.hazeColor, k); out.hazeDensity = mix(a.hazeDensity, b.hazeDensity, k);
  out.groundTint.lerpColors(a.groundTint, b.groundTint, k);
  out.skyZenith.lerpColors(a.skyZenith, b.skyZenith, k); out.skyMid.lerpColors(a.skyMid, b.skyMid, k); out.skySun.lerpVectors(a.skySun, b.skySun, k);
  out.shimmer = mix(a.shimmer, b.shimmer, k);
  out.dustColor.lerpColors(a.dustColor, b.dustColor, k);
}

/**
 * The look of the scene being played, fading smoothly from one scene's environment to the next. The game reads the current
 * values every frame (`now`) and applies them to its lights, fog, sky, haze, rain and ground.
 */
export class Environment {
  /** the look right now */
  readonly now: State;
  private from: State;
  private to: State;
  private t = 1;
  private duration = 1;

  constructor(name: string) {
    this.now = stateOf(ENVIRONMENTS[name]);
    this.from = stateOf(ENVIRONMENTS[name]);
    this.to = stateOf(ENVIRONMENTS[name]);
  }

  /** switch at once */
  snap(name: string): void {
    this.to = stateOf(ENVIRONMENTS[name]);
    this.t = 1;
    blend(this.now, this.to, this.to, 0);
  }

  /** fade to another look over `seconds` */
  fadeTo(name: string, seconds: number): void {
    blend(this.from, this.now, this.now, 0);          // start from wherever the fade is now
    this.to = stateOf(ENVIRONMENTS[name]);
    this.t = 0;
    this.duration = Math.max(0.01, seconds);
  }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    blend(this.now, this.from, this.to, this.t * this.t * (3 - 2 * this.t));
  }
}
