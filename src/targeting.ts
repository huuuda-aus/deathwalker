import * as THREE from 'three';
import type { Enemy } from './enemies';
import type { World } from './world';
import { terrain } from './terrain';
import type { Building } from './building';
import type { FireBarrel } from './fire';
import type { ExplosiveBarrel } from './explosiveBarrel';
import type { Scenery } from './scenery';

export type HitKind = 'enemy' | 'wall' | 'barrel' | 'explosive' | 'prop' | 'ground' | 'backdrop';

export interface Hit {
  kind: HitKind;
  point: THREE.Vector3;
  enemy?: Enemy;
  /** the building that was hit (kind 'wall') */
  building?: Building;
  /** the oil barrel that was hit (kind 'barrel') */
  barrel?: FireBarrel;
  /** the explosive barrel that was hit (kind 'explosive') */
  explosive?: ExplosiveBarrel;
  /** the roadside prop that was hit (kind 'prop') */
  scenery?: Scenery;
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
  out.explosive = undefined;
  out.scenery = undefined;

  // backdrop (always a fallback)
  if (ray.direction.z < 0) {
    const t = (BACKDROP_Z - ray.origin.z) / ray.direction.z;
    if (t > 0) { bestT = t; ray.at(t, out.point); }
  }
  // ground
  if (ray.direction.y < 0) {
    let t = -ray.origin.y / ray.direction.y;
    // over dunes the ground is not at height 0: settle on where the ray meets it (a few steps are plenty on slopes this gentle)
    if (terrain.on) {
      for (let k = 0; k < 5 && t > 0; k++) {
        ray.at(t, tmp);
        t = (world.groundHeight(tmp.x, tmp.z) - ray.origin.y) / ray.direction.y;
      }
    }
    if (t > 0 && t < bestT) { bestT = t; out.kind = 'ground'; ray.at(t, out.point); }
  }
  // walls
  const wt = world.raycast(ray, tmp);
  if (wt < bestT) { bestT = wt; out.kind = 'wall'; out.point.copy(tmp); out.building = world.lastBuilding ?? undefined; }
  // oil barrels
  const bt = world.raycastBarrel(ray, tmp);
  if (bt < bestT) { bestT = bt; out.kind = 'barrel'; out.point.copy(tmp); out.barrel = world.hitBarrel ?? undefined; }
  // explosive barrels
  const et = world.raycastExplosive(ray, tmp);
  if (et < bestT) { bestT = et; out.kind = 'explosive'; out.point.copy(tmp); out.barrel = undefined; out.explosive = world.hitExplosive ?? undefined; }
  // roadside props
  const st = world.raycastScenery(ray, tmp);
  if (st < bestT) { bestT = st; out.kind = 'prop'; out.point.copy(tmp); out.scenery = world.hitScenery ?? undefined; }
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
