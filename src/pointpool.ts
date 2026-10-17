import * as THREE from 'three';
import { swapRemove } from './util';

export type PointAttrs = Record<string, THREE.BufferAttribute>;

/**
 * Fixed-capacity pool of particles drawn as one THREE.Points call. Owns the dynamic vertex attributes
 * (`layout` maps attribute name -> components; 'position' is required), the live item list and the
 * draw range. Callers step `items` themselves (removing dead ones with `removeAt`), then `upload`.
 */
export class PointPool<T> {
  readonly items: T[] = [];
  private geo = new THREE.BufferGeometry();
  private attrs: PointAttrs = {};

  constructor(scene: THREE.Scene, readonly max: number, material: THREE.Material, layout: Record<string, number>) {
    for (const [name, size] of Object.entries(layout)) {
      const a = new THREE.BufferAttribute(new Float32Array(max * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      this.attrs[name] = a;
    }
    this.geo.setDrawRange(0, 0);
    const points = new THREE.Points(this.geo, material);
    points.frustumCulled = false;
    scene.add(points);
  }

  get full(): boolean { return this.items.length >= this.max; }

  push(item: T): void { this.items.push(item); }

  /** unordered O(1) removal; iterate backwards when calling this in a loop */
  removeAt(i: number): void { swapRemove(this.items, i); }

  /** write every live item into the vertex attributes and flag them for upload */
  upload(write: (item: T, i: number, a: PointAttrs) => void): void {
    const { items, attrs } = this;
    for (let i = 0; i < items.length; i++) write(items[i], i, attrs);
    this.geo.setDrawRange(0, items.length);
    for (const name in attrs) attrs[name].needsUpdate = true;
  }
}
