import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Input } from './input';
import { Mech, setMechEnvironment, LANE } from './mech';
import { castRay, newHit } from './targeting';
import { World } from './world';
import { Environment } from './environment';
import { Sky } from './sky';
import { Wind } from './wind';
import { Litter } from './litter';
import { Rain } from './rain';
import { FootSplasher, SplashFx } from './water';
import { Fx } from './fx';
import type { SoldierEnv } from './enemies';
import { EnemyManager } from './enemyManager';
import { Shells } from './shells';
import { Missiles } from './missiles';
import { Explosions } from './explosions';
import { Bullets } from './bullets';
import { TargetLock } from './targetLock';
import { PauseMenu } from './pauseMenu';
import { GameOverMenu } from './gameOverMenu';
import { queueLevel, unlockLevel } from './levelSelect';
import { SceneCard } from './sceneCard';
import { MechDeath } from './mechDeath';
import { Score, nominalLevel, gradeFor } from './score';
import { hof } from './hallOfFame';
import { EndScreen } from './endScreen';
import { audio } from './audio';
import { sfx } from './sfx';
import { SoundTest } from './soundTest';
import { MusicToggle } from './musicToggle';
import { TrackChooser, MENU_TRACKS, savedTrack } from './trackChooser';
import { Lightning } from './lightning';
import { Foreground } from './foreground';
import { Hud, type Player } from './hud';
import { Weapon } from './weapon';
import { Debris } from './debris';
import { Dust } from './dust';
import { Post } from './post';
import { CAM_DIST, LEVEL, LEVELS, LEVEL_NO, LevelRunner, SCREEN_W, START_MECH_X, type LevelEvent } from './level';
import { PLAYER, CAMERA, MECH_DEATH, CRATER, CASING, STORM } from './config';
import { Casings } from './casings';

/** adaptive resolution tuning (ms are per-frame averages over one second) */
const RES = { minRatio: 1, step: 0.25, slowMs: 20, fastMs: 17.5, raiseAfter: 10, settleMs: 15000 };

/** seconds for the scene to fade in from black once it is first drawn */
const FADE_IN = 1.8;
/** where the sun hangs in the day sky (a direction from the camera: low, a little to the left, ahead); the light itself comes from the environment's `sun.offset` */
const SKY_SUN = new THREE.Vector3(-0.28, 0.2, -0.94).normalize();
/** seconds the light, fog and sky take to change over from one scene's environment to the next */
const ENV_FADE = 3;

/** the weather and the far-off war are turned down on the menu, so the soundtrack stands out (share of full volume) */
const MENU_AMBIENCE = 0.2;

/** seconds between clearing the level and the level complete screen coming up */
const WIN_DELAY = 3;
/** how far the picture is thrown by a full-strength footfall of the mech (world units) */
const FOOTFALL_SHAKE = 0.02;
/** the colours of the dirt a footfall throws up (the ground texture's, a touch lifted: these specks are unlit) */
const GROUND_CLODS = [0x3e3c3a, 0x333432, 0x4a4947, 0x2a2927];
/** and the desert's: sand */
const SAND_CLODS = [0xb89864, 0xa08350, 0xcaa874, 0x8a7044];

/** the lights' usual strength, which the lightning adds to; the flash's colour (the moonlight's is the sun's own) */
const FLASH_COLOR = new THREE.Color(0.85, 0.92, 1);

const newPlayer = (): Player => ({ shield: PLAYER.maxShield, lives: PLAYER.lives, over: false, hitFlash: 0 });

/** Owns every system, wires them together and runs the frame loop. */
export class Game {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: false }) // the composer's own MSAA does the smoothing;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.5, 400);
  private readonly level = new LevelRunner();
  private readonly overMenu: GameOverMenu;
  private readonly card = new SceneCard();
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
  private readonly missiles: Missiles;
  private readonly bullets: Bullets;
  private readonly enemies: EnemyManager;
  private readonly hud: Hud;
  private readonly mechDeath: MechDeath;
  private readonly casings: Casings;
  private readonly lightning: Lightning;
  private readonly hemi = new THREE.HemisphereLight();
  /** the look of the scene being played: light, fog, sky, haze, rain (fades from scene to scene) */
  private readonly env = new Environment(LEVEL[0].environment);
  private readonly score = new Score();
  private readonly endScreen: EndScreen;
  /** the level is cleared: the mech cannot be hurt, and the level complete screen is on its way (seconds) */
  private won = false;
  private winT = 0;
  private wasLocked = false;
  private readonly player = newPlayer();

  private readonly hazeLights = [new THREE.Vector4(), new THREE.Vector4()];
  private readonly boltShake = new THREE.Vector3();
  private readonly footDust = new THREE.Vector3();
  private readonly boltDir = new THREE.Vector3();
  private readonly muzzlePos = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly ejectAt = new THREE.Vector3();
  private readonly ejectDir = new THREE.Vector3();
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
  /** seconds left of the mech's death (it is gone, the fireball is up); 0 = alive. And how long a new mech is untouchable */
  private deathT = 0;
  private invuln = 0;
  /** the level complete screen is up */
  private winShown = false;
  private cullTimer = 0;
  /** screen shake: how far the camera is thrown about right now (world units), dying away */
  private shake = 0;
  private camX = this.level.camX;
  private last = performance.now();
  /** the views start black and fade in once the first frame has rendered (the shaders compile on it) and the page calls `show()` */
  private revealed = false;
  private onFirstFrame: () => void = () => {};
  /**
   * Settles once everything the main menu needs is in: the first frame drawn (the shaders compiled), the sound samples
   * decoded, and the menu's soundtrack buffered. The page keeps the menu hidden behind its loading screen until then.
   */
  readonly ready: Promise<void>;
  /** adaptive resolution: the pixel ratio follows frame time, within [MIN_RATIO, ratioCap] */
  private ratioCap = Math.min(devicePixelRatio, 2);
  private perfFrames = 0;
  private perfMs = 0;
  private goodSeconds = 0;
  private lastRaise = -Infinity;
  /** 'menu': the main menu over the quiet skyline of the first scene; 'play': the game */
  private mode: 'menu' | 'play' = 'menu';
  /** the pause menu is up: the game is frozen on its last frame */
  private paused = false;
  /** where the reticle is drawn (CSS pixels): the mouse, or the locked target */
  private reticlePx: { x: number; y: number } = { x: 0, y: 0 };

  constructor() {
    const { renderer, scene, camera, sun, rim } = this;
    renderer.setPixelRatio(this.ratioCap);
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.prepend(renderer.domElement);
    renderer.domElement.after(this.foreground.canvas);       // the frontmost layer, over the 3D view and under the HUD
    if (LEVELS[LEVEL_NO - 1].world === 'desert') this.foreground.canvas.style.display = 'none';     // its black heaps of wreckage belong to the city
    for (const c of [renderer.domElement, this.foreground.canvas]) Object.assign(c.style, { opacity: '0', transition: `opacity ${FADE_IN}s ease-out` });

    scene.fog = new THREE.Fog(this.env.now.fogColor, this.env.now.fogNear, this.env.now.fogFar);
    this.applyAspect();

    // neutral studio reflections on the mech only, so silver/black reads as metal under coloured light
    setMechEnvironment(new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture);
    scene.add(this.hemi);
    this.lightning = new Lightning(scene, (a) => this.shakeScreen(this.boltShake.set(this.camX, 0, 0), a));
    sun.position.set(-30, 25, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 20, bottom: -10, near: 1, far: 100 });
    scene.add(sun, sun.target, rim, rim.target);

    this.dust = new Dust(scene);
    this.debris = new Debris(scene, this.dust);
    this.world = new World(scene, this.debris, this.dust, LEVELS[LEVEL_NO - 1].world);
    this.sky = new Sky(scene);
    this.litter = new Litter(scene, this.wind);
    this.rain = new Rain(scene, this.world);
    this.splashFx = new SplashFx(scene);
    this.debris.setColliders(this.mech.colliders);
    this.debris.ground = (x, z) => this.world.groundHeight(x, z);
    this.mech.root.position.x = START_MECH_X;
    // each heavy footfall bursts the ground from under the foot: clods of dirt in the ground's colour, a puff of dust, a faint jolt
    // (a puddle is splashed instead)
    this.mech.onStep = (at, strength) => {
      this.shakeScreen(at, (FOOTFALL_SHAKE * strength) / 2);
      if (this.world.puddleDepth(at.x, at.z) > 0.2) return;
      this.footDust.set(at.x, this.mech.root.position.y + 0.03, at.z);
      this.fx.burst(this.footDust, Math.round(16 * strength), 3.2, LEVELS[LEVEL_NO - 1].world === 'desert' ? SAND_CLODS : GROUND_CLODS, true, 1.5);
      this.dust.puff(this.footDust, 1, 0.3 * strength, 1.2);
    };
    scene.add(this.mech.root);

    this.input = new Input(renderer.domElement);
    this.post = new Post(renderer, scene, camera, CAM_DIST);

    const { world, debris, dust } = this;
    this.fx = new Fx(scene);
    this.fx.setSurface((x, z, y) => world.surfaceTop(x, z, y));
    world.setFx(this.fx);

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
    this.world.setExplosions(this.explosions);
    this.shells = new Shells({ scene, fx: this.fx, dust, world, debris, explosions: this.explosions, colliders: this.mech.colliders, onPlayerHit: (n) => this.hurtPlayer(n) });
    this.missiles = new Missiles({
      fx: this.fx, dust, world, explosions: this.explosions, colliders: this.mech.colliders, onPlayerHit: (n) => this.hurtPlayer(n),
      add: (e) => this.enemies.add(e), handOff: (from, to) => this.lock.handOff(from, to), shake: (at, amount) => this.shakeScreen(at, amount),
    });
    this.bullets = new Bullets({ scene, fx: this.fx, world, debris, colliders: this.mech.colliders, onPlayerHit: () => this.hurtPlayer(PLAYER.hitDamage) });
    this.enemies = new EnemyManager({ scene, world, level: this.level, fx: this.fx, debris, mech: this.mech, env, shells: this.shells, missiles: this.missiles, dust, explosions: this.explosions, bullets: this.bullets, onPlayerHit: (n) => this.hurtPlayer(n), score: this.score,
      shake: (x, amount) => this.shakeScreen(this.boltShake.set(x, 0, 0), amount),
    });
    this.casings = new Casings(scene, (x, z, y) => world.surfaceTop(x, z, y));
    this.weapon = new Weapon({ fx: this.fx, world, dust, debris, enemies: this.enemies.list, onShot: (gun) => this.ejectCasings(gun) });
    this.mechDeath = new MechDeath({
      scene, fx: this.fx, dust, explosions: this.explosions, floor: (x, z, y) => world.surfaceTop(x, z, y),
      shake: (at, amount) => this.shakeScreen(at, amount), flash: (a) => this.hud.flash(a),
      dig: (x, z) => {
        world.craters.dent(x, z, CRATER.mechRadius, CRATER.mechDepth, CRATER.mechLip);
        debris.wakeNear(new THREE.Vector3(x, 0.3, z), CRATER.mechRadius * 2.2);      // rubble that lay there falls in
      },
      blastBuildings: (at, radius, speed) => world.forEachBuilding(at.x - radius, at.x + radius, (b) => b.blast(at.x, at.y, at.z, radius, speed)),
    });
    this.hud = new Hud({ player: this.player, level: this.level, weapon: this.weapon, boss: () => this.enemies.boss, score: this.score });
    this.endScreen = new EndScreen(hof);

    // the menu shows the first scene's skyline and weather, without the mech or any fighting
    this.mech.root.visible = false;
    this.placeCamera();
    // sound: the samples load behind the menu, and the browser wants a click or key press before it will play any
    const samples = audio.load();
    const track = this.pickMenuTrack();
    audio.playMusic(track);
    this.ready = Promise.all([samples, audio.musicReady, new Promise<void>((done) => { this.onFirstFrame = done; })]).then(() => undefined);
    audio.setVolume('ambience', MENU_AMBIENCE);
    new SoundTest(audio);
    new MusicToggle();
    new TrackChooser(track);
    // until the browser lets sound start (a first click or key press) the menu says so
    const showLock = (): void => { document.body.classList.toggle('audio-locked', audio.ctx.state !== 'running'); };
    audio.ctx.addEventListener('statechange', showLock);
    showLock();
    for (const type of ['pointerdown', 'keydown'] as const) addEventListener(type, () => audio.unlock(), { capture: true });
    this.overMenu = new GameOverMenu({
      isOver: () => this.player.over || this.winShown,
      onNext: () => { this.endScreen.commit(); queueLevel(LEVEL_NO + 1); location.reload(); },
      onRetry: () => { this.endScreen.commit(); this.reset(); },
      onQuit: () => { this.endScreen.commit(); location.reload(); },
    });
    new PauseMenu({
      canPause: () => this.mode === 'play' && !this.player.over && !this.winShown,
      onPause: () => { this.paused = true; this.input.clear(); audio.suspend(); },
      onResume: () => { this.paused = false; this.input.clear(); this.last = performance.now(); audio.resume(); },
      // the world (buildings, rubble) has no way to be put back, so a fresh page is the clean way to a new game
      onQuit: () => location.reload(),
    });
    this.applyPixelRatio(this.ratioCap);
    addEventListener('resize', () => this.onResize());
    addEventListener('keydown', (e) => {
      if (document.activeElement instanceof HTMLInputElement) return;     // typing a name
      if (e.code === 'F4') this.lightning.strike(this.camX);              // dev: a strike now
      if (e.code === 'KeyQ') this.hud.setQuality(this.post.toggle());
      if (e.code === 'KeyH') this.post.toggleHaze();
    });
  }

  /** the main menu's soundtrack: the one the player chose last time, else one of them at random */
  private pickMenuTrack(): string { return savedTrack() ?? MENU_TRACKS[Math.floor(Math.random() * MENU_TRACKS.length)]; }

  start(): void {
    if (import.meta.env.DEV) Object.assign(window, { __game: this });     // dev: poke at it from the console
    this.frame();
  }

  /** "start game" was chosen on the menu */
  startPlaying(): void {
    unlockLevel(LEVEL_NO);
    this.card.show(0);
    this.mode = 'play';
    audio.stopMusic(2);
    audio.setVolume('ambience', 1, 1.5);               // the menu's soundtrack: there is no music in the game itself
    this.mech.root.visible = true;
    this.last = performance.now();
  }

  /** the first frame has been rendered */
  private reveal(): void {
    if (this.revealed) return;
    this.revealed = true;
    this.onFirstFrame();
  }

  /** the page is ready to be seen: let the scene fade in from black (a frame later, so the slow first frame is not part of the fade) */
  show(): void {
    requestAnimationFrame(() => {
      for (const c of [this.renderer.domElement, this.foreground.canvas]) c.style.opacity = '1';
    });
  }

  /** the camera at the level's current view */
  private placeCamera(dx = 0, dy = 0): void {
    const { camera } = this;
    camera.position.set(this.camX + dx, CAMERA.height + dy, CAM_DIST);
    camera.lookAt(this.camX + dx, CAMERA.height - 0.5 + dy, 0);
    camera.updateMatrixWorld();
  }

  /** A blast at `at` shakes the screen, less the farther from the middle of the view it is. */
  private shakeScreen(at: THREE.Vector3, amount: number): void {
    this.shake = Math.max(this.shake, amount * Math.max(0, 1 - Math.abs(at.x - this.camX) / (SCREEN_W * 1.2)));
  }

  /** Lock the horizontal view to SCREEN_W at the gameplay depth, whatever the window aspect. */
  private applyAspect(): void {
    const { camera } = this;
    camera.aspect = innerWidth / innerHeight;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(SCREEN_W / 2 / CAM_DIST / camera.aspect));
    camera.updateProjectionMatrix();
  }

  /** resolution-dependent sizes follow the renderer's pixel ratio */
  private applyPixelRatio(ratio: number): void {
    this.renderer.setPixelRatio(ratio);
    this.post.setSize(innerWidth, innerHeight);
    this.fx.setPixelRatio(ratio);
    this.world.setPixelRatio(ratio);
    this.splashFx.setPixelRatio(ratio);
    this.bullets.setPixelRatio(ratio);
    this.syncViewport();
  }

  /**
   * Trade resolution for frame rate: a slow second steps the pixel ratio down; ten steady seconds try one step up.
   * A raise that is promptly undone lowers the cap, so it settles instead of oscillating.
   */
  private adaptResolution(rawMs: number, now: number): void {
    this.perfFrames++; this.perfMs += rawMs;
    if (this.perfMs < 1000) return;
    const avg = this.perfMs / this.perfFrames;
    this.perfFrames = 0; this.perfMs = 0;
    const ratio = this.renderer.getPixelRatio();
    if (avg > RES.slowMs && ratio > RES.minRatio) {
      if (now - this.lastRaise < RES.settleMs) this.ratioCap = ratio;
      this.goodSeconds = 0;
      this.applyPixelRatio(Math.max(RES.minRatio, ratio - RES.step));
    } else if (avg <= RES.fastMs && ratio < this.ratioCap) {
      if (++this.goodSeconds >= RES.raiseAfter) {
        this.goodSeconds = 0;
        this.lastRaise = now;
        this.applyPixelRatio(Math.min(this.ratioCap, ratio + RES.step));
      }
    } else {
      this.goodSeconds = 0;
    }
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
    this.shake = 0;
    this.mechDeath.clear();
    this.casings.clear();
    this.world.craters.clear();
    this.mech.root.visible = true;
    this.deathT = this.invuln = 0;
    this.bullets.clear();
    this.explosions.clear();
    Object.assign(this.player, newPlayer());
    this.weapon.reset();
    this.mech.root.position.set(START_MECH_X, 0, 0);
    this.level.reset();
    this.camX = this.level.camX;
    this.vx = this.vz = 0;
    this.hud.setGameOver(false);
    this.score.reset();
    this.won = this.winShown = false;
    this.winT = 0;
    this.card.show(0);
    this.env.snap(LEVEL[0].environment);
  }

  private hurtPlayer(n: number): void {
    const { player } = this;
    if (player.over || this.won || this.deathT > 0 || this.invuln > 0) return;
    player.shield -= n;
    player.hitFlash = 1;
    this.score.noteHit();
    if (player.shield <= 0) this.killMech();
  }

  /** The shield is gone: the mech blows up. A moment later the next life starts, or the game over screen comes up. */
  private killMech(): void {
    const { player, mech } = this;
    player.shield = 0;
    player.lives--;
    // the cockpit climbs to a fifth of the way down from the top of the view (at the mech's depth)
    const half = ((CAM_DIST - mech.root.position.z) / CAM_DIST) * (SCREEN_W / 2 / this.camera.aspect);
    this.mechDeath.start(mech, CAMERA.height + half * 0.6);
    mech.root.visible = false;
    // its hit spheres go with it (shells and missiles would otherwise burst on thin air)
    for (const c of mech.colliders) { c.pos.set(0, -1000, 0); c.vel.set(0, 0, 0); }
    this.lock.release();
    this.vx = this.vz = 0;
    this.deathT = MECH_DEATH.time;
  }

  private updateDeath(dt: number): void {
    const { player } = this;
    this.invuln = Math.max(0, this.invuln - dt);
    this.mechDeath.update(dt);
    if (this.deathT <= 0) return;
    this.deathT -= dt;
    if (this.deathT > 0) return;
    if (player.lives <= 0) { player.over = true; this.showEnd('over'); return; }
    player.shield = PLAYER.maxShield;
    this.mech.root.visible = true;
    this.weapon.reset();
    this.invuln = MECH_DEATH.invulnerable;
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
    const alive = this.deathT <= 0;
    this.vx += ((alive ? input.move : 0) * speed - this.vx) * ease;
    this.vz += ((alive ? input.depth : 0) * speed - this.vz) * ease;
    this.autoVx = level.phase === 'entering' ? level.camVel : 0;
    pos.x += (this.vx + this.autoVx) * dt;
    pos.z = THREE.MathUtils.clamp(pos.z + this.vz * dt, LANE.zMin, LANE.zMax);
    // the mech stands on the ground, craters and all
    pos.y += (this.world.groundHeight(pos.x, pos.z) - pos.y) * Math.min(1, dt * 8);
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
    if (this.deathT > 0) return;           // no mech to aim
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

  /** a gun fired: its casings fly out of its ejection port, outward, up and a little back, each at its own angle */
  private ejectCasings(gun: number): void {
    const port = this.mech.ports[gun];
    if (!port) return;
    port.updateWorldMatrix(true, false);
    port.getWorldPosition(this.ejectAt);
    const side = gun === 0 ? -1 : 1;                 // the guns are on either flank of the cockpit
    this.ejectDir.set(0.35, 0.6, side * 0.8).transformDirection(port.matrixWorld);
    for (let i = 0; i < CASING.perShot; i++) this.casings.eject(this.ejectAt, this.ejectDir);
  }

  /** The game over / level complete screen: the score and where it came from, and a place on the hall of fame if it earned one. */
  private showEnd(kind: 'over' | 'win'): void {
    const { score } = this;
    if (kind === 'win') this.winShown = true;
    this.endScreen.show({
      kind, score: score.total, scenes: score.results.length, sceneCount: LEVEL.length, time: score.time, kills: score.kills, results: score.results,
      grade: kind === 'win' ? gradeFor(score.total, nominalLevel(LEVEL)) : undefined,
    });
    this.overMenu.show(kind === 'win' && LEVEL_NO < LEVELS.length);
    this.hud.setGameOver(true, kind === 'win' ? 4 : undefined);
  }

  private updateEnemies(dt: number, active: boolean, levelEvent: LevelEvent): void {
    if (levelEvent === 'arrived') {
      this.score.beginScene();
      if (this.level.index > 0) {
        this.card.show(this.level.index);          // the first scene's card came up with the level
        this.env.fadeTo(this.level.scene.environment, ENV_FADE);
      }
    }
    if (levelEvent === 'cleared' || levelEvent === 'complete') {
      this.score.endScene(this.level.index, LEVEL[this.level.index].parTime, this.player.shield, PLAYER.maxShield);
    }
    if (levelEvent === 'complete') { this.won = true; this.winT = WIN_DELAY; }
    if (levelEvent === 'cleared' || levelEvent === 'complete') this.enemies.retreatAll();
    if (levelEvent === 'arrived') this.enemies.purgeRetreating();
    this.enemies.viewTop = CAMERA.height + SCREEN_W / 2 / this.camera.aspect;
    this.enemies.update(dt, this.camX, active);
  }

  /** lights, weather, atmosphere and everything that is just scenery */
  private updateEnvironment(dt: number, now: number): void {
    const { sun, rim, camX, mech, rain, post, hazeLights, muzzlePos, weapon, world } = this;
    // the look of the scene: fades from one scene's environment to the next
    this.env.update(dt);
    const look = this.env.now;
    rain.scale = look.rain;
    // lightning: the sun and the sky's light jump up for a moment and the scene is lit hard from above
    const flash = this.lightning.level;
    this.lightning.update(dt, camX, rain.intensity);
    this.hemi.color.copy(look.hemiSky);
    this.hemi.groundColor.copy(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity + STORM.hemiBoost * flash;
    sun.intensity = look.sunIntensity + STORM.sunBoost * flash;
    sun.color.copy(look.sunColor).lerp(FLASH_COLOR, Math.min(1, flash * 1.5));
    if (flash > 0.12) sun.position.set(camX + (this.lightning.boltAt.x - camX) * 0.3, 55, 20);
    else sun.position.set(camX + look.sunOffset.x, look.sunOffset.y, look.sunOffset.z);
    sun.target.position.set(camX, 0, 0);
    this.sky.setFlash(flash, this.boltDir.copy(this.lightning.boltAt).sub(this.camera.position));
    this.sky.setLook(look.day, SKY_SUN, look.fogColor);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(look.fogColor); fog.near = look.fogNear; fog.far = look.fogFar;
    rim.color.copy(look.rimColor); rim.intensity = look.rimIntensity;
    world.setGroundTint(look.groundTint);
    rim.position.set(camX + 10, 6, -40);
    rim.target.position.set(camX, 2, 0);
    world.update(camX, dt);
    audio.setListener(camX, SCREEN_W / 2);
    sfx.update(dt, rain.intensity, this.wind.speed);

    this.wind.update(dt);
    this.dust.windSpeed = this.wind.speed;
    this.fx.windSpeed = this.wind.speed;
    this.litter.update(dt, camX);
    this.sky.update(this.camera, now / 1000);
    // the muzzle fire lights the smoke around the barrels
    hazeLights.forEach((v, i) => v.set(muzzlePos[i].x, muzzlePos[i].y, muzzlePos[i].z, weapon.firing ? 0.35 + Math.random() * 0.5 : 0));
    post.setHazeDensityScale(look.hazeDensity * (1 + 0.1 * rain.intensity)); // a downpour thickens the air only a touch
    post.setHazeColor(look.hazeColor);
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
      this.reveal();
      requestAnimationFrame(this.frame);
      return;
    }
    if (this.paused) {
      this.post.render(0, 0);
      requestAnimationFrame(this.frame);
      return;
    }
    this.hud.updateFps(rawMs);
    this.adaptResolution(rawMs, now);

    this.updateDeath(dt);
    this.score.update(dt, this.level.phase === 'active' && !this.won && !this.player.over && this.deathT <= 0);
    if (this.weapon.locked && !this.wasLocked) this.score.noteOverheat();
    this.wasLocked = this.weapon.locked;
    if (this.winT > 0 && (this.winT -= dt) <= 0) this.showEnd('win');
    const active = !this.player.over && this.deathT <= 0;
    this.movePlayer(dt);
    const levelEvent = this.updateCamera(dt);
    this.aimAndFire(dt, active);
    this.updateEnemies(dt, active, levelEvent);
    this.shells.update(dt);
    this.bullets.update(dt);
    this.explosions.update(dt);
    this.casings.update(dt);

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
    // the shake moves the camera only for the drawing: aiming and everything else use the steady view
    this.shake *= Math.exp(-dt * (this.shake > 0.5 ? 2.2 : 5));
    if (this.shake > 0.004) {
      this.placeCamera((Math.random() - 0.5) * 2 * this.shake, (Math.random() - 0.5) * 2 * this.shake);
      this.post.render(dt, this.level.camVel);
      this.placeCamera();
    } else {
      this.post.render(dt, this.level.camVel);
    }
    this.reveal();
    requestAnimationFrame(this.frame);
  };
}
