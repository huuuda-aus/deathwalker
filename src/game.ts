import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Input } from './input';
import { Mech, setMechEnvironment, LANE } from './mech';
import { castRay, newHit } from './targeting';
import { World, FOG_COLOR } from './world';
import { Sky } from './sky';
import { Wind } from './wind';
import { Litter } from './litter';
import { Rain } from './rain';
import { FootSplasher, SplashFx } from './water';
import { Fx } from './fx';
import type { SoldierEnv } from './enemies';
import { EnemyManager } from './enemyManager';
import { Shells } from './shells';
import { Explosions } from './explosions';
import { Bullets } from './bullets';
import { TargetLock } from './targetLock';
import { Menu } from './menu';
import { Foreground } from './foreground';
import { Hud, type Player } from './hud';
import { Weapon } from './weapon';
import { Debris } from './debris';
import { Dust } from './dust';
import { Post } from './post';
import { CAM_DIST, LevelRunner, SCREEN_W, START_MECH_X, type LevelEvent } from './level';
import { PLAYER, CAMERA } from './config';

const newPlayer = (): Player => ({ shield: PLAYER.maxShield, lives: PLAYER.lives, over: false, hitFlash: 0 });

/** Owns every system, wires them together and runs the frame loop. */
export class Game {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.5, 400);
  private readonly level = new LevelRunner();
  private readonly sun = new THREE.DirectionalLight(0x98a6d8, 1.15); // moonlight
  private readonly rim = new THREE.DirectionalLight(0x40ff90, 0.15); // radioactive green, from behind the skyline

  private readonly dust: Dust;
  private readonly debris: Debris;
  private readonly world: World;
  private readonly sky: Sky;
  private readonly wind = new Wind();
  private readonly litter: Litter;
  private readonly rain: Rain;
  private readonly splashFx: SplashFx;
  private readonly footSplasher = new FootSplasher();
  private readonly fx: Fx;
  private readonly mech = new Mech();
  private readonly input: Input;
  private readonly post: Post;
  private readonly weapon: Weapon;
  private readonly explosions: Explosions;
  private readonly shells: Shells;
  private readonly bullets: Bullets;
  private readonly enemies: EnemyManager;
  private readonly hud: Hud;
  private readonly player = newPlayer();

  private readonly hazeLights = [new THREE.Vector4(), new THREE.Vector4()];
  private readonly muzzlePos = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouseNdc = new THREE.Vector2();
  private readonly aimHit = newHit();
  private readonly lock = new TargetLock();
  private readonly foreground = new Foreground();

  private vx = 0;
  private vz = 0;
  /** extra x velocity while the scene rolls the mech in */
  private autoVx = 0;
  /** walking speed multiplier from rubble underfoot (1 = clear ground) */
  private rubbleSlow = 1;
  private cullTimer = 0;
  private camX = this.level.camX;
  private last = performance.now();
  /** 'menu': the main menu over the quiet skyline of the first scene; 'play': the game */
  private mode: 'menu' | 'play' = 'menu';
  /** where the reticle is drawn (CSS pixels): the mouse, or the locked target */
  private reticlePx: { x: number; y: number } = { x: 0, y: 0 };

  constructor() {
    const { renderer, scene, camera, sun, rim } = this;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.prepend(renderer.domElement);
    renderer.domElement.after(this.foreground.canvas);       // the frontmost layer, over the 3D view and under the HUD
    const pixelRatio = renderer.getPixelRatio();

    scene.fog = new THREE.Fog(FOG_COLOR, 28, 62);
    this.applyAspect();

    // neutral studio reflections on the mech only, so silver/black reads as metal under coloured light
    setMechEnvironment(new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture);
    scene.add(new THREE.HemisphereLight(0x34447a, 0x0a2a22, 0.75));
    sun.position.set(-30, 25, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 20, bottom: -10, near: 1, far: 100 });
    scene.add(sun, sun.target, rim, rim.target);

    this.dust = new Dust(scene);
    this.debris = new Debris(scene, this.dust);
    this.world = new World(scene, this.debris, this.dust);
    this.sky = new Sky(scene);
    this.litter = new Litter(scene, this.wind);
    this.rain = new Rain(scene, this.world);
    this.splashFx = new SplashFx(scene);
    this.debris.setColliders(this.mech.colliders);
    this.mech.root.position.x = START_MECH_X;
    scene.add(this.mech.root);

    this.input = new Input(renderer.domElement);
    this.post = new Post(renderer, scene, camera, CAM_DIST);

    const { world, debris, dust } = this;
    this.fx = new Fx(scene);
    this.fx.setPixelRatio(pixelRatio);
    this.fx.setSurface((x, z, y) => world.surfaceTop(x, z, y));
    world.setFx(this.fx);
    world.setPixelRatio(pixelRatio);
    this.splashFx.setPixelRatio(pixelRatio);

    const sightTmp = new THREE.Vector3();
    const env: SoldierEnv = {
      blockers: (x, z, r, out) => debris.collectBlockers(x, z, r, out),
      sight: (a, b) => !debris.segmentHit(a, b, sightTmp),
      surface: (x, z, y) => world.surfaceTop(x, z, y),
      others: () => this.enemies.list,
      arena: (z) => {
        // what is on screen at this depth (it narrows toward the back), less a margin
        const half = ((CAM_DIST - z) / CAM_DIST) * (SCREEN_W / 2) * CAMERA.mechMargin - CAMERA.arenaPad;
        return { min: this.camX - half, max: this.camX + half };
      },
    };
    this.explosions = new Explosions({ scene, fx: this.fx, dust, world, debris });
    this.shells = new Shells({ scene, fx: this.fx, dust, world, debris, explosions: this.explosions, colliders: this.mech.colliders, onPlayerHit: (n) => this.hurtPlayer(n) });
    this.bullets = new Bullets({ scene, fx: this.fx, world, debris, colliders: this.mech.colliders, onPlayerHit: () => this.hurtPlayer(PLAYER.hitDamage) });
    this.bullets.setPixelRatio(pixelRatio);
    this.enemies = new EnemyManager({ scene, world, level: this.level, fx: this.fx, debris, mech: this.mech, env, shells: this.shells, dust, explosions: this.explosions, bullets: this.bullets });
    this.weapon = new Weapon({ fx: this.fx, world, dust, debris, enemies: this.enemies.list });
    this.hud = new Hud({ player: this.player, level: this.level, weapon: this.weapon });

    // the menu shows the first scene's skyline and weather, without the mech or any fighting
    this.mech.root.visible = false;
    this.placeCamera();
    new Menu(() => this.startPlaying());
    this.syncViewport();
    addEventListener('resize', () => this.onResize());
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyQ') this.hud.setQuality(this.post.toggle());
      if (e.code === 'KeyH') this.post.toggleHaze();
      if (e.code === 'KeyR' && this.player.over) this.reset();
    });
  }

  start(): void { this.frame(); }

  private startPlaying(): void {
    this.mode = 'play';
    this.mech.root.visible = true;
    this.last = performance.now();
  }

  /** the camera at the level's current view */
  private placeCamera(): void {
    const { camera } = this;
    camera.position.set(this.camX, CAMERA.height, CAM_DIST);
    camera.lookAt(this.camX, CAMERA.height - 0.5, 0);
    camera.updateMatrixWorld();
  }

  /** Lock the horizontal view to SCREEN_W at the gameplay depth, whatever the window aspect. */
  private applyAspect(): void {
    const { camera } = this;
    camera.aspect = innerWidth / innerHeight;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(SCREEN_W / 2 / CAM_DIST / camera.aspect));
    camera.updateProjectionMatrix();
  }

  private syncViewport(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.dust.setViewport(size.y, this.camera.fov);
    this.rain.setResolution(size.x, size.y);
  }

  private onResize(): void {
    this.renderer.setSize(innerWidth, innerHeight);
    this.applyAspect();
    this.post.setSize(innerWidth, innerHeight);
    this.foreground.resize();
    this.syncViewport();
  }

  private reset(): void {
    this.enemies.reset();
    this.lock.release();
    this.shells.clear();
    this.bullets.clear();
    this.explosions.clear();
    Object.assign(this.player, newPlayer());
    this.weapon.reset();
    this.mech.root.position.set(START_MECH_X, 0, 0);
    this.level.reset();
    this.camX = this.level.camX;
    this.vx = this.vz = 0;
    this.hud.setGameOver(false);
  }

  private hurtPlayer(n: number): void {
    const { player } = this;
    if (player.over) return;
    player.shield -= n;
    player.hitFlash = 1;
    if (player.shield <= 0) {
      this.fx.burst(this.mech.pivotWorld, 40, 5, [0xffa040, 0xff5020, 0x888888]);
      player.lives--;
      player.shield = PLAYER.maxShield;
      if (player.lives <= 0) { player.over = true; this.hud.setGameOver(true); }
    }
  }

  /** smooth acceleration; dense rubble around the feet slows the mech, and the mech auto-walks while the scene rolls in */
  private movePlayer(dt: number): void {
    const { input, level } = this;
    const pos = this.mech.root.position;
    const bulk = this.debris.density(pos.x, pos.z, 1.0, 0.8);
    const slowTarget = Math.min(1, Math.max(PLAYER.rubbleSlowMin, 1 - PLAYER.rubbleSlowPerBulk * bulk));
    this.rubbleSlow += (slowTarget - this.rubbleSlow) * Math.min(1, dt * PLAYER.rubbleSlowEase);
    const speed = PLAYER.walkSpeed * this.rubbleSlow;
    const ease = Math.min(1, dt * PLAYER.walkAccel);
    this.vx += (input.move * speed - this.vx) * ease;
    this.vz += (input.depth * speed - this.vz) * ease;
    this.autoVx = level.phase === 'entering' ? level.camVel : 0;
    pos.x += (this.vx + this.autoVx) * dt;
    pos.z = THREE.MathUtils.clamp(pos.z + this.vz * dt, LANE.zMin, LANE.zMax);
    if (pos.z === LANE.zMin || pos.z === LANE.zMax) this.vz = 0;
  }

  /** rails camera, then keep the mech on screen (visible half-width shrinks toward the camera) */
  private updateCamera(dt: number): LevelEvent {
    const { level, mech } = this;
    const levelEvent = level.update(dt, mech.root.position.x);
    this.camX = level.camX;
    const halfVis = ((CAM_DIST - mech.root.position.z) / CAM_DIST) * (SCREEN_W / 2) * CAMERA.mechMargin;
    mech.root.position.x = THREE.MathUtils.clamp(mech.root.position.x, this.camX - halfVis, this.camX + halfVis);
    this.placeCamera();
    return levelEvent;
  }

  /** mouse ray -> nearest thing in the world (enemy / wall / ground / backdrop), then aim and shoot */
  private aimAndFire(dt: number, active: boolean): void {
    const { input, mech, raycaster, muzzlePos } = this;
    // holding the lock button grabs the enemy under the reticle; the reticle rides on that enemy's middle until it
    // dies or the button is let go
    if (input.takeLockPress()) this.lock.acquire(this.enemies.list, this.camera, input.mousePx, this.aimHit);
    if (!input.lockHeld) this.lock.release();
    const locked = this.lock.update(this.enemies.list, this.camera);
    this.mouseNdc.set(locked ? locked.x : input.mouse.x, locked ? locked.y : input.mouse.y);
    this.reticlePx = locked ? this.lock.reticlePx : input.mousePx;
    raycaster.setFromCamera(this.mouseNdc, this.camera);
    castRay(raycaster.ray, this.enemies.list, this.world, this.aimHit);
    mech.firing = this.weapon.firing;
    mech.update(dt, this.vx + this.autoVx, this.vz, this.aimHit.point);

    mech.root.updateMatrixWorld(true);
    mech.muzzles.forEach((m, i) => m.getWorldPosition(muzzlePos[i]));
    this.weapon.update(dt, active && input.fire && mech.canFire, muzzlePos, raycaster.ray);
  }

  private updateEnemies(dt: number, active: boolean, levelEvent: LevelEvent): void {
    if (levelEvent === 'cleared' || levelEvent === 'complete') this.enemies.retreatAll();
    if (levelEvent === 'arrived') this.enemies.purgeRetreating();
    this.enemies.update(dt, this.camX, active);
  }

  /** lights, weather, atmosphere and everything that is just scenery */
  private updateEnvironment(dt: number, now: number): void {
    const { sun, rim, camX, mech, rain, post, hazeLights, muzzlePos, weapon, world } = this;
    sun.position.set(camX - 30, 25, 20);
    sun.target.position.set(camX, 0, 0);
    rim.position.set(camX + 10, 6, -40);
    rim.target.position.set(camX, 2, 0);
    world.update(camX, dt);

    this.wind.update(dt);
    this.litter.update(dt, camX);
    this.sky.update(this.camera, now / 1000);
    // the muzzle fire lights the smoke around the barrels
    hazeLights.forEach((v, i) => v.set(muzzlePos[i].x, muzzlePos[i].y, muzzlePos[i].z, weapon.firing ? 0.35 + Math.random() * 0.5 : 0));
    post.setHazeDensityScale(1 + 0.1 * rain.intensity); // a downpour thickens the air only a touch
    post.updateHaze(now / 1000, this.wind.travelled, hazeLights);
    world.setWeather(now / 1000, rain.intensity, hazeLights);
    this.footSplasher.update(dt, mech.colliders, (x, z) => world.puddleDepth(x, z), this.splashFx);
    this.splashFx.update(dt);
    rain.update(dt, camX, mech.root.position.x, mech.root.position.z, this.wind.speed, hazeLights);
  }

  private frame = (): void => {
    const now = performance.now();
    const rawMs = now - this.last;
    const dt = Math.min(rawMs / 1000, 0.05);
    this.last = now;
    this.foreground.update(this.camX);
    if (this.mode === 'menu') {
      this.updateEnvironment(dt, now);
      this.post.render(dt, 0);
      requestAnimationFrame(this.frame);
      return;
    }
    this.hud.updateFps(rawMs);

    const active = !this.player.over;
    this.movePlayer(dt);
    const levelEvent = this.updateCamera(dt);
    this.aimAndFire(dt, active);
    this.updateEnemies(dt, active, levelEvent);
    this.shells.update(dt);
    this.bullets.update(dt);
    this.explosions.update(dt);

    this.fx.update(dt);
    this.debris.update(dt);
    this.cullTimer -= dt;
    if (this.cullTimer <= 0) {
      this.cullTimer = 1;
      const reach = SCREEN_W * CAMERA.cullScreens;
      this.debris.cull(this.camX - reach, this.camX + reach);
    }
    this.dust.update(dt);

    this.hud.update(dt, this.mech.canFire, this.reticlePx, this.lock.target !== null);
    this.updateEnvironment(dt, now);
    this.post.render(dt, this.level.camVel);
    requestAnimationFrame(this.frame);
  };
}
