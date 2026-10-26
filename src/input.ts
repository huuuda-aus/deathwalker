import { view } from './view';

export class Input {
  private keys = new Set<string>();
  private readonly ndc = { x: 0, y: 0 };
  private readonly flipped = { x: 0, y: 0 };
  /** Mouse position in NDC (-1..1), y up, as the game world sees it: mirrored, the picture is flipped and so is this. */
  get mouse(): { x: number; y: number } {
    this.flipped.x = view.mirror ? -this.ndc.x : this.ndc.x;
    this.flipped.y = this.ndc.y;
    return this.flipped;
  }
  /** Mouse position in CSS pixels. */
  readonly mousePx = { x: 0, y: 0 };
  fire = false;
  /** the lock button is down right now */
  lockHeld = false;
  private lockPressed = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.lockHeld = false; });
    // Both buttons can be held together. The browser only sends pointerdown/up for the first press and last release;
    // pressing or releasing a second button arrives as a pointermove, so the button state is read from `buttons`.
    const buttons = (e: PointerEvent): void => {
      const lock = (e.buttons & 2) !== 0;
      if (lock && !this.lockHeld) this.lockPressed = true;
      this.lockHeld = lock;
      this.fire = (e.buttons & 1) !== 0;
    };
    target.addEventListener('pointerdown', buttons);
    window.addEventListener('pointerup', buttons);
    window.addEventListener('pointercancel', buttons);
    target.addEventListener('pointermove', (e) => {
      buttons(e);
      this.mousePx.x = e.clientX;
      this.mousePx.y = e.clientY;
      this.ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Forget whatever is held down (the game is pausing: keys and buttons let go meanwhile must not stay stuck). */
  clear(): void { this.keys.clear(); this.fire = false; this.lockHeld = false; this.lockPressed = false; }

  /** Was the lock button pressed down since the last call? */
  takeLockPress(): boolean {
    const p = this.lockPressed;
    this.lockPressed = false;
    return p;
  }

  /** Depth walk: -1 = up on screen (away from camera), +1 = down (toward camera) */
  get depth(): number {
    const up = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    return (down ? 1 : 0) - (up ? 1 : 0);
  }

  /** -1 = the way the mech faces (left on the screen, or right when mirrored), +1 = the other way; the keys follow the screen */
  get move(): number {
    const l = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const r = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    return ((r ? 1 : 0) - (l ? 1 : 0)) * (view.mirror ? -1 : 1);
  }
}
