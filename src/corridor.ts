import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DOOR_H, DOOR_W, PORTAL_D } from './blastDoor';

/** how far into the dune the first hall runs, and the spacing of its fittings (world units) */
export const CORRIDOR_LENGTH = 132;
const RIB_EVERY = 11, LAMP_EVERY = 11, BULKHEAD_EVERY = 44;
/** the lamps that really light the hall: the nearest few to the camera carry a light */
const LIGHTS = 4;

const mat = (color: number, rough = 0.85, metal = 0.2, emissive = 0x000000, ei = 1): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei });

/** boxes collected per material and merged, so a hall of hundreds of fittings is a handful of draw calls */
class Batch {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  box(m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): void {
    this.add(m, new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  }
  /** a pipe along x */
  pipe(m: THREE.Material, r: number, x0: number, x1: number, y: number, z: number): void {
    this.add(m, new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), 10).rotateZ(Math.PI / 2).translate((x0 + x1) / 2, y, z));
  }
  private add(m: THREE.Material, g: THREE.BufferGeometry): void {
    const list = this.parts.get(m) ?? [];
    list.push(g);
    this.parts.set(m, list);
  }
  build(into: THREE.Group): void {
    for (const [m, list] of this.parts) {
      const merged = mergeGeometries(list.map((g) => g.toNonIndexed()), false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, m);
      mesh.receiveShadow = true;
      into.add(mesh);
    }
  }
}

/**
 * The first hall behind the blast doors: a long concrete and steel corridor cut into the dune, as wide as the doors and as high, seen from the
 * front with its camera-side wall cut away like a stage set (a heavy fascia hides what is above the ceiling). Ribs and bulkhead beams march down it,
 * pipes and cable trays run along the ceiling, lamps hang between the ribs, and at the far end a second set of doors is shut. Everything is built
 * in world coordinates, floor at `floorY`, and a few real lights follow the camera from lamp to lamp.
 */
/** a lamp that can be shot out: its glowing part, which lamp (by x) it belongs to, whether it still burns, and the pendant it hangs from, if any */
interface Tube { mesh: THREE.Mesh; lamp: number; alive: boolean; pivot?: THREE.Group }

export class Corridor {
  readonly group = new THREE.Group();
  /** x of the mouth (just inside the portal) and of the end wall; z of the middle; the hall's floor and ceiling height */
  readonly x0: number;
  readonly x1: number;
  readonly floorY: number;
  private readonly lights: THREE.PointLight[] = [];
  private readonly lamps: number[] = [];
  /** the lamp tubes, and the shattered look they take */
  private readonly tubes: Tube[] = [];
  private readonly dead = mat(0x1a1c1e, 0.6, 0.3);
  private readonly box = new THREE.Box3();
  /** pendants swinging after a hit */
  private readonly swinging: { pivot: THREE.Group; amp: number; phase: number }[] = [];
  private t = 0;
  private readonly pendants: THREE.Group[] = [];
  /** the solid things hanging from the ceiling (girders, pipes, ribs, beams): what a bullet at the ceiling actually meets */
  private readonly ceilBoxes: THREE.Box3[] = [];
  private readonly tmpHit = new THREE.Vector3();

  private readonly zc: number;

  constructor(scene: THREE.Scene, doorX: number, zc: number, floorY: number) {
    this.zc = zc;
    this.x0 = doorX - PORTAL_D;
    this.x1 = this.x0 - CORRIDOR_LENGTH;
    this.floorY = floorY;
    const { x0, x1 } = this;
    const hw = DOOR_W / 2, H = DOOR_H, zf = zc - hw, zn = zc + hw;           // far wall z, near (open) edge z
    const len = x0 - x1, mid = (x0 + x1) / 2;
    const y = floorY;

    const concrete = mat(0x6d7370, 0.95, 0.05, 0x14181a);
    const concreteDark = mat(0x4b514f, 0.95, 0.05, 0x0c0f10);
    const steel = mat(0x59616a, 0.5, 0.65, 0x101215);
    const steelDark = mat(0x2c3238, 0.55, 0.6);
    const floorMat = mat(0x373b3e, 0.7, 0.4);
    const grating = mat(0x23272a, 0.6, 0.5);
    const yellow = mat(0xc9a21a, 0.7, 0.1, 0x3a2e00);
    const lampMat = mat(0xdfeeff, 0.4, 0, 0xcfe4ff, 3.2);
    const redLamp = mat(0xff3020, 0.5, 0, 0xff2010, 2.4);
    const screenMat = mat(0x0a2a1c, 0.4, 0, 0x28ff90, 1.4);
    const pipeMat = mat(0x7d4f33, 0.6, 0.5, 0x1a0d06);
    const pipeGrey = mat(0x8a929a, 0.45, 0.7, 0x15181b);
    const trayMat = mat(0x3a4046, 0.6, 0.6);

    const b = new Batch();
    const hang = (w: number, h: number, d: number, x: number, yy: number, zz: number): void => {
      this.ceilBoxes.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, yy, zz), new THREE.Vector3(w, h, d)));
    };
    // floor: a steel plate floor with seams, a yellow walking line either side of the middle, and a grating gutter under the far wall
    b.box(floorMat, len, 0.6, DOOR_W + 1, mid, y - 0.3, zc + 0.5);
    for (let x = x0 - 5; x > x1; x -= 5.5) b.box(grating, 0.07, 0.02, DOOR_W, x, y + 0.012, zc);
    for (const dz of [-2.3, 2.3]) b.box(yellow, len, 0.02, 0.18, mid, y + 0.015, zc + dz);
    b.box(grating, len, 0.03, 1.2, mid, y + 0.02, zf + 1.4);
    // the lip of the floor toward the camera, and a hazard-yellow kerb
    b.box(steelDark, len, 0.5, 0.5, mid, y - 0.1, zn + 0.45);
    b.box(yellow, len, 0.06, 0.25, mid, y + 0.17, zn + 0.45);

    // ceiling slab, the long girders under it, and the fascia above it that hides the sky
    b.box(concreteDark, len, 0.9, DOOR_W + 2, mid, y + H + 0.45, zc);
    for (const dz of [-6.5, 0, 6.5]) { b.box(steel, len, 0.5, 0.7, mid, y + H - 0.25, zc + dz); hang(len, 0.5, 0.7, mid, y + H - 0.25, zc + dz); }
    b.box(concrete, len, 3.2, 1.0, mid, y + H + 2.5, zn + 0.6);
    b.box(yellow, len, 0.3, 0.1, mid, y + H + 1.1, zn + 0.05);
    for (let x = x0 - 3; x > x1; x -= 8) b.box(concreteDark, 0.35, 3.2, 1.1, x, y + H + 2.5, zn + 0.6);   // buttress lines on the fascia

    // the far wall: a dark dado, panels with their grooves, a pipe run, vents and monitors
    b.box(concrete, len, H + 1, 1.4, mid, y + (H + 1) / 2, zf - 0.7);
    b.box(concreteDark, len, 1.6, 0.25, mid, y + 0.8, zf + 0.05);
    b.box(yellow, len, 0.14, 0.05, mid, y + 1.7, zf + 0.2);
    for (let x = x0 - 2.7; x > x1; x -= 5.5) {
      b.box(concreteDark, 0.16, H - 1.6, 0.14, x, y + 1.6 + (H - 1.6) / 2, zf + 0.1);
      b.box(steelDark, 2.2, 1.0, 0.12, x - 2.75, y + 3.1, zf + 0.1);                // a vent
      for (let k = 0; k < 4; k++) b.box(grating, 1.9, 0.07, 0.05, x - 2.75, y + 2.75 + k * 0.25, zf + 0.18);
    }
    b.pipe(pipeMat, 0.34, x0, x1, y + 5.3, zf + 0.55);
    b.pipe(pipeGrey, 0.22, x0, x1, y + 4.65, zf + 0.5);
    b.pipe(pipeGrey, 0.16, x0, x1, y + 4.25, zf + 0.46);
    b.box(trayMat, len, 0.12, 0.7, mid, y + 6.35, zf + 0.55);                       // a cable tray high on the wall
    for (let x = x0 - 14; x > x1 - 1; x -= 22) {
      b.box(steelDark, 2.4, 1.5, 0.2, x, y + 3.9, zf + 0.12);                       // a monitor wall
      b.box(screenMat, 2.0, 1.1, 0.06, x, y + 3.9, zf + 0.25);
    }

    // ceiling: pipes and trays along it, and the ribs across it every so often
    b.pipe(pipeMat, 0.3, x0, x1, y + H - 0.85, zc + 4.3); hang(len, 0.6, 0.6, mid, y + H - 0.85, zc + 4.3);
    b.pipe(pipeGrey, 0.2, x0, x1, y + H - 0.8, zc + 3.4); hang(len, 0.4, 0.4, mid, y + H - 0.8, zc + 3.4);
    b.pipe(pipeGrey, 0.24, x0, x1, y + H - 0.9, zc - 4.6); hang(len, 0.48, 0.48, mid, y + H - 0.9, zc - 4.6);
    b.box(trayMat, len, 0.12, 1.1, mid, y + H - 0.7, zc - 7.6); hang(len, 0.12, 1.1, mid, y + H - 0.7, zc - 7.6);
    for (let x = x0 - RIB_EVERY / 2; x > x1; x -= RIB_EVERY) {
      b.box(steel, 0.7, 0.85, DOOR_W, x, y + H - 0.42, zc);                          // a rib across the ceiling
      hang(0.7, 0.85, DOOR_W, x, y + H - 0.42, zc);
      b.box(steel, 0.85, H, 0.8, x, y + H / 2, zf + 0.5);                            // and the column it stands on, against the far wall
      b.box(yellow, 0.88, 0.5, 0.82, x, y + 0.45, zf + 0.5);
    }
    // heavy bulkhead beams (the ceiling steps down, hazard-striped) every so often
    for (let x = x0 - BULKHEAD_EVERY; x > x1; x -= BULKHEAD_EVERY) {
      b.box(steel, 1.6, 1.6, DOOR_W, x, y + H - 0.8, zc);
      hang(1.6, 1.6, DOOR_W, x, y + H - 0.8, zc);
      b.box(yellow, 1.62, 0.28, DOOR_W, x, y + H - 1.7, zc);
      b.box(redLamp, 0.2, 0.3, 0.6, x + 0.85, y + H - 1.2, zc + 2.5);
      b.box(redLamp, 0.2, 0.3, 0.6, x + 0.85, y + H - 1.2, zc - 2.5);
    }
    // lamps: long tubes hanging between the ribs, in two rows
    for (let x = x0 - LAMP_EVERY; x > x1 + 2; x -= LAMP_EVERY) {
      this.lamps.push(x);
      for (const dz of [-3.6, 3.6]) {
        b.box(steelDark, 3.4, 0.14, 0.5, x, y + H - 1.15, zc + dz);
        const tube = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.1, 0.34), lampMat);
        tube.position.set(x, y + H - 1.25, zc + dz);
        this.group.add(tube);
        this.tubes.push({ mesh: tube, lamp: x, alive: true });
      }
    }

    // the far end: a second pair of blast doors, shut, and a warning above them
    const ex = x1 + 1;
    b.box(concrete, 2.0, H + 1, DOOR_W + 2, ex - 0.6, y + (H + 1) / 2, zc);
    b.box(steel, 1.0, H - 0.6, DOOR_W - 3, ex + 0.2, y + (H - 0.6) / 2 + 0.2, zc);
    b.box(steelDark, 0.3, H - 1.4, 0.4, ex + 0.8, y + (H - 1.4) / 2 + 0.3, zc);
    for (const s of [-1, 1]) {
      b.box(yellow, 0.3, H - 0.6, 0.9, ex + 0.75, y + (H - 0.6) / 2 + 0.2, zc + s * (DOOR_W / 2 - 2.6));
      b.box(redLamp, 0.3, 0.5, 0.5, ex + 0.9, y + H - 1.4, zc + s * 3.2);
    }
    for (let i = 0; i < 4; i++) b.box(yellow, 0.2, 0.5, DOOR_W - 3, ex + 0.75, y + 0.8 + i * 1.2, zc);

    b.build(this.group);
    this.group.traverse((o) => { if (o instanceof THREE.Mesh) o.matrixAutoUpdate = false; });
    // pendant lamps on chains, hanging low over the mech's lane: something to shoot at
    const bulbMat = mat(0xffe2a0, 0.3, 0, 0xffc060, 3);
    const chainMat = mat(0x20262b, 0.6, 0.6);
    const cageMat = mat(0x3a4046, 0.5, 0.7);
    let n = 0;
    for (let x = x0 - LAMP_EVERY / 2 - 5.5; x > x1 + 4; x -= LAMP_EVERY / 2) {
      const z = zc + [1.2, -3.2, 4.2, -0.5][n++ % 4];
      const drop = 2.6 + (n % 3) * 0.4;
      const pivot = new THREE.Group();
      pivot.position.set(x, y + H - 0.1, z);
      const chain = new THREE.Mesh(new THREE.BoxGeometry(0.06, drop, 0.06), chainMat);
      chain.position.y = -drop / 2;
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.6, 0.45, 10, 1, true), cageMat);
      shade.position.y = -drop + 0.2;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), bulbMat);
      bulb.position.y = -drop - 0.1;
      pivot.add(chain, shade, bulb);
      this.group.add(pivot);
      this.tubes.push({ mesh: bulb, lamp: NaN, alive: true, pivot });
      this.pendants.push(pivot);
    }
    scene.add(this.group);

    for (let i = 0; i < LIGHTS; i++) {
      const l = new THREE.PointLight(0xcfe4ff, 0, 30, 1.7);
      l.position.set(0, y + H - 1.8, zc);
      scene.add(l);
      this.lights.push(l);
    }
  }

  /** where a ray meets the hall's shell (the far wall, the ceiling, the end wall): distance, point in `out`, or Infinity */
  raycastShell(ray: THREE.Ray, out: THREE.Vector3): number {
    const o = ray.origin, d = ray.direction;
    const zf = this.zc - DOOR_W / 2 + 0.1, top = this.floorY + DOOR_H, endX = this.x1 + 1.3;
    let best = Infinity;
    const tryT = (t: number): void => {
      if (!(t > 0) || t >= best) return;
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (x > this.x0 || x < this.x1 || y < this.floorY - 0.01 || y > top + 0.01 || z < zf - 0.01 || z > this.zc + DOOR_W / 2) return;
      best = t; out.set(x, y, z);
    };
    // the fascia over the open front: the ceiling's edge and the band above it, face on to the camera
    if (d.z < 0) {
      const zr = this.zc + DOOR_W / 2 + 1.1, t = (zr - o.z) / d.z, y = o.y + d.y * t, x = o.x + d.x * t;
      if (t > 0 && y >= top - 0.01 && y <= top + 4.2 && x <= this.x0 && x >= this.x1) { best = t; out.set(x, y, zr); }
    }
    if (d.z < 0) tryT((zf - o.z) / d.z);                     // the far wall
    if (d.y > 0) tryT((top - o.y) / d.y);                    // the ceiling
    if (d.x < 0) tryT((endX - o.x) / d.x);                   // the end doors
    // what hangs from the ceiling is in the way of the slab itself
    if (d.y > 0) for (const bx of this.ceilBoxes) {
      if (!ray.intersectBox(bx, this.tmpHit)) continue;
      const t = this.tmpHit.distanceTo(o);
      if (t < best && this.tmpHit.x <= this.x0 && this.tmpHit.x >= this.x1 && this.tmpHit.z >= zf && this.tmpHit.z <= this.zc + DOOR_W / 2) { best = t; out.copy(this.tmpHit); }
    }
    return best;
  }

  /** where a ray meets a lit lamp tube (distance, point in `out`), or Infinity */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    let best = Infinity;
    for (const t of this.tubes) {
      if (!t.alive) continue;
      this.box.setFromObject(t.mesh).expandByScalar(0.12);
      if (ray.intersectBox(this.box, out)) { const d = out.distanceTo(ray.origin); if (d < best) { best = d; this.hitTube = t; } }
    }
    if (best < Infinity && this.hitTube) this.box.setFromObject(this.hitTube.mesh).clampPoint(ray.at(best, out), out);
    return best;
  }
  private hitTube: Tube | null = null;

  /** smash the tube the last ray met; returns where it was */
  breakHit(): THREE.Vector3 | null {
    const t = this.hitTube;
    if (!t || !t.alive) return null;
    this.kill(t);
    return t.mesh.position;
  }

  /** a blast at `at`: every lit tube within `radius` goes out */
  blast(at: THREE.Vector3, radius: number): THREE.Vector3[] {
    const gone: THREE.Vector3[] = [];
    for (const t of this.tubes) if (t.alive && t.mesh.position.distanceTo(at) < radius + 1.5) { this.kill(t); gone.push(t.mesh.position); }
    return gone;
  }

  private kill(t: Tube): void {
    t.alive = false;
    t.mesh.material = this.dead;
    if (t.pivot) this.swinging.push({ pivot: t.pivot, amp: 0.45, phase: 0 });
  }

  /** x is inside the hall (past the doors, short of the end wall) */
  inside(x: number): boolean { return x < this.x0 + 0.5 && x > this.x1; }

  /** where the mech stops: the end doors */
  get stopX(): number { return this.x1 + 8; }

  /** the hall's lights go to the lamps nearest the camera; `power` fades them with the look of the scene (0 outdoors) */
  update(camX: number, power: number, dt = 0): void {
    this.t += dt;
    this.pendants.forEach((p, i) => { p.rotation.z = 0.02 * Math.sin(this.t * 0.9 + i * 1.7); });
    for (let i = this.swinging.length - 1; i >= 0; i--) {
      const w = this.swinging[i];
      w.phase += dt;
      w.amp *= Math.exp(-dt * 0.9);
      w.pivot.rotation.z = w.amp * Math.sin(w.phase * 4.5);
      if (w.amp < 0.01) this.swinging.splice(i, 1);
    }
    const lit = this.lamps.filter((x) => this.tubes.some((t) => t.alive && t.lamp === x));
    const near = lit.sort((a, b) => Math.abs(a - camX) - Math.abs(b - camX)).slice(0, LIGHTS);
    this.lights.forEach((l, i) => {
      const x = near[i];
      if (x !== undefined) l.position.x = x;
      l.intensity = x === undefined ? 0 : 95 * power;
    });
  }
}
