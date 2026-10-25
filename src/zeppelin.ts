import * as THREE from 'three';
import type { Fx } from './fx';
import { METAL_IMPACT, type Enemy } from './enemies';
import type { Explosions } from './explosions';
import type { Dust } from './dust';
import type { Debris, FloorFn } from './debris';
import { LANE } from './mech';
import { ZEPPELIN } from './config';
import { box } from './cannonParts';
import { sfx } from './sfx';

// it hangs far up in the dark with nothing to light its belly: a faint glow of its own, and no fog, keeps it a pale shape against the sky
const SKIN = new THREE.MeshStandardMaterial({ color: 0xdde2e7, roughness: 0.75, metalness: 0.1, emissive: 0x2c343c, emissiveIntensity: 1.8, fog: false });
const BAND = new THREE.MeshStandardMaterial({ color: 0xbcc2c8, roughness: 0.7, metalness: 0.2 , emissive: 0x1a2026, fog: false });
const KEEL = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.7, metalness: 0.3 , emissive: 0x1a2026, fog: false });
const HATCH = new THREE.MeshStandardMaterial({ color: 0x8f969d, roughness: 0.6, metalness: 0.4 , emissive: 0x1a2026, fog: false });
const RECESS = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 1, fog: false });
const GLASS = new THREE.MeshStandardMaterial({ color: 0x3d4a56, roughness: 0.3, metalness: 0.5 , emissive: 0x1a2026, fog: false });
const CHAR = new THREE.Color(0x1c1d1f);
const FIRE = [0xfff2c0, 0xffa030, 0xff5a10, 0x553311];

type State = 'arrive' | 'drop' | 'leave' | 'burn' | 'fall' | 'down';

const ease = (t: number): number => t * t * (3 - 2 * t);
const range = (r: readonly [number, number]): number => r[0] + Math.random() * (r[1] - r[0]);
const tmp = new THREE.Vector3();

export interface ZeppelinDeps {
  explosions: Explosions;
  dust: Dust;
  debris: Debris;
  floor: FloorFn;
  /** where the camera is (x), and the height of the top of the view at depth z */
  camX: () => number;
  viewTop: (z: number) => number;
  /** a paratrooper leaves the hatch: from (x, y, z), heading for lane z `laneZ` */
  spawnTrooper: (x: number, y: number, z: number, laneZ: number) => void;
  /** the screen shakes for something happening at x */
  shake: (x: number, amount: number) => void;
}

/**
 * The zeppelin: a vast airship hanging over the battlefield, longer than the screen is wide, so that only its belly shows,
 * bobbing slowly at the top of the view. Hatches under it open one after another and paratroopers drop out of them, then it
 * rises out of sight. It can be shot down, though it takes a great deal of fire: the belly catches fire, the paratroopers still
 * aboard jump at once, a chain of explosions runs along it, and it comes down behind the city in a ball of flame.
 * It is not part of the kill count: only the paratroopers are.
 */
export class ZeppelinUnit implements Enemy {
  readonly group = new THREE.Group();
  readonly impact = METAL_IMPACT;
  /** the airship itself is not scored as a kill that clears the scene */
  counted = true;
  retreating = false;
  gone = false;
  /** stays 0 until it hits the ground, so the manager keeps it while it burns and falls */
  deadTime = 0;
  private hp: number = ZEPPELIN.hp;
  private state: State = 'arrive';
  private t = 0;
  private clock = Math.random() * 20;
  private troopsLeft: number;
  private dropT: number = ZEPPELIN.firstDrop;
  private dropped = 0;
  private readonly envelope: THREE.Mesh;
  private readonly props: THREE.Mesh[] = [];
  private readonly hatches: { slab: THREE.Mesh; open: number; openFor: number }[] = [];
  private readonly parts: THREE.Mesh[] = [];
  private xBase: number;
  private y = ZEPPELIN.bellyY + 9;
  private fallFrom = 0;
  private blastT = 0;
  private fireT = 0;
  private heat = 0;
  private slump = 0;
  /** blasts yet to go off along it as it hits the ground: their delay (s) and where (x) */
  private chain: { t: number; x: number }[] = [];

  constructor(troops: number, private readonly deps: ZeppelinDeps) {
    this.troopsLeft = troops;
    this.xBase = deps.camX();
    this.group.position.set(this.xBase, this.y, ZEPPELIN.z);
    this.envelope = this.build();
  }

  private build(): THREE.Mesh {
    const { length, radius } = ZEPPELIN;
    const a = length / 2;
    const env = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 28), SKIN);
    env.scale.set(a, radius, radius);
    env.position.y = radius;
    env.castShadow = true;
    this.parts.push(env);
    // frame rings round the hull, a keel along the belly
    for (let x = -a + 6; x < a - 4; x += 9) {
      const r = radius * Math.sqrt(1 - (x / a) ** 2);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.14, 6, 40), BAND);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(x, radius, 0);
      this.parts.push(ring);
      this.group.add(ring);
    }
    const keel = box(length * 0.92, 0.3, 1.6, KEEL, 0, 0.12, 0);
    this.parts.push(keel);
    this.group.add(env, keel);
    // the control gondola under the belly, hung on struts, with a window strip
    const gondola = box(7, 1.7, 2.6, SKIN, -3, -1.5, 0);
    this.parts.push(gondola);
    this.group.add(gondola, box(6.2, 0.4, 2.7, GLASS, -3, -1.1, 0), box(0.18, 1.2, 0.18, KEEL, -5.5, -0.5, 0), box(0.18, 1.2, 0.18, KEEL, -0.5, -0.5, 0));
    // engine pods with propellers, hung out either side
    for (const [x, z] of [[-27, 3.6], [-9, -3.6], [9, 3.6], [27, -3.6]] as const) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 3.4, 12).rotateZ(Math.PI / 2), SKIN);
      pod.position.set(x, 1.2, z);
      pod.castShadow = true;
      const prop = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.2, 0.3), KEEL);
      prop.position.set(1.8, 0, 0);
      pod.add(prop);
      this.props.push(prop);
      this.parts.push(pod);
      this.group.add(pod, box(0.2, 1.2, 0.2, KEEL, x, 2.1, z * 0.6));
    }
    // the hatches: a dark recess in the belly, covered by a slab that slides aside
    for (const hx of ZEPPELIN.hatches) {
      this.group.add(box(4.6, 0.08, 2.3, RECESS, hx, 0.12, 0));
      const slab = box(4.6, 0.14, 2.3, HATCH, hx, 0.04, 0);
      this.hatches.push({ slab, open: 0, openFor: 0 });
      this.group.add(slab);
    }
    return env;
  }

  get alive(): boolean { return this.state !== 'burn' && this.state !== 'fall' && this.state !== 'down'; }
  get x(): number { return this.group.position.x; }

  /** the belly and what hangs from it: the part of it that is on screen, and the only part that can be hit */
  getBox(out: THREE.Box3): THREE.Box3 {
    const p = this.group.position;
    out.min.set(p.x - 36, p.y - 2.6, p.z - 3.8);
    out.max.set(p.x + 36, p.y + 3.4, p.z + 3.8);
    return out;
  }

  damage(n: number, fx: Fx): boolean {
    if (!this.alive) return false;
    this.hp -= n;
    if (this.hp > 0) return false;
    this.ignite(fx);
    return true;
  }

  /** It goes up: the paratroopers still aboard jump at once, and it burns. */
  private ignite(fx: Fx): void {
    void fx;
    this.state = 'burn';
    this.t = 0;
    this.fallFrom = this.y;
    this.blastT = 0;
  }

  dispose(): void {
    for (const m of [this.envelope]) m.geometry.dispose();
  }

  /** a paratrooper leaves a hatch (one of them, opened for the purpose) */
  private drop(): void {
    const i = Math.floor(Math.random() * this.hatches.length);
    this.hatches[i].openFor = 1.1;
    const p = this.group.position;
    const laneZ = LANE.zMin + Math.random() * (LANE.zMax - LANE.zMin);
    // he appears at the top edge of the view above his lane (the view is higher the deeper the lane): he comes out of the hatch, as it looks
    const top = this.deps.viewTop(laneZ);
    this.deps.spawnTrooper(p.x + ZEPPELIN.hatches[i] + (Math.random() - 0.5) * 1.2, top + 0.8 + Math.random() * 0.5, laneZ, laneZ);
    this.troopsLeft--;
    this.dropped++;
  }

  update(dt: number, _target: THREE.Vector3, fx: Fx): void {
    void _target;
    const { explosions, dust, debris, floor } = this.deps;
    const g = this.group.position;
    this.t += dt;
    this.clock += dt;
    for (const p of this.props) p.rotation.x += dt * 38;
    // it hangs where the view is, drifting a little across it and bobbing
    this.xBase += (this.deps.camX() - this.xBase) * Math.min(1, dt * 0.6);
    const bob = ZEPPELIN.bob * Math.sin((this.clock / ZEPPELIN.bobPeriod) * Math.PI * 2) + ZEPPELIN.bob * 0.35 * Math.sin(this.clock * 1.3);
    g.x = this.xBase + ZEPPELIN.drift * Math.sin((this.clock / ZEPPELIN.driftPeriod) * Math.PI * 2);

    switch (this.state) {
      case 'arrive':
        this.y = ZEPPELIN.bellyY + 9 * (1 - ease(Math.min(1, this.t / ZEPPELIN.arrive)));
        if (this.t >= ZEPPELIN.arrive) { this.state = 'drop'; this.t = 0; }
        break;
      case 'drop':
        this.y = ZEPPELIN.bellyY;
        this.dropT -= dt;
        if (this.dropT <= 0 && this.troopsLeft > 0 && !this.retreating) { this.drop(); this.dropT = range(ZEPPELIN.dropGap); }
        if ((this.troopsLeft <= 0 && this.dropT < -2.5) || this.retreating) { this.state = 'leave'; this.t = 0; }
        break;
      case 'leave':
        this.y = ZEPPELIN.bellyY + 11 * ease(Math.min(1, this.t / ZEPPELIN.leave));
        if (this.t >= ZEPPELIN.leave) this.gone = true;
        break;
      case 'burn': {
        // on fire along the belly; whoever is aboard jumps; blasts run along it
        this.heat = Math.min(1, this.t / ZEPPELIN.burnTime);
        this.y = this.fallFrom - 0.4 * ease(this.heat);
        this.dropT -= dt;
        if (this.dropT <= 0 && this.troopsLeft > 0) { this.drop(); this.dropT = 0.18; }
        this.blastT -= dt;
        if (this.blastT <= 0) { this.blastT = 0.22 + Math.random() * 0.2; this.blastAlong(0.6 + this.heat); }
        this.flames(fx, dt, 1 + 2 * this.heat);
        this.charring();
        if (this.t >= ZEPPELIN.burnTime) { this.state = 'fall'; this.t = 0; this.fallFrom = this.y; sfx.explosionHuge(g); }
        break;
      }
      case 'fall': {
        // it comes down behind the city, nose first and burning, faster and faster
        const k = Math.min(1, this.t / ZEPPELIN.fallTime);
        this.y = this.fallFrom - (this.fallFrom + 4) * k * k;
        this.slump = 0.16 * k;
        this.flames(fx, dt, 3);
        this.blastT -= dt;
        if (this.blastT <= 0) { this.blastT = 0.2; this.blastAlong(1.2); }
        this.charring();
        if (k >= 1) this.crash(fx);
        break;
      }
      case 'down': {
        this.deadTime += dt;
        for (const c of this.chain) c.t -= dt;
        for (let i = this.chain.length - 1; i >= 0; i--) {
          if (this.chain[i].t > 0) continue;
          const c = this.chain.splice(i, 1)[0];
          explosions.wreckBlast(tmp.set(c.x, 1.5, ZEPPELIN.z), 5 + Math.random() * 2, 6, 1.2, false);
          this.deps.shake(c.x, 0.5);
        }
        this.fireT -= dt;
        if (this.fireT <= 0 && this.deadTime < 6) {
          this.fireT = 0.1;
          const x = g.x + (Math.random() - 0.5) * 60;
          tmp.set(x, 0.5 + Math.random() * 3, ZEPPELIN.z + (Math.random() - 0.5) * 6);
          dust.plume(tmp, 2.2, 5);
          fx.burst(tmp, 3, 2, FIRE, false, 1.6);
        }
        void debris; void floor;
        return;
      }
    }
    g.y = this.y + (this.state === 'drop' || this.state === 'arrive' || this.state === 'leave' ? bob : 0);
    this.group.rotation.z = this.slump;
    // the hatches slide open while a paratrooper goes through, and shut after
    for (const h of this.hatches) {
      h.openFor = Math.max(0, h.openFor - dt);
      h.open += ((h.openFor > 0 ? 1 : 0) - h.open) * Math.min(1, dt * 7);
    }
    this.hatches.forEach((h, i) => { h.slab.position.x = ZEPPELIN.hatches[i] + h.open * 3.2; });
    // a hull that has taken a lot of fire smoulders: faint fires, and smoke, from where it has been hit
    if ((this.state === 'drop' || this.state === 'leave' || this.state === 'arrive') && this.hp < ZEPPELIN.hp * 0.6) {
      const dmg = 1 - this.hp / ZEPPELIN.hp;
      this.flames(fx, dt, (dmg - 0.4) * 2);
    }
    // the engines' drone follows it
    sfx.hold(this, 'zeppelin', { x: g.x, gain: 1 }, 0.2);
  }

  /** a blast somewhere along the belly (in view), a shake with it */
  private blastAlong(power: number): void {
    const p = this.group.position;
    tmp.set(p.x + (Math.random() - 0.5) * 50, p.y + Math.random() * 3.2, ZEPPELIN.z + (Math.random() - 0.5) * 2);
    this.deps.explosions.detonate(tmp, 2.5 * power + 1, 3 * power + 1, 1, false);
    this.deps.shake(tmp.x, 0.12 * power);
  }

  /** flames licking along the belly and black smoke rolling up and away: `rate` is how many per frame-ish */
  private flames(fx: Fx, dt: number, rate: number): void {
    const p = this.group.position;
    this.fireT -= dt;
    if (this.fireT > 0) return;
    this.fireT = 0.07 / Math.max(0.2, rate);
    tmp.set(p.x + (Math.random() - 0.5) * 55, p.y + Math.random() * 2.6, ZEPPELIN.z + (Math.random() - 0.5) * 3);
    fx.burst(tmp, 4, 2.2, FIRE, false, 1.5);
    this.deps.dust.plume(tmp, 1.6, 4);
  }

  /** the skin scorches as it burns */
  private charring(): void {
    const k = Math.min(1, this.heat * 0.9 + (this.state === 'fall' ? 0.5 : 0));
    for (const m of this.parts) {
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat === SKIN || mat === BAND || mat === KEEL) { m.material = mat.clone(); (m.material as THREE.MeshStandardMaterial).color.lerp(CHAR, k * 0.08); }
      else (mat.color).lerp(CHAR, k * 0.08);
    }
  }

  /** It hits the ground behind the city: the hull breaks up in a string of huge blasts, flaming pieces fly, and it is gone but for fire and smoke. */
  private crash(fx: Fx): void {
    const { explosions, debris, floor } = this.deps;
    const p = this.group.position;
    this.state = 'down';
    this.deadTime = 0;
    this.envelope.visible = false;
    for (const c of this.group.children) c.visible = false;
    for (let i = 0; i < 7; i++) this.chain.push({ t: i * 0.22 + Math.random() * 0.1, x: p.x - 30 + i * 10 + (Math.random() - 0.5) * 5 });
    for (let i = 0; i < 46; i++) {
      tmp.set(p.x + (Math.random() - 0.5) * 70, 1 + Math.random() * 3, ZEPPELIN.z + (Math.random() - 0.5) * 5);
      const v = new THREE.Vector3((Math.random() - 0.5) * 8, 4 + Math.random() * 8, (Math.random() - 0.3) * 5);
      debris.spawn(tmp, new THREE.Color(i % 2 ? 0xe2e6ea : 0x3a3d40), 0.1 + Math.random() * 0.2, v, floor);
    }
    explosions.wreckBlast(tmp.set(p.x, 2, ZEPPELIN.z), 9, 9, 1.5, false);
    this.deps.shake(p.x, 1.0);
    fx.muzzleFlash(tmp);
  }
}
