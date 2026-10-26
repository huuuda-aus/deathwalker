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
  },
  /** a harsh white day in the desert: dry, bright, dusty */
  dunes: {
    fog: { color: 0xcdb892, near: 60, far: 240 },
    hemi: { sky: 0xa9c4ff, ground: 0xa07c4a, intensity: 0.8 },
    sun: { color: 0xfff1d6, intensity: 3.1, offset: [-30, 16, 10] },
    rim: { color: 0xffffff, intensity: 0 },
    day: 1,
    rain: 0,
    haze: { color: [0.5, 0.42, 0.3], density: 0.22 },
    ground: [1, 1, 1],
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
}

const stateOf = (d: EnvDef): State => ({
  fogColor: new THREE.Color(d.fog.color), fogNear: d.fog.near, fogFar: d.fog.far,
  hemiSky: new THREE.Color(d.hemi.sky), hemiGround: new THREE.Color(d.hemi.ground), hemiIntensity: d.hemi.intensity,
  sunColor: new THREE.Color(d.sun.color), sunIntensity: d.sun.intensity, sunOffset: new THREE.Vector3(...d.sun.offset),
  rimColor: new THREE.Color(d.rim.color), rimIntensity: d.rim.intensity,
  day: d.day, rain: d.rain,
  hazeColor: new THREE.Color(...d.haze.color), hazeDensity: d.haze.density,
  groundTint: new THREE.Color(...d.ground),
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
