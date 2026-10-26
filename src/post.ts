import * as THREE from 'three';
import { HazePass } from './haze';
import {
  BlendFunction, BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass,
  NoiseEffect, RenderPass, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';

const SHUTTER = 0.08;
const EXPOSURE = 1.25;

const frag = /* glsl */ `
uniform float uVel;      // camera speed (world units / s)
uniform float uK;        // shutter / (2 * tan(fov/2) * aspect)
uniform float uInvD0;    // 1 / camera-to-gameplay-plane distance
uniform float uExposure;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float d = -getViewZ(depth);
  // The camera tracks the mech, so things at the gameplay depth stay sharp. Only what is nearer than that
  // smears; the background layers (farther) stay crisp.
  float len = uK * uVel * max(0.0, 1.0 / max(d, 0.5) - uInvD0);
  len = min(len, 0.04);
  vec3 acc = vec3(0.0);
  const int N = 10;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1) - 0.5;
    acc += texture2D(inputBuffer, uv + vec2(t * len, 0.0)).rgb;
  }
  outputColor = vec4(acc / float(N) * uExposure, inputColor.a);
}`;

/** Depth-aware horizontal motion blur driven by camera speed, plus exposure. */
class SpeedBlurEffect extends Effect {
  constructor(camDist: number) {
    super('SpeedBlurEffect', frag, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uVel', new THREE.Uniform(0)],
        ['uK', new THREE.Uniform(0)],
        ['uInvD0', new THREE.Uniform(1 / camDist)],
        ['uExposure', new THREE.Uniform(EXPOSURE)],
      ]),
    });
  }
  set(vel: number, k: number): void {
    this.uniforms.get('uVel')!.value = vel;
    this.uniforms.get('uK')!.value = k;
  }
}


/** Haze + bloom + speed blur + vignette + tone mapping. Toggle off for the plain renderer path. */
export class Post {
  enabled = true;
  private composer: EffectComposer;
  private blur: SpeedBlurEffect;
  private hazePass: HazePass;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, camDist: number) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    this.composer.addPass(new RenderPass(scene, camera));
    // haze first: it works on linear scene light, before exposure and blur
    this.hazePass = new HazePass(camera);
    this.composer.addPass(this.hazePass);
    this.blur = new SpeedBlurEffect(camDist);
    this.composer.addPass(new EffectPass(camera, this.blur));
    const bloom = new BloomEffect({
      mipmapBlur: true, intensity: 0.9, luminanceThreshold: 1.0, luminanceSmoothing: 0.25, radius: 0.75,
    });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.65 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    // a whisper of grain acts as dither: the smooth haze gradients would otherwise band in 8 bits
    const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY });
    grain.blendMode.opacity.value = 0.06;
    this.composer.addPass(new EffectPass(camera, bloom, vignette, tone, grain));
    this.apply();
  }

  /** Haze on/off (the rest of the post stack stays on). */
  toggleHaze(): boolean {
    this.hazePass.enabled = !this.hazePass.enabled;
    return this.hazePass.enabled;
  }

  setHazeDensityScale(k: number): void { this.hazePass.densityScale = k; }
  setHazeColor(c: THREE.Color): void { this.hazePass.setColor(c); }

  /** @param lights two muzzle lights as (x, y, z, intensity) */
  updateHaze(time: number, windTravelled: number, lights: THREE.Vector4[]): void {
    this.hazePass.set(time, windTravelled, lights);
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.apply();
    return this.enabled;
  }

  private apply(): void {
    // Composer path tone-maps itself; plain path uses the renderer's.
    this.renderer.toneMapping = this.enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt: number, camVel: number): void {
    if (!this.enabled) { this.renderer.render(this.scene, this.camera); return; }
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    this.blur.set(Math.abs(camVel), SHUTTER / (2 * tanHalf * this.camera.aspect));
    this.composer.render(dt);
  }
}
