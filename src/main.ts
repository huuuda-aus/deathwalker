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
import { Soldier } from './enemies';
import { Weapon } from './weapon';
import { Debris, Dust } from './debris';
import { Post } from './post';
import { CAM_DIST, LEVEL, LevelRunner, SCREEN_W, START_MECH_X } from './level';

const WALK_SPEED = 4.5; // nimble enough to dodge grenades
const WALK_ACCEL = 14;
/** enemies alive at once */
const MAX_ALIVE = 12;
const CAM_HEIGHT = 3.5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(FOG_COLOR, 28, 62);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.5, 400);
/** Lock the horizontal view to SCREEN_W at the gameplay depth, whatever the window aspect. */
function applyAspect() {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(SCREEN_W / 2 / CAM_DIST / camera.aspect));
  camera.updateProjectionMatrix();
}
applyAspect();
const level = new LevelRunner();

// neutral studio reflections on the mech only, so silver/black reads as metal under coloured light
setMechEnvironment(new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture);
scene.add(new THREE.HemisphereLight(0x34447a, 0x0a2a22, 0.75));
const sun = new THREE.DirectionalLight(0x98a6d8, 1.15); // moonlight
sun.position.set(-30, 25, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 20, bottom: -10, near: 1, far: 100 });
scene.add(sun, sun.target);
// radioactive green rim light from behind the skyline
const rim = new THREE.DirectionalLight(0x40ff90, 0.15);
scene.add(rim, rim.target);

const dust = new Dust(scene);
const debris = new Debris(scene, dust);
const world = new World(scene, debris, dust);
const sky = new Sky(scene);
const wind = new Wind();
const litter = new Litter(scene, wind);
const rain = new Rain(scene, world);
const splashFx = new SplashFx(scene);
const footSplasher = new FootSplasher();
const hazeLights = [new THREE.Vector4(), new THREE.Vector4()];
const mech = new Mech();
debris.setColliders(mech.colliders);
Soldier.blockers = (x, z, r, out) => debris.collectBlockers(x, z, r, out);
Soldier.surface = (x, z, y) => world.surfaceTop(x, z, y);
const sightTmp = new THREE.Vector3();
Soldier.sight = (a, b) => !debris.segmentHit(a, b, sightTmp);
mech.root.position.x = START_MECH_X;
scene.add(mech.root);

const input = new Input(renderer.domElement);
const post = new Post(renderer, scene, camera, CAM_DIST);
function syncViewport() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  dust.setViewport(size.y, camera.fov);
  rain.setResolution(size.x, size.y);
}
syncViewport();
addEventListener('keydown', (e) => {
  if (e.code === 'KeyQ') qualityEl.textContent = `Q: post-fx ${post.toggle() ? 'on' : 'off'}  |  H: haze`;
  if (e.code === 'KeyH') post.toggleHaze();
});
const reticle = document.getElementById('reticle')!;
const $ = (id: string) => document.getElementById(id)!;
const qualityEl = $('quality');
const sceneEl = $('scene');
const goEl = $('go');
const shieldEl = $('shield'), heatEl = $('heat'), livesEl = $('lives'), hitEl = $('hit'), overEl = $('over');

const fx = new Fx(scene);
fx.setPixelRatio(renderer.getPixelRatio());
world.setFx(fx);
world.setPixelRatio(renderer.getPixelRatio());
splashFx.setPixelRatio(renderer.getPixelRatio());
fx.setSurface((x, z, y) => world.surfaceTop(x, z, y));
const weapon = new Weapon();
const enemies: Soldier[] = [];
// falling masonry crushes soldiers it touches
const crushBox = new THREE.Box3();
debris.onContact = (pos, size) => {
  for (const e of enemies) {
    if (!e.alive) continue;
    e.getBox(crushBox).expandByScalar(size * 0.35);
    if (crushBox.containsPoint(pos)) e.damage(99, fx);
  }
};
const player = { shield: 100, lives: 3, over: false, hitFlash: 0 };
let spawnTimer = 1;
const muzzlePos = [new THREE.Vector3(), new THREE.Vector3()];

function reset() {
  for (const e of enemies) scene.remove(e.group);
  enemies.length = 0;
  Object.assign(player, { shield: 100, lives: 3, over: false, hitFlash: 0 });
  weapon.reset();
  mech.root.position.set(START_MECH_X, 0, 0);
  level.reset();
  camX = level.camX;
  vx = vz = 0;
  overEl.style.display = 'none';
}
addEventListener('keydown', (e) => { if (e.code === 'KeyR' && player.over) reset(); });

function hurtPlayer(n: number) {
  if (player.over) return;
  player.shield -= n;
  player.hitFlash = 1;
  if (player.shield <= 0) {
    fx.burst(mech.pivotWorld, 40, 5, [0xffa040, 0xff5020, 0x888888]);
    player.lives--;
    player.shield = 100;
    if (player.lives <= 0) { player.over = true; overEl.style.display = 'flex'; }
  }
}

const raycaster = new THREE.Raycaster();
const aimHit = newHit();
let vx = 0;
let vz = 0;
/** walking speed multiplier from rubble underfoot (1 = clear ground) */
let rubbleSlow = 1;
let cullTimer = 0;
let camX = level.camX;

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  applyAspect();
  post.setSize(innerWidth, innerHeight);
  syncViewport();
});

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  // movement: smooth accel; the mech auto-walks with the camera while it rolls into a scene
  // dense rubble around the feet slows the mech down
  const bulk = debris.density(mech.root.position.x, mech.root.position.z, 1.0, 0.8);
  rubbleSlow += (Math.min(1, Math.max(0.4, 1 - 0.07 * bulk)) - rubbleSlow) * Math.min(1, dt * 6);
  const speed = WALK_SPEED * rubbleSlow;
  const target = input.move * speed;
  vx += (target - vx) * Math.min(1, dt * WALK_ACCEL);
  const targetZ = input.depth * speed;
  vz += (targetZ - vz) * Math.min(1, dt * WALK_ACCEL);
  const autoVx = level.phase === 'entering' ? level.camVel : 0;
  mech.root.position.x += (vx + autoVx) * dt;
  mech.root.position.z = THREE.MathUtils.clamp(mech.root.position.z + vz * dt, LANE.zMin, LANE.zMax);
  if (mech.root.position.z === LANE.zMin || mech.root.position.z === LANE.zMax) vz = 0;

  // rails camera, then keep the mech on screen (visible half-width shrinks toward the camera)
  const levelEvent = level.update(dt, mech.root.position.x);
  camX = level.camX;
  const camVel = level.camVel;
  const halfVis = ((CAM_DIST - mech.root.position.z) / CAM_DIST) * (SCREEN_W / 2) * 0.92;
  mech.root.position.x = THREE.MathUtils.clamp(mech.root.position.x, camX - halfVis, camX + halfVis);
  camera.position.set(camX, CAM_HEIGHT, CAM_DIST);
  camera.lookAt(camX, CAM_HEIGHT - 0.5, 0);
  camera.updateMatrixWorld();

  // aim: mouse ray -> nearest thing in the world (enemy / wall / ground / backdrop)
  raycaster.setFromCamera(new THREE.Vector2(input.mouse.x, input.mouse.y), camera);
  castRay(raycaster.ray, enemies, world, aimHit);
  mech.firing = weapon.firing;
  mech.update(dt, vx + autoVx, vz, aimHit.point);

  mech.root.updateMatrixWorld(true);
  mech.muzzles.forEach((m, i) => m.getWorldPosition(muzzlePos[i]));
  const active = !player.over;
  weapon.update(dt, active && input.fire && mech.canFire, muzzlePos, raycaster.ray, enemies, fx, world, dust, debris);

  // spawning: waves of 3-6 from the scene budget; most come out of buildings, the rest walk in from off-screen
  spawnTimer -= dt;
  const aliveNow = enemies.filter((e) => e.alive).length;
  if (active && spawnTimer <= 0 && level.canSpawn && aliveNow < MAX_ALIVE) {
    const half = SCREEN_W / 2;
    const wave = Math.min(3 + Math.floor(Math.random() * 4), MAX_ALIVE - aliveNow, level.scene.spawnBudget - level.spawned);
    for (let w = 0; w < wave; w++) {
      const bay = Math.random() < 0.65 ? world.takeLedge(camX - half * 0.85, mech.root.position.x - 5) : null;
      let s: Soldier;
      if (bay) {
        s = new Soldier(bay.pos.x, bay.pos.z);
        s.perchAt(bay.pos, { ledgeZ: bay.ledgeZ, backZ: bay.backZ, floorTop: bay.floorTop });
      } else {
        s = new Soldier(
          camX - half - 3 - Math.random() * 8,
          LANE.zMin + Math.random() * (LANE.zMax - LANE.zMin),
        );
      }
      scene.add(s.group);
      enemies.push(s);
      level.spawned++;
    }
    spawnTimer = 3 + Math.random() * 2.5;
  }
  if (levelEvent === 'cleared' || levelEvent === 'complete') enemies.forEach((e) => { if (e.alive) e.retreating = true; });
  if (levelEvent === 'arrived') {
    // stragglers that fled the previous scene are gone by the time the next one starts
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].retreating) { scene.remove(enemies[i].group); enemies.splice(i, 1); }
    }
  }
  const chest = mech.pivotWorld.clone();
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.update(dt, mech.root.position, fx, (_from) => {
      const hit = Math.random() < 0.5;
      const to = hit ? chest : chest.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 2));
      fx.sparks(to, 2, 2.5, hit ? [0xffa040, 0xffffff] : [0xaa8855]);
      if (hit && active) hurtPlayer(4);
    });
    if (e.state === 'dead' && !e.counted) { e.counted = true; level.addKill(); }
    if ((e.state === 'dead' && e.deadTime > 8) || (e.retreating && (e.gone || e.x < camX - 14))) {
      scene.remove(e.group);
      enemies.splice(i, 1);
    }
  }
  fx.update(dt);
  debris.update(dt);
  cullTimer -= dt;
  if (cullTimer <= 0) { cullTimer = 1; debris.cull(camX - SCREEN_W * 2.5, camX + SCREEN_W * 2.5); }
  dust.update(dt);

  goEl.style.display = level.phase === 'cleared' ? 'block' : 'none';
  const lines = LEVEL.map((def, i) => {
    const k = level.killsByScene[i];
    if (i > level.index) return `SCENE ${i + 1}  --`;
    const done = i < level.index || level.phase === 'cleared' || level.phase === 'complete';
    const tag = done ? '  CLEARED' : `  goal ${def.killTarget}`;
    return `SCENE ${i + 1}  KILLED ${k}/${def.spawnBudget}${tag}`;
  });
  sceneEl.innerHTML = lines.join('<br>');
  shieldEl.style.width = `${Math.max(0, player.shield)}%`;
  heatEl.style.width = `${weapon.heat * 100}%`;
  heatEl.style.background = weapon.locked ? '#ff3030' : weapon.heat > 0.7 ? '#ff8030' : '#ffb347';
  livesEl.textContent = `LIVES ${'■'.repeat(Math.max(0, player.lives))}`;
  player.hitFlash = Math.max(0, player.hitFlash - dt * 3);
  hitEl.style.opacity = String(player.hitFlash);

  sun.position.set(camX - 30, 25, 20);
  sun.target.position.set(camX, 0, 0);
  rim.position.set(camX + 10, 6, -40);
  rim.target.position.set(camX, 2, 0);
  world.update(camX, dt);

  reticle.style.opacity = mech.canFire ? '1' : '0.35';
  reticle.style.transform = `translate(${input.mousePx.x}px, ${input.mousePx.y}px)`;

  wind.update(dt);
  litter.update(dt, camX);
  sky.update(camera, now / 1000);
  // the muzzle fire lights the smoke around the barrels
  hazeLights.forEach((v, i) => v.set(muzzlePos[i].x, muzzlePos[i].y, muzzlePos[i].z, weapon.firing ? 0.35 + Math.random() * 0.5 : 0));
  post.setHazeDensityScale(1 + 0.7 * rain.intensity); // a downpour thickens the air
  post.updateHaze(now / 1000, wind.travelled, hazeLights);
  world.setWeather(now / 1000, rain.intensity, hazeLights);
  footSplasher.update(dt, mech.colliders, (x, z) => world.puddleDepth(x, z), splashFx);
  splashFx.update(dt);
  rain.update(dt, camX, mech.root.position.x, mech.root.position.z, wind.speed, hazeLights);
  post.render(dt, camVel);
  requestAnimationFrame(frame);
}
frame();
