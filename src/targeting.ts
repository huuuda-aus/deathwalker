import * as THREE from 'three';
import type { Enemy } from './enemies';
import type { World } from './world';
import type { Building } from './building';
import type { FireBarrel } from './fire';

export type HitKind = 'enemy' | 'wall' | 'barrel' | 'ground' | 'backdrop';

export interface Hit {
  kind: HitKind;
  point: THREE.Vector3;
  enemy?: Enemy;
  /** the building that was hit (kind 'wall') */
  building?: Building;
  /** the oil barrel that was hit (kind 'barrel') */
  barrel?: FireBarrel;
}

/** Plane behind the far parallax layers, so skyward shots still resolve to a point. */
const BACKDROP_Z = -20;
const box = new THREE.Box3();
const tmp = new THREE.Vector3();

/** Hitscan against the 2.5D world: enemies, destructible walls, ground, backdrop. Nearest wins. */
export function castRay(ray: THREE.Ray, enemies: Enemy[], world: World, out: Hit): Hit {
  let bestT = Infinity;
  out.kind = 'backdrop';
  out.enemy = undefined;
  out.building = undefined;
  out.barrel = undefined;

  // backdrop (always a fallback)
  if (ray.direction.z < 0) {
    const t = (BACKDROP_Z - ray.origin.z) / ray.direction.z;
    if (t > 0) { bestT = t; ray.at(t, out.point); }
  }
  // ground
  if (ray.direction.y < 0) {
    const t = -ray.origin.y / ray.direction.y;
    if (t > 0 && t < bestT) { bestT = t; out.kind = 'ground'; ray.at(t, out.point); }
  }
  // walls
  const wt = world.raycast(ray, tmp);
  if (wt < bestT) { bestT = wt; out.kind = 'wall'; out.point.copy(tmp); out.building = world.lastBuilding ?? undefined; }
  // oil barrels
  const bt = world.raycastBarrel(ray, tmp);
  if (bt < bestT) { bestT = bt; out.kind = 'barrel'; out.point.copy(tmp); out.barrel = world.hitBarrel ?? undefined; }
  // enemies
  for (const e of enemies) {
    if (!e.alive) continue;
    e.getBox(box);
    if (ray.intersectBox(box, tmp)) {
      const t = tmp.distanceTo(ray.origin);
      if (t < bestT) { bestT = t; out.kind = 'enemy'; out.enemy = e; out.point.copy(tmp); }
    }
  }
  return out;
}

export function newHit(): Hit {
  return { kind: 'backdrop', point: new THREE.Vector3() };
}
