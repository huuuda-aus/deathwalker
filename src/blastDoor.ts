import * as THREE from 'three';
import type { Debris } from './debris';
import type { Dust } from './dust';
import type { Fx } from './fx';
import type { Wreckage } from './wreckage';
import { BLAST_DOOR } from './config';

/** the doors: three times wider than they are high */
export const DOOR_H = 7;
export const DOOR_W = DOOR_H * 3;
/** the concrete mouth of the tunnel they are set in: how high and how deep (into the dune) */
const PORTAL_H = 9.2;
export const PORTAL_D = 6;
/** the doors stand across the street, this far toward the far side from the middle of the road (z) */
export const DOOR_OFFSET_Z = -3;

const shared = <T extends THREE.Material>(m: T): T => { m.userData.shared = true; return m; };
const CONCRETE = shared(new THREE.MeshStandardMaterial({ color: 0x9a9486, roughness: 0.95, emissive: 0x2a2218, emissiveIntensity: 1 }));
const CONCRETE_DARK = shared(new THREE.MeshStandardMaterial({ color: 0x77726a, roughness: 0.95, emissive: 0x1f1a12, emissiveIntensity: 1 }));
const VOID = shared(new THREE.MeshStandardMaterial({ color: 0x060708, roughness: 1 }));
const HAZARD = shared(new THREE.MeshStandardMaterial({
  map: (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#e8c21a'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#141414';
    for (let i = -128; i < 256; i += 36) { g.beginPath(); g.moveTo(i, 128); g.lineTo(i + 18, 128); g.lineTo(i + 18 + 128, 0); g.lineTo(i + 128, 0); g.closePath(); g.fill(); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(6, 1);
    return t;
  })(),
  roughness: 0.7,
}));

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cylinder(r: number, len: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16).rotateZ(Math.PI / 2), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** what a door needs from the world: somewhere for the flung pieces to go, the dust and sparks, the blasts of its going, and the shaking of the screen */
export interface DoorEnv {
  wreck: Wreckage;
  dust: Dust;
  debris: Debris;
  fx: () => Fx;
  /** a blast at a point: the explosion with its fire and its harm */
  blast: (at: THREE.Vector3, radius: number, scale: number) => void;
  shake: (x: number, amount: number) => void;
}

const tmp = new THREE.Vector3();
const HOT = new THREE.Color(0xff4a10);

/**
 * The bunker's blast doors: a vast pair of riveted steel leaves, three times wider than they are high, closed, in the reinforced concrete mouth
 * of a tunnel cut into the side of a big dune. They have hit points: a bullet barely scratches them, a blast does the real harm. As they weaken the
 * steel scorches and buckles, the beacons start to flash, and smoke and sparks pour from the seam; at the end a chain of blasts blows the leaves
 * in off their rails and the tunnel stands open.
 *
 * The group is built facing +z with its origin at the middle of the foot of the front face; `place` turns it to face the mech (who walks
 * toward -x) and puts it where it stands.
 */
export class BlastDoor {
  readonly group = new THREE.Group();
  readonly maxHp = BLAST_DOOR.hp;
  hp: number = BLAST_DOOR.hp;
  breached = false;
  /** world-space box of the doors' face */
  readonly box = new THREE.Box3();
  private readonly leaves: THREE.Group[] = [];
  private readonly leafMat = new THREE.MeshStandardMaterial({ color: 0x5c636a, roughness: 0.5, metalness: 0.6, emissive: 0x1c1f22, emissiveIntensity: 1 });
  private readonly ribMat = new THREE.MeshStandardMaterial({ color: 0x929aa2, roughness: 0.45, metalness: 0.6, emissive: 0x24272b, emissiveIntensity: 1 });
  private readonly amber = new THREE.MeshStandardMaterial({ color: 0xffb040, emissive: 0xff9020, emissiveIntensity: 3 });
  private readonly red = new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 2.5 });
  private t = 0;
  private smokeT = 0;
  /** the breach in progress: seconds into it (negative = not begun) and how many of its blasts have gone */
  private breachT = -1;
  private blasts = 0;
  private cx = 0;
  private baseX = 0;

  constructor(private readonly env: DoorEnv) {
    const g = this.group;
    const hw = DOOR_W / 2;

    // the portal: a reinforced concrete mouth to the tunnel: a heavy lintel, a jamb either side, and retaining wings stepping down the cut face of
    // the dune, which rises round and over it (the rest is sand: see terrain.ts)
    const JAMB = 2.4;
    for (const s of [-1, 1]) {
      g.add(box(JAMB, PORTAL_H, PORTAL_D, CONCRETE, s * (hw + JAMB / 2), PORTAL_H / 2, -PORTAL_D / 2));
      const x0 = hw + JAMB;
      [[3.2, 7.2, 2.4], [3.4, 4.6, 2.0], [3.6, 2.4, 1.6]].forEach(([w, h, d], i) => {                       // the wings, each lower and thinner than the last
        g.add(box(w, h, d, i % 2 ? CONCRETE_DARK : CONCRETE, s * (x0 + [1.6, 4.9, 8.4][i]), h / 2, -d / 2 - 0.2));
      });
      g.add(box(0.7, PORTAL_H - 0.8, 0.5, CONCRETE_DARK, s * (hw + JAMB - 0.5), PORTAL_H / 2, 0.15));         // a pilaster on the jamb
    }
    g.add(box(DOOR_W + 2 * JAMB, PORTAL_H - DOOR_H, PORTAL_D, CONCRETE, 0, DOOR_H + (PORTAL_H - DOOR_H) / 2, -PORTAL_D / 2));
    g.add(box(DOOR_W + 2 * JAMB + 0.8, 0.5, 0.6, CONCRETE_DARK, 0, PORTAL_H + 0.1, 0.1));                    // the cornice

    // behind the doors: black
    g.add(box(DOOR_W, DOOR_H, 1.5, VOID, 0, DOOR_H / 2, -PORTAL_D + 1));

    // the steel frame the doors close in
    g.add(box(DOOR_W + 1.6, 0.9, 1.4, this.ribMat, 0, DOOR_H + 0.45, -0.4));
    for (const s of [-1, 1]) g.add(box(0.9, DOOR_H + 0.9, 1.4, this.ribMat, s * (hw + 0.4), (DOOR_H + 0.9) / 2, -0.4));
    g.add(box(DOOR_W, 0.55, 0.12, HAZARD, 0, DOOR_H + 0.5, 0.33));

    // the two leaves, each a group so it can be thrown off whole
    const LEAF_W = DOOR_W / 2 - 0.15, LEAF_H = DOOR_H - 0.2;
    const rivetGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.08, 8).rotateX(Math.PI / 2);
    const mat = new THREE.Matrix4();
    for (const s of [-1, 1]) {
      const leaf = new THREE.Group();
      const cx = s * (LEAF_W / 2 + 0.15);
      leaf.add(box(LEAF_W, LEAF_H, 0.9, this.leafMat, cx, LEAF_H / 2 + 0.1, -1.1));
      for (const y of [1.6, 3.5, 5.4]) leaf.add(box(LEAF_W - 0.6, 0.35, 0.22, this.ribMat, cx, y, -0.55));                  // the horizontal ribs
      for (const dx of [-0.34, 0.34]) leaf.add(box(0.4, LEAF_H - 0.8, 0.2, this.ribMat, cx + dx * LEAF_W, LEAF_H / 2 + 0.1, -0.56));   // the stiffeners
      leaf.add(box(LEAF_W, 0.9, 0.12, HAZARD, cx, 0.65, -0.62));                                                           // hazard stripes along the foot
      const rivets = new THREE.InstancedMesh(rivetGeo, this.ribMat, 5 * 18);
      let n = 0;
      for (let r = 0; r < 5; r++) for (let c = 0; c < 18; c++) {
        mat.makeTranslation(cx + ((c + 0.5) / 18 - 0.5) * (LEAF_W - 0.5), 1.15 + r * 1.2, -0.62);
        rivets.setMatrixAt(n++, mat);
      }
      rivets.castShadow = true;
      leaf.add(rivets);
      g.add(leaf);
      this.leaves.push(leaf);
    }

    // the seam, and the locking bolts across it
    g.add(box(0.3, LEAF_H, 1.1, VOID, 0, LEAF_H / 2 + 0.1, -1.1));
    for (let i = 0; i < 6; i++) g.add(cylinder(0.26, 2.6, this.ribMat, 0, 0.9 + i * 1.0, -0.5));

    // rams at the jambs, and the sill
    for (const s of [-1, 1]) {
      for (const dy of [1.4, 5.0]) {
        g.add(cylinder(0.5, 3.4, this.leafMat, s * (hw - 1.4), dy, -0.3));
        g.add(cylinder(0.25, 1.8, this.ribMat, s * (hw - 3.9), dy, -0.3));
      }
    }
    g.add(box(DOOR_W + 6, 0.35, 0.5, this.ribMat, 0, 0.2, 0.7));

    // beacons over the door
    for (const s of [-1, 1]) {
      g.add(box(0.8, 0.6, 0.6, this.amber, s * 6.5, PORTAL_H - 0.9, 0.35));
      g.add(box(0.8, 0.6, 0.6, this.red, s * 9.2, PORTAL_H - 0.9, 0.35));
    }
  }

  /** stand the doors at (x, y, z), facing +x */
  place(x: number, y: number, z: number): void {
    this.group.rotation.y = Math.PI / 2;
    this.group.position.set(x, y, z);
    this.baseX = x;
    this.cx = z;
    this.box.set(new THREE.Vector3(x - 1.6, y, z - DOOR_W / 2), new THREE.Vector3(x + 0.8, y + DOOR_H, z + DOOR_W / 2));
  }

  /** how far the doors have weakened: 0 whole .. 1 about to go */
  get damageShare(): number { return 1 - Math.max(0, this.hp) / this.maxHp; }

  /** where a ray meets the doors (distance, point in `out`), or Infinity */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    if (this.breached || !ray.intersectBox(this.box, tmp)) return Infinity;
    out.copy(tmp);
    return tmp.distanceTo(ray.origin);
  }

  /** a blast at `at` reaching `radius`: the doors take what is left of it where they are */
  blast(at: THREE.Vector3, radius: number): void {
    if (this.breached) return;
    const d = this.box.distanceToPoint(at);
    if (d <= radius) this.damage(BLAST_DOOR.blastPower * (1 - d / radius), at);
  }

  damage(n: number, at: THREE.Vector3): void {
    if (this.breached) return;
    this.hp -= n;
    this.scorch();
    if (this.hp <= 0) this.breach(at);
  }

  /** (testing) the doors stand open without ceremony: no leaves, no blasts */
  open(): void {
    this.breached = true;
    this.hp = 0;
    this.leaves.forEach((l) => { l.visible = false; });
    this.amber.emissiveIntensity = this.red.emissiveIntensity = 0.05;
  }

  /** the steel darkens and glows with the heat as the doors weaken */
  private scorch(): void {
    const k = this.damageShare;
    this.leafMat.color.setHex(0x5c636a).lerp(new THREE.Color(0x1e1d1c), Math.min(1, k * 1.2));
    this.leafMat.emissive.setHex(0x1c1f22).lerp(HOT, Math.max(0, k - 0.45) * 0.55);
    this.ribMat.color.setHex(0x929aa2).lerp(new THREE.Color(0x45423e), Math.min(1, k));
    // the leaves buckle a little
    this.leaves.forEach((l, i) => { l.rotation.z = (i ? -1 : 1) * 0.012 * k; });
  }

  /** the end: a chain of blasts across the doors, the leaves thrown in off their rails, debris and smoke blown out into the street */
  private breach(at: THREE.Vector3): void {
    this.breached = true;
    this.breachT = 0;
    this.blasts = 0;
    this.leafMat.emissive.setHex(0xff3a08);
    this.group.updateMatrixWorld(true);
    this.leaves.forEach((leaf, i) => {
      // in, and a little up, and apart
      const vel = new THREE.Vector3(-5 - Math.random() * 2, 3.5 + Math.random() * 2, (i ? 1 : -1) * (1.5 + Math.random() * 1.5));
      const spin = new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.6, (i ? -1 : 1) * (0.6 + Math.random() * 0.6));
      this.env.wreck.fling(leaf, vel, spin, 0.5);
    });
    const { debris, dust } = this.env;
    const palette = [new THREE.Color(0x5c636a), new THREE.Color(0x929aa2), new THREE.Color(0x9a9486), new THREE.Color(0x45423e)];
    for (let i = 0; i < 70; i++) {
      tmp.set(this.baseX + 0.6, this.box.min.y + 0.4 + Math.random() * (DOOR_H - 0.8), this.cx + (Math.random() - 0.5) * DOOR_W * 0.9);
      const vel = new THREE.Vector3(2 + Math.random() * 6, 1 + Math.random() * 5, (Math.random() - 0.5) * 5);
      debris.spawn(tmp, palette[i % palette.length], 0.08 + Math.random() * 0.2, vel);
    }
    for (let i = 0; i < 30; i++) {
      tmp.set(this.baseX + 0.5, this.box.min.y + Math.random() * DOOR_H, this.cx + (Math.random() - 0.5) * DOOR_W);
      dust.billow(tmp, new THREE.Vector3(1 + Math.random() * 4, 0.3 + Math.random() * 1.2, (Math.random() - 0.5) * 3), 0.8 + Math.random(), 2.5 + Math.random() * 2, 0.6, 0.5, 0.6);
    }
    this.env.shake(this.baseX, 1.2);
    void at;
  }

  update(dt: number): void {
    this.t += dt;
    const k = this.damageShare;
    // the beacons: steady while whole, then flashing faster and faster, dark once it is gone
    if (this.breached) {
      this.amber.emissiveIntensity = this.red.emissiveIntensity = 0.05;
    } else if (k > 0.25) {
      const flash = 0.5 + 0.5 * Math.sin(this.t * (6 + 12 * k));
      this.amber.emissiveIntensity = 0.4 + 3 * flash;
      this.red.emissiveIntensity = 0.4 + 3 * (1 - flash);
    }
    const { dust } = this.env;
    // a weakened door smokes and sparks along the seam
    if (!this.breached && k > 0.5) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.smokeT = 0.35 - 0.25 * k;
        tmp.set(this.baseX + 0.9, this.box.min.y + 0.5 + Math.random() * (DOOR_H - 1), this.cx + (Math.random() - 0.5) * 1.2);
        dust.puff(tmp, 2, 0.5, 1.4);
        this.env.fx().sparks(tmp, 6, 3, [0xffd080, 0xff8030, 0xffffff]);
      }
    }
    // the breach: blasts go off one after another across the doors
    if (this.breachT >= 0) {
      this.breachT += dt;
      const due = Math.min(BLAST_DOOR.breachBlasts, Math.floor((this.breachT / BLAST_DOOR.breachTime) * BLAST_DOOR.breachBlasts) + 1);
      while (this.blasts < due) {
        this.blasts++;
        tmp.set(this.baseX + 0.8, this.box.min.y + 1 + Math.random() * (DOOR_H - 2), this.cx + (Math.random() - 0.5) * DOOR_W * 0.85);
        this.env.blast(tmp, BLAST_DOOR.breachRadius, BLAST_DOOR.breachScale);
        this.env.shake(this.baseX, 0.9);
      }
      if (this.blasts >= BLAST_DOOR.breachBlasts && this.breachT > BLAST_DOOR.breachTime + 0.5) this.breachT = -1;
    }
  }
}
