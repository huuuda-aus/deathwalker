import * as THREE from 'three';
import { FOG_COLOR } from './world';

/** the radioactive green that hugs the horizon */
const GLOW_COLOR = 0x0d4a38;

/**
 * Night sky drawn on a full-screen quad at the far plane: deep blue gradient, a radioactive green
 * glow hugging the horizon, sparse stars, and dark storm clouds on a perspective-projected cloud
 * layer (domain-warped fbm, moonlit silver edges, green under-glow near the horizon).
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uCamX: { value: 0 },
        uCamRot: { value: new THREE.Matrix3() },
        uTan: { value: new THREE.Vector2(1, 1) },
        uFog: { value: new THREE.Color(FOG_COLOR) },
        uGlow: { value: new THREE.Color(GLOW_COLOR) },
        uFlash: { value: 0 },
        uBolt: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 1.0, 1.0); // far plane
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vNdc;
        uniform float uTime, uCamX;
        uniform mat3 uCamRot;
        uniform vec2 uTan;
        uniform vec3 uFog, uGlow;
        uniform float uFlash;
        uniform vec3 uBolt;       // the direction of the lightning

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          mat2 m = mat2(1.6, 1.2, -1.2, 1.6); // rotate + scale each octave to avoid grid alignment
          for (int i = 0; i < 6; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
          return v;
        }
        float star(vec3 d) {
          vec3 p = d * 260.0;
          vec3 c = floor(p);
          float h = fract(sin(dot(c, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          vec3 f = fract(p) - 0.5;
          float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 3.0) + h * 40.0);
          return step(0.9965, h) * smoothstep(0.35, 0.0, length(f)) * tw * (0.4 + 0.6 * fract(h * 91.7));
        }

        void main() {
          vec3 dir = normalize(uCamRot * vec3(vNdc.x * uTan.x, vNdc.y * uTan.y, -1.0));
          float e = dir.y; // elevation: 0 at the horizon, 1 straight up

          // --- sky gradient: deep blue overhead; the green glow sits a little above the horizon,
          // and everything below it sinks into black behind the dense skyline
          vec3 zenith = vec3(0.0006, 0.0012, 0.0045);
          vec3 mid = vec3(0.001, 0.005, 0.019);
          vec3 sky = mix(mid, zenith, smoothstep(0.1, 0.8, e));
          float g = exp(-pow((e - 0.30) / 0.20, 2.0));
          sky += uGlow * 0.42 * g * g;
          sky += vec3(0.0, 0.015, 0.01) * exp(-max(e - 0.1, 0.0) * 4.0);
          float toBlack = smoothstep(0.02, 0.24, e);   // 0 at the horizon -> pure black
          sky *= toBlack;
          if (e <= 0.0) { gl_FragColor = vec4(uFog, 1.0); return; }

          // --- clouds: a layer overhead, projected so they foreshorten toward the horizon
          vec2 uv = dir.xz / max(e, 0.05) * 0.42 + vec2(uCamX * 0.0018 + uTime * 0.010, uTime * 0.003);
          vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
          vec2 r = vec2(fbm(uv + 3.0 * q + vec2(1.7, 9.2)), fbm(uv + 3.0 * q + vec2(8.3, 2.8)));
          vec2 w = uv + 2.6 * r;
          float dens = fbm(w);
          float cover = smoothstep(0.36, 0.74, dens);                 // storm-cloud coverage
          float dense = smoothstep(0.55, 0.95, dens);                  // thick cores
          // light from a hidden moon, up and to the left: edges facing it are lit
          float dens2 = fbm(w + vec2(-0.10, 0.07));
          float lit = clamp((dens - dens2) * 7.0 + 0.0, 0.0, 1.0) * cover;
          // finer wisps along the edges
          float wisp = fbm(w * 3.1 + 7.0);
          lit *= 0.55 + 0.9 * wisp;

          float low = (1.0 - smoothstep(0.1, 0.45, e)) * toBlack;     // near the horizon (but not into the black)
          vec3 cloud = vec3(0.0035, 0.0055, 0.011);                    // near-black blue-grey body
          cloud *= mix(1.0, 0.35, dense);                              // cores are darkest
          cloud += uGlow * 0.8 * low * low * (0.35 + 0.65 * (1.0 - dense)); // green light from below
          cloud += vec3(0.05, 0.07, 0.125) * lit * (1.0 - 0.6 * dense);  // cold silver lining

          float alpha = cover * smoothstep(0.0, 0.06, e) * 0.97;

          // --- stars show through gaps in the cloud
          float s = star(dir) * smoothstep(0.02, 0.25, e);
          cloud *= toBlack;
          // lightning: the clouds light up from within, brightest round the bolt, and the open sky pales
          float near = pow(max(dot(dir, uBolt), 0.0), 14.0);
          cloud += vec3(0.55, 0.64, 0.95) * uFlash * (0.45 + 0.9 * lit + 2.0 * near) * (1.0 - 0.4 * dense);
          sky += vec3(0.10, 0.14, 0.30) * uFlash * (0.5 + 3.0 * near) * toBlack;
          vec3 col = mix(sky, cloud, alpha) + vec3(0.55, 0.65, 0.9) * s * (1.0 - alpha) * 0.5;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);
  }

  /** @param flash how lit the sky is by lightning (0..1); @param toward the direction (from the camera) of the bolt */
  setFlash(flash: number, toward: THREE.Vector3): void {
    this.mat.uniforms.uFlash.value = flash;
    this.mat.uniforms.uBolt.value.copy(toward).normalize();
  }

  update(camera: THREE.PerspectiveCamera, seconds: number): void {
    const u = this.mat.uniforms;
    u.uTime.value = seconds;
    u.uCamX.value = camera.position.x;
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    u.uTan.value.set(tanHalf * camera.aspect, tanHalf);
  }
}
