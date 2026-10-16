export class Input {
  private keys = new Set<string>();
  /** Mouse position in NDC (-1..1), y up. */
  readonly mouse = { x: 0, y: 0 };
  /** Mouse position in CSS pixels. */
  readonly mousePx = { x: 0, y: 0 };
  fire = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fire = false; });
    target.addEventListener('pointermove', (e) => {
      this.mousePx.x = e.clientX;
      this.mousePx.y = e.clientY;
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    target.addEventListener('pointerdown', () => { this.fire = true; });
    window.addEventListener('pointerup', () => { this.fire = false; });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Depth walk: -1 = up on screen (away from camera), +1 = down (toward camera) */
  get depth(): number {
    const up = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    return (down ? 1 : 0) - (up ? 1 : 0);
  }

  /** -1 = left, +1 = right */
  get move(): number {
    const l = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const r = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    return (r ? 1 : 0) - (l ? 1 : 0);
  }
}
