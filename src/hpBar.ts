import * as THREE from 'three';

/** TEMPORARY debug aid: a health bar floating over a truck or gun, to find out what is killing them. */
const W = 1.3, H = 0.14;
const bg = new THREE.SpriteMaterial({ color: 0x000000, depthTest: false, fog: false, toneMapped: false, transparent: true, opacity: 0.8 });
const fills = [0x40ff60, 0xffc030, 0xff3020].map((color) => new THREE.SpriteMaterial({ color, depthTest: false, fog: false, toneMapped: false }));

export class HpBar {
  readonly group = new THREE.Group();
  private readonly back = new THREE.Sprite(bg);
  private readonly fill = new THREE.Sprite(fills[0]);

  /** @param y height above the object's origin */
  constructor(y: number) {
    this.back.scale.set(W + 0.06, H + 0.06, 1);
    this.back.renderOrder = 998;
    this.fill.renderOrder = 999;
    this.group.add(this.back, this.fill);
    this.group.position.y = y;
  }

  /** @param frac 0..1 health left; the bar disappears once the thing is dead */
  set(frac: number, alive: boolean): void {
    this.group.visible = alive;
    const f = THREE.MathUtils.clamp(frac, 0.001, 1);
    this.fill.scale.set(W * f, H, 1);
    this.fill.center.set(1 / (2 * f), 0.5);     // pinned to the left edge as it shrinks
    this.fill.material = fills[f > 0.6 ? 0 : f > 0.3 ? 1 : 2];
  }
}
