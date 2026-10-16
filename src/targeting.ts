import * as THREE from 'three';
import type { Soldier } from './enemies';
import type { World } from './world';

export type HitKind = 'enemy' | 'wall' | 'ground' | 'backdrop';

export interface Hit {
  kind: HitKind;
  point: THREE.Vector3;
  enemy?: Soldier;
}

/** Plane behind the far parallax layers, so skyward shots still resolve to a point. */
const BACKDROP_Z = -20;
const box = new THREE.Box3();
const tmp = new THREE.Vector3();

/** Hitscan against the 2.5D world: enemies, destructible walls, ground, backdrop. Nearest wins. */
export function castRay(ray: THREE.Ray, enemies: Soldier[], world: World, out: Hit): Hit {
  let bestT = Infinity;
  out.kind = 'backdrop';
  out.enemy = undefined;

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
  if (wt < bestT) { bestT = wt; out.kind = 'wall'; out.point.copy(tmp); }
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
