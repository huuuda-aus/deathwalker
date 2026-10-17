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

/** Result of one step: it just went off (the caller sets off the blast), or nothing happened. */
export type BarrelEvent = 'boom' | null;

/**
 * A drum of something explosive. Any hit, or a blast nearby, lights its fuse and it goes up; the caller makes the
 * bang. On an upper floor it stays put until the floor under it is gone, then drops, and goes off if the fall is long.
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

  /** @param building the building whose floor it stands on, or null for one on the ground */
  constructor(pos: THREE.Vector3, readonly building: Building | null) {
    this.group.position.copy(pos);
    this.seenVersion = building?.version ?? -1;
    const body = new THREE.Mesh(BODY_GEO, BODY_MAT);
    body.position.y = H / 2;
    body.castShadow = body.receiveShadow = true;
    const band = new THREE.Mesh(BAND_GEO, BAND_MAT);
    band.position.y = H * 0.55;
    this.group.add(body, band);
    this.group.rotation.y = Math.random() * Math.PI * 2;
  }

  get lit(): boolean { return this.fuse >= 0; }

  /** where the blast is centred: the middle of the drum */
  get blastPoint(): THREE.Vector3 {
    return this.centre.set(this.group.position.x, this.group.position.y + H / 2, this.group.position.z);
  }

  /** Light the fuse (a shorter one wins if it is already burning). */
  ignite(delay = 0): void {
    if (this.gone) return;
    if (this.fuse < 0 || delay < this.fuse) this.fuse = delay;
  }

  /** Distance along the ray to this barrel (Infinity if missed or gone). */
  raycast(ray: THREE.Ray, out: THREE.Vector3): number {
    if (this.gone) return Infinity;
    const p = this.group.position;
    this.box.min.set(p.x - R - 0.02, p.y, p.z - R - 0.02);
    this.box.max.set(p.x + R + 0.02, p.y + H + 0.02, p.z + R + 0.02);
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
    if (this.fuse > 0) return null;
    this.gone = true;
    this.group.visible = false;
    return 'boom';
  }
}
