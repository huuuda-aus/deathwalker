import * as THREE from 'three';
import { terrainHeight } from './terrain';

/** most prints on the ground at once: the oldest are overwritten */
const MAX = 160;
/** a print's size in world units: the mech's foot (toe, sole and heel) is about 1.24 long and 0.55 wide, and the texture leaves a margin round it */
const LENGTH = 1.41, WIDTH = 0.69;

/**
 * The mech's sole as it lies on the sand: a crisp rectangle, toe to the left, in three plates (the upturned toe, the long sole and the
 * heel block, as the foot is built), dented dark with a few treads: no outline, just the dent.
 */
function printTexture(): THREE.CanvasTexture {
  const W = 256, H = 125;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const rect = (x: number, y: number, w: number, h: number, r: number): void => {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  };
  const L = W * 0.06, T = H * 0.1, FW = W * 0.88, FH = H * 0.8;
  g.filter = 'blur(1.5px)';
  // the dent: one dark rectangle
  g.fillStyle = 'rgba(38, 18, 7, 0.85)';
  rect(L, T, FW, FH, 6); g.fill();
  // treads across the sole
  g.fillStyle = 'rgba(255, 215, 165, 0.3)';
  for (let i = 0; i < 5; i++) g.fillRect(L + FW * (0.26 + i * 0.09), T + 6, 3, FH - 12);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** The mech's footprints in the sand: a dent for every step, lying on the dune and turned the way the foot points. */
export class Footprints {
  private readonly mesh: THREE.InstancedMesh;
  private count = 0;
  private next = 0;
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(LENGTH, WIDTH).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: printTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      MAX,
    );
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /** a print at (x, z), the foot pointing along `yaw` (the lower body's turn: 0 = toe to the left), `strength` 0..1 */
  add(x: number, z: number, yaw: number, strength: number): void {
    const { dummy } = this;
    dummy.position.set(x, terrainHeight(x, z) + 0.025, z);
    dummy.rotation.set(0, yaw, 0);
    const s = 0.85 + 0.15 * Math.min(1, strength);
    dummy.scale.set(s, 1, s);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(this.next, dummy.matrix);
    this.next = (this.next + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void { this.count = this.next = 0; this.mesh.count = 0; }
}
