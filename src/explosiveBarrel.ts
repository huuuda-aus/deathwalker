import * as THREE from 'three';
import type { Building } from './building';
import { EXPLOSIVE_BARREL } from './config';

const R = 0.14, H = 0.46;
/** near-black steel with a dull, barely-there red band: it should read as scenery until it goes up */
const BODY_MAT = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.65, metalness: 0.5 });
const BAND_MAT = new THREE.MeshStandardMaterial({ color: 0x2a1311, roughness: 0.7, metalness: 0.3 });
const BODY_GEO = new THREE.CylinderGeometry(R, R * 0.95, H, 12);
const BAND_GEO = new THREE.CylinderGeometry(R * 1.03, R * 1.03, 0.07, 12);
const GRAVITY = 12;
/** an ammunition crate: olive-painted wood with a darker lid, a stencilled band and rope handles */
const CRATE_W = 0.38, CRATE_H = 0.22, CRATE_D = 0.24;
const CRATE_WOOD = new THREE.MeshStandardMaterial({ color: 0x4d5733, roughness: 0.85 });
const CRATE_LID = new THREE.MeshStandardMaterial({ color: 0x3a4326, roughness: 0.9 });
const CRATE_BAND = new THREE.MeshStandardMaterial({ color: 0xd8c25a, roughness: 0.8 });
const CRATE_METAL = new THREE.MeshStandardMaterial({ color: 0x25272a, roughness: 0.5, metalness: 0.6 });
/** what it is: a drum of something explosive, or a crate of ammunition (which cooks off for a moment, popping, before it goes up) */
export type BarrelKind = 'drum' | 'crate';
/** a crate takes this long to cook off at the least */
const CRATE_FUSE = 0.45;

/** Result of one step: it just went off (the caller sets off the blast), or nothing happened. */
export type BarrelEvent = 'boom' | 'pop' | null;

/**
 * A drum of something explosive, or a crate of ammunition. Any hit, or a blast nearby, lights its fuse and it goes up; the caller makes the
 * bang (a crate pops first, rounds cooking off, and then goes up). On an upper floor it stays put until the floor under it is gone, then drops, and goes off if the fall is long.
 */
export class ExplosiveBarrel {
  readonly group = new THREE.Group();
  gone = false;
  /** seconds until it goes off; negative = not lit */
  private fuse = -1;
  private falling = false;
  private fallFrom = 0;
  private vy = 0;
  private seenVersion = -1;
  private readonly box = new THREE.Box3();
  private readonly centre = new THREE.Vector3();
  private readonly half: number;
  private readonly height: number;
  private popT = 0;

  /** @param building the building whose floor it stands on, or null for one on the ground */
  constructor(pos: THREE.Vector3, readonly building: Building | null, readonly kind: BarrelKind = 'drum') {
    this.group.position.copy(pos);
    this.seenVersion = building?.version ?? -1;
    this.half = kind === 'crate' ? CRATE_W / 2 : R;
    this.height = kind === 'crate' ? CRATE_H : H;
    if (kind === 'crate') { this.buildCrate(); return; }
    const body = new THREE.Mesh(BODY_GEO, BODY_MAT);
    body.position.y = H / 2;
    body.castShadow = body.receiveShadow = true;
    const band = new THREE.Mesh(BAND_GEO, BAND_MAT);
    band.position.y = H * 0.55;
    this.group.add(body, band);
    this.group.rotation.y = Math.random() * Math.PI * 2;
  }

  private buildCrate(): void {
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      return m;
    };
    this.group.add(
      box(CRATE_W, CRATE_H, CRATE_D, CRATE_WOOD, 0, CRATE_H / 2, 0),
      box(CRATE_W + 0.02, 0.03, CRATE_D + 0.02, CRATE_LID, 0, CRATE_H - 0.01, 0),
      box(0.05, CRATE_H * 0.7, CRATE_D + 0.012, CRATE_BAND, -CRATE_W * 0.22, CRATE_H * 0.5, 0),                 // the stencilled bands
      box(0.05, CRATE_H * 0.7, CRATE_D + 0.012, CRATE_BAND, CRATE_W * 0.22, CRATE_H * 0.5, 0),
      box(0.1, 0.04, 0.02, CRATE_METAL, 0, CRATE_H * 0.72, CRATE_D / 2 + 0.012),                               // the latch
    );
    this.group.rotation.y = (Math.random() - 0.5) * 1.2;
  }

  get lit(): boolean { return this.fuse >= 0; }

  /** where the blast is centred: the middle of the drum */
  get blastPoint(): THREE.Vector3 {
    return this.centre.set(this.group.position.x, this.group.position.y + this.height / 2, this.group.position.z);
  }

  /** Light the fuse (a shorter one wins if it is already burning). */
  ignite(delay = 0): void {
    if (this.gone) return;
    if (this.kind === 'crate') delay = Math.max(delay, CRATE_FUSE);        // the rounds cook off for a moment first
    if (this.fuse < 0 || delay < this.fuse) this.fuse = delay;
  }

  /** Distance along the ray to this barrel (Infinity if missed or gone). */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    if (this.gone) return Infinity;
    const p = this.group.position;
    this.box.min.set(p.x - this.half - 0.02, p.y, p.z - this.half - 0.02);
    this.box.max.set(p.x + this.half + 0.02, p.y + this.height + 0.02, p.z + this.half + 0.02);
    return ray.intersectBox(this.box, out) ? out.distanceTo(ray.origin) : Infinity;
  }

  /**
   * @param landing highest solid surface under (x, z) at or below y, 0 for the ground (anything standing or falling)
   */
  step(dt: number, landing: (x: number, y: number, z: number) => number): BarrelEvent {
    if (this.gone) return null;
    const p = this.group.position;
    if (this.falling) {
      this.vy -= GRAVITY * dt;
      p.y += this.vy * dt;
      const floor = landing(p.x, p.y + 0.05, p.z);
      if (p.y <= floor) {
        p.y = floor;
        this.falling = false;
        if (this.fallFrom - floor > EXPLOSIVE_BARREL.fallBlast) this.ignite();
      }
    } else if (this.building && this.building.version !== this.seenVersion) {
      // the building changed: is the floor still under it?
      this.seenVersion = this.building.version;
      if (this.building.floorTop(p.x, p.z, p.y + 0.05) < p.y - 0.01 && landing(p.x, p.y + 0.05, p.z) < p.y - 0.01) {
        this.falling = true;
        this.fallFrom = p.y;
        this.vy = 0;
      }
    }
    if (this.fuse < 0) return null;
    this.fuse -= dt;
    if (this.fuse > 0) {
      // a crate pops as the rounds in it cook off: a stutter of little bangs, quicker and quicker
      if (this.kind === 'crate') {
        this.popT -= dt;
        if (this.popT <= 0) { this.popT = 0.05 + Math.random() * 0.1; return 'pop'; }
      }
      return null;
    }
    this.gone = true;
    this.group.visible = false;
    return 'boom';
  }
}
