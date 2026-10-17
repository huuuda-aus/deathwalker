import * as THREE from 'three';

/** Teardrop flame: white-hot at the barrel (right edge), orange, fading red at the tip (left). */
function makeFlameTexture(): THREE.CanvasTexture {
  const W = 256, H = 96;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(W, 0, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,235,1)');
  grad.addColorStop(0.22, 'rgba(255,215,110,0.97)');
  grad.addColorStop(0.55, 'rgba(255,120,25,0.65)');
  grad.addColorStop(1, 'rgba(190,40,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // soft elongated mask: wide at the muzzle, tapering to the tip
  g.globalCompositeOperation = 'destination-in';
  g.setTransform((W * 0.98) / (H / 2), 0, 0, 1, W, H / 2);
  const mask = g.createRadialGradient(0, 0, 0, 0, 0, H / 2);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.5, 'rgba(255,255,255,0.75)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = mask;
  g.fillRect(-W, -H, 2 * W, 2 * H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,200,110,0.8)');
  r.addColorStop(0.6, 'rgba(255,110,20,0.25)');
  r.addColorStop(1, 'rgba(255,60,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


let sharedFlame: THREE.CanvasTexture | null = null;
let sharedGlow: THREE.CanvasTexture | null = null;
/** Textures are built once and shared by every flame/glow sprite. */
export const flameTexture = (): THREE.CanvasTexture => (sharedFlame ??= makeFlameTexture());
export const glowTexture = (): THREE.CanvasTexture => (sharedGlow ??= makeGlowTexture());
