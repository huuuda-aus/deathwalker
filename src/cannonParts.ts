import * as THREE from 'three';
import { SOLDIER_HEIGHT } from './enemies';

/** Cannon and horse models are authored in metres; one metre is a soldier's height / 1.75, drawn 1.4x so it reads. */
export const UNIT = (SOLDIER_HEIGHT / 1.75) * 1.4;

export const WOOD = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.85 });
export const IRON = new THREE.MeshStandardMaterial({ color: 0xcfd4d9, roughness: 0.5, metalness: 0.3 });
export const HORSE = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.9 });
export const MANE = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.9 });

export const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};
