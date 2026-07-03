/**
 * 3D Chinese Temple Virtual Tour
 * A premium 3D experience featuring traditional Chinese architecture
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import './temple.css';

// ===== Constants =====
const MOVE_SPEED = 10.0;
const PLAYER_HEIGHT = 1.7;
const COURTYARD_SIZE = 100;
const TEMPLE_WIDTH = 40;
const TEMPLE_LENGTH = 30;
const TEMPLE_HEIGHT = 12;
const PILLAR_RADIUS = 0.6;

// ===== Global Variables =====
let scene, camera, renderer, controls;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let velocity = new THREE.Vector3();
let direction = new THREE.Vector3();
let prevTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = 0;

// Lighting objects for dynamic updates
let ambientLight, sunMoonLight, fillLight, pillarLights = [];

// ===== DOM Elements =====
const loadingScreen = document.getElementById('loading-screen');
const instructions = document.getElementById('instructions');
const hud = document.getElementById('hud');
const fpsCounter = document.getElementById('fps');
const locationLabel = document.getElementById('location');
const progressFill = document.getElementById('progress-fill');
const timeButtons = document.querySelectorAll('.time-selector button');

// ===== Initialize =====
init();
animate();

function init() {
  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);
  scene.fog = new THREE.FogExp2(0x050510, 0.012);

  // Camera setup
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, PLAYER_HEIGHT, 50);

  // Renderer setup
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  // Controls setup
  controls = new PointerLockControls(camera, document.body);

  controls.addEventListener('lock', () => {
    instructions.classList.add('hidden');
    hud.classList.remove('hidden');
  });

  controls.addEventListener('unlock', () => {
    instructions.classList.remove('hidden');
    hud.classList.add('hidden');
  });

  instructions.addEventListener('click', () => {
    controls.lock();
  });

  // Load Textures
  const textureLoader = new THREE.TextureLoader();
  const floorTex = textureLoader.load('/textures/floor.png');
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(10, 10);

  const wallTex = textureLoader.load('/textures/wall.png');
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;

  const dragonTex = textureLoader.load('/textures/dragon.png');
  dragonTex.wrapS = THREE.RepeatWrapping;
  dragonTex.repeat.set(0.32, 1);
  dragonTex.offset.set(0.34, 0);

  const stoneLionTex = textureLoader.load('/textures/stone_lion.png');
  stoneLionTex.wrapS = stoneLionTex.wrapT = THREE.RepeatWrapping;

  // Build the scene
  updateProgress(10);
  createEnvironment(floorTex);
  updateProgress(30);
  createLighting();
  updateProgress(50);
  createPailou(dragonTex);
  updateProgress(70);
  createMainHall(wallTex, dragonTex);
  updateProgress(80);
  createDecorations(stoneLionTex);
  updateProgress(100);

  // Default to Night (as requested in original feel, or user can switch)
  setTimeOfDay('night');

  // Event Listeners
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onWindowResize);

  // Time selector listeners
  timeButtons.forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      const time = btn.getAttribute('data-time');
      updateTimeUI(time);
      e.stopPropagation();
    });
  });

  // Hide loading screen
  setTimeout(() => {
    loadingScreen.classList.add('hidden');
  }, 1500);
}

function updateProgress(percent) {
  if (progressFill) {
    progressFill.style.width = `${percent}%`;
  }
}

// ===== Environment =====
function createEnvironment(floorTex) {
  const groundGeo = new THREE.PlaneGeometry(COURTYARD_SIZE * 2, COURTYARD_SIZE * 2);
  const groundMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.8,
    metalness: 0.1
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const mountainGeo = new THREE.CylinderGeometry(200, 250, 60, 32, 1, true);
  const mountainMat = new THREE.MeshBasicMaterial({
    color: 0x020205,
    side: THREE.BackSide
  });
  const mountains = new THREE.Mesh(mountainGeo, mountainMat);
  mountains.position.y = 20;
  scene.add(mountains);
}

// ===== Dynamic Lighting Logic =====
function createLighting() {
  // Initialize persistent lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  sunMoonLight = new THREE.DirectionalLight(0xffffff, 1.0);
  sunMoonLight.position.set(-30, 80, 40);
  sunMoonLight.castShadow = true;
  sunMoonLight.shadow.camera.left = -100;
  sunMoonLight.shadow.camera.right = 100;
  sunMoonLight.shadow.camera.top = 100;
  sunMoonLight.shadow.camera.bottom = -100;
  sunMoonLight.shadow.mapSize.width = 4096;
  sunMoonLight.shadow.mapSize.height = 4096;
  scene.add(sunMoonLight);

  fillLight = new THREE.PointLight(0xffffff, 1.0, 200);
  fillLight.position.set(0, 50, 20);
  scene.add(fillLight);
}

function setTimeOfDay(time) {
  const configs = {
    morning: {
      ambient: 0xffe0b0, ambientInt: 0.7,
      sun: 0xffccaa, sunInt: 1.5, sunPos: [-100, 40, 20],
      fill: 0xffd0a0, fillInt: 0.8,
      bg: 0x87ceeb, fog: 0x87ceeb, fogDensity: 0.005,
      pillarLights: 0.2, // Low intensity for extra lights in day
      toneExposure: 1.1
    },
    noon: {
      ambient: 0xffffff, ambientInt: 1.0,
      sun: 0xffffeb, sunInt: 2.5, sunPos: [0, 150, 0],
      fill: 0xffffff, fillInt: 1.2,
      bg: 0x4aa9ff, fog: 0x8ec2ff, fogDensity: 0.002,
      pillarLights: 0.1,
      toneExposure: 1.0
    },
    afternoon: {
      ambient: 0xffd0a0, ambientInt: 0.7,
      sun: 0xff8811, sunInt: 2.0, sunPos: [100, 30, 20],
      fill: 0xffaa66, fillInt: 1.0,
      bg: 0xff7e42, fog: 0xffa07a, fogDensity: 0.004,
      pillarLights: 0.3,
      toneExposure: 1.2
    },
    night: {
      ambient: 0x203060, ambientInt: 0.8,
      sun: 0xa0b0ff, sunInt: 1.2, sunPos: [-30, 80, 40],
      fill: 0xaa88ff, fillInt: 1.5,
      bg: 0x050510, fog: 0x050510, fogDensity: 0.012,
      pillarLights: 0.8,
      toneExposure: 1.3
    }
  };

  const c = configs[time];

  // Transition logic (instant for now, could be tweened)
  ambientLight.color.setHex(c.ambient);
  ambientLight.intensity = c.ambientInt;

  sunMoonLight.color.setHex(c.sun);
  sunMoonLight.intensity = c.sunInt;
  sunMoonLight.position.set(...c.sunPos);

  fillLight.color.setHex(c.fill);
  fillLight.intensity = c.fillInt;

  scene.background.setHex(c.bg);
  scene.fog.color.setHex(c.fog);
  scene.fog.density = c.fogDensity;

  renderer.toneMappingExposure = c.toneExposure;

  // Update pillar lights intensity
  pillarLights.forEach(pl => {
    pl.intensity = c.pillarLights;
  });
}

function updateTimeUI(time) {
  setTimeOfDay(time);
  timeButtons.forEach(btn => {
    if (btn.getAttribute('data-time') === time) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// ===== Architectural Helpers =====
function createCurvedRoof(width, length, height, color, yOffset) {
  const group = new THREE.Group();
  const segments = 12;
  for (let i = 0; i < segments; i++) {
    const t1 = i / segments;
    const h1 = height * Math.pow(t1, 2);
    const geometry = new THREE.BoxGeometry(width, 0.2, length / segments);
    const material = new THREE.MeshStandardMaterial({ color: color });
    const section = new THREE.Mesh(geometry, material);
    section.position.y = h1;
    section.position.z = (length / 2) - (i * length / segments) - (length / segments / 2);
    const t2 = (i + 1) / segments;
    const h2 = height * Math.pow(t2, 2);
    const slope = (h2 - h1) / (length / segments);
    section.rotation.x = Math.atan(slope);
    group.add(section);
  }
  const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  [-1, 1].forEach(sideX => {
    [-1, 1].forEach(sideZ => {
      const ridgeGeo = new THREE.CylinderGeometry(0.1, 0.25, 2.5, 8);
      const ridge = new THREE.Mesh(ridgeGeo, ridgeMat);
      ridge.position.set(sideX * width / 2, height + 0.5, sideZ * length / 2);
      const dir = new THREE.Vector3(sideX, 1, sideZ).normalize();
      ridge.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      group.add(ridge);
    });
  });
  group.position.y = yOffset;
  return group;
}

// ===== Pailou =====
function createPailou(dragonTex) {
  const group = new THREE.Group();
  const redMat = new THREE.MeshStandardMaterial({ color: 0xa02020 });

  const dragonPillarMat = new THREE.MeshStandardMaterial({
    map: dragonTex,
    color: 0xffffff,
    metalness: 0.1,
    roughness: 0.3,
    emissive: 0xff4433,
    emissiveIntensity: 0.05
  });

  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.6, roughness: 0.2 });
  const pillarPos = [-6, -2, 2, 6];
  pillarPos.forEach(x => {
    const colGeo = new THREE.CylinderGeometry(0.4, 0.4, 8, 32);
    const col = new THREE.Mesh(colGeo, dragonPillarMat);
    col.position.set(x, 4, 0);
    col.castShadow = true;
    group.add(col);

    // Add point lights that we can toggle
    const pLight = new THREE.PointLight(0xffaa66, 0.8, 6);
    pLight.position.set(x, 4, 1.5);
    group.add(pLight);
    pillarLights.push(pLight);

    const baseGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.5, 16);
    const base = new THREE.Mesh(baseGeo, goldMat);
    base.position.set(x, 0.25, 0);
    group.add(base);
  });
  const beamGeo = new THREE.BoxGeometry(14, 0.8, 0.6);
  const beam = new THREE.Mesh(beamGeo, redMat);
  beam.position.set(0, 7.5, 0);
  group.add(beam);
  const subBeamGeo = new THREE.BoxGeometry(14, 0.5, 0.4);
  const subBeam = new THREE.Mesh(subBeamGeo, goldMat);
  subBeam.position.set(0, 6.8, 0);
  group.add(subBeam);
  const roof = createCurvedRoof(16, 4, 3, 0x1d4d38, 8);
  group.add(roof);
  group.position.set(0, 0, 30);
  scene.add(group);
}

// ===== Main Hall =====
function createMainHall(wallTex, dragonTex) {
  const hall = new THREE.Group();
  const redMat = new THREE.MeshStandardMaterial({ color: 0xa02020 });
  const dragonPillarMat = new THREE.MeshStandardMaterial({
    map: dragonTex,
    color: 0xffffff,
    metalness: 0.1,
    roughness: 0.3,
    emissive: 0xff4433,
    emissiveIntensity: 0.05
  });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.6, roughness: 0.2 });
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x777777 });
  const decoMat = new THREE.MeshStandardMaterial({ map: wallTex, color: 0xcccccc });

  const baseGeo = new THREE.BoxGeometry(TEMPLE_WIDTH + 4, 1.5, TEMPLE_LENGTH + 4);
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.y = 0.75;
  base.receiveShadow = true;
  hall.add(base);
  const stepGeo = new THREE.BoxGeometry(10, 0.3, 4);
  for (let i = 0; i < 5; i++) {
    const step = new THREE.Mesh(stepGeo, baseMat);
    step.position.set(0, 0.15 + i * 0.3, TEMPLE_LENGTH / 2 + 2 + i * 0.5);
    hall.add(step);
  }
  const colX = (TEMPLE_WIDTH / 2) - 2;
  const colZ = (TEMPLE_LENGTH / 2) - 2;
  [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].forEach(pos => {
    const colGeo = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, TEMPLE_HEIGHT, 32);
    const col = new THREE.Mesh(colGeo, dragonPillarMat);
    col.position.set(pos[0] * colX, TEMPLE_HEIGHT / 2 + 1.5, pos[1] * colZ);
    col.castShadow = true;
    hall.add(col);

    // Pillar focus lights for main hall
    const pLight = new THREE.PointLight(0xffaa66, 0.5, 10);
    pLight.position.set(pos[0] * (colX - 1.5), TEMPLE_HEIGHT / 2, pos[1] * (colZ - 1.5));
    hall.add(pLight);
    pillarLights.push(pLight);
  });
  const backWallGeo = new THREE.PlaneGeometry(TEMPLE_WIDTH, TEMPLE_HEIGHT);
  const backWall = new THREE.Mesh(backWallGeo, decoMat);
  backWall.position.set(0, TEMPLE_HEIGHT / 2 + 1.5, -TEMPLE_LENGTH / 2);
  hall.add(backWall);
  const sideWallGeo = new THREE.PlaneGeometry(TEMPLE_LENGTH, TEMPLE_HEIGHT);
  const leftWall = new THREE.Mesh(sideWallGeo, decoMat);
  leftWall.position.set(-TEMPLE_WIDTH / 2, TEMPLE_HEIGHT / 2 + 1.5, 0);
  leftWall.rotation.y = Math.PI / 2;
  hall.add(leftWall);
  const rightWall = new THREE.Mesh(sideWallGeo, decoMat);
  rightWall.position.set(TEMPLE_WIDTH / 2, TEMPLE_HEIGHT / 2 + 1.5, 0);
  rightWall.rotation.y = -Math.PI / 2;
  hall.add(rightWall);
  const frontWallGeo = new THREE.PlaneGeometry((TEMPLE_WIDTH - 10) / 2, TEMPLE_HEIGHT);
  const frontLeft = new THREE.Mesh(frontWallGeo, decoMat);
  frontLeft.position.set(-TEMPLE_WIDTH / 4 - 2.5, TEMPLE_HEIGHT / 2 + 1.5, TEMPLE_LENGTH / 2);
  frontLeft.rotation.y = Math.PI;
  hall.add(frontLeft);
  const frontRight = new THREE.Mesh(frontWallGeo, decoMat);
  frontRight.position.set(TEMPLE_WIDTH / 4 + 2.5, TEMPLE_HEIGHT / 2 + 1.5, TEMPLE_LENGTH / 2);
  frontRight.rotation.y = Math.PI;
  hall.add(frontRight);
  const lowerRoof = createCurvedRoof(TEMPLE_WIDTH + 8, TEMPLE_LENGTH + 8, 5, 0x1d4d38, TEMPLE_HEIGHT * 0.7 + 1.5);
  hall.add(lowerRoof);
  const upperRoof = createCurvedRoof(TEMPLE_WIDTH * 0.7 + 4, TEMPLE_LENGTH * 0.7 + 4, 6, 0x0d3d28, TEMPLE_HEIGHT + 1.5);
  hall.add(upperRoof);
  createInteriorSub(hall, goldMat, redMat);
  scene.add(hall);
}

function createInteriorSub(hall, goldMat, redMat) {
  const altarGeo = new THREE.BoxGeometry(10, 1.5, 4);
  const altar = new THREE.Mesh(altarGeo, redMat);
  altar.position.set(0, 2.25, -TEMPLE_LENGTH / 2 + 6);
  altar.castShadow = true;
  hall.add(altar);
  const altarTop = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.2, 4.5), goldMat);
  altarTop.position.set(0, 3.1, -TEMPLE_LENGTH / 2 + 6);
  hall.add(altarTop);
  const baseGeo = new THREE.CylinderGeometry(2, 2.5, 1, 16);
  const base = new THREE.Mesh(baseGeo, goldMat);
  base.position.set(0, 3.7, -TEMPLE_LENGTH / 2 + 5);
  hall.add(base);
  const bodyGeo = new THREE.SphereGeometry(1.5, 16, 16);
  const body = new THREE.Mesh(bodyGeo, goldMat);
  body.position.set(0, 5.5, -TEMPLE_LENGTH / 2 + 5);
  hall.add(body);
  const headGeo = new THREE.SphereGeometry(0.8, 16, 16);
  const head = new THREE.Mesh(headGeo, goldMat);
  head.position.set(0, 7.5, -TEMPLE_LENGTH / 2 + 5);
  hall.add(head);
  const halo = new THREE.PointLight(0xffea00, 5, 25);
  halo.position.set(0, 7.5, -TEMPLE_LENGTH / 2 + 4.5);
  hall.add(halo);
}

// ===== Decorations =====
function createDecorations(stoneLionTex) {
  const group = new THREE.Group();
  const bronzeMat = new THREE.MeshStandardMaterial({ color: 0x6a5a4a, roughness: 0.3, metalness: 0.8 });
  const bowlGeo = new THREE.SphereGeometry(2, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const bowl = new THREE.Mesh(bowlGeo, bronzeMat);
  bowl.rotation.x = Math.PI;
  bowl.position.y = 2.5;
  group.add(bowl);
  const lidGeo = new THREE.CylinderGeometry(2.1, 2.1, 0.2, 16);
  const lid = new THREE.Mesh(lidGeo, bronzeMat);
  lid.position.y = 2.5;
  group.add(lid);
  [[-1.2, -1.2], [1.2, -1.2], [0, 1.5]].forEach(p => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.1, 2, 8), bronzeMat);
    leg.position.set(p[0], 1, p[1]);
    group.add(leg);
  });
  const smokeParticles = new THREE.Group();
  for (let i = 0; i < 20; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.3 })
    );
    p.position.set((Math.random() - 0.5), 2.6 + Math.random() * 2, (Math.random() - 0.5));
    smokeParticles.add(p);
  }
  group.add(smokeParticles);
  group.position.set(0, 0, 15);
  scene.add(group);

  for (let i = 0; i < 10; i++) {
    createLantern({ x: -15, y: 10, z: 25 - i * 8 });
    createLantern({ x: 15, y: 10, z: 25 - i * 8 });
  }

  createStoneLion({ x: -4, y: 0, z: 34 }, stoneLionTex);
  createStoneLion({ x: 4, y: 0, z: 34 }, stoneLionTex);
}

function createStoneLion(pos, stoneTex) {
  const group = new THREE.Group();
  const lionMat = new THREE.MeshStandardMaterial({
    map: stoneTex,
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0
  });

  const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.8, 1.5), lionMat);
  base.position.y = 0.4;
  group.add(base);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 1.2), lionMat);
  body.position.y = 1.3;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 12), lionMat);
  head.position.set(0, 1.8, 0.4);
  group.add(head);
  const mane = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.15, 8, 16), lionMat);
  mane.position.set(0, 1.8, 0.3);
  mane.rotation.y = Math.PI / 2;
  group.add(mane);
  [[-0.3, 0.4], [0.3, 0.4], [-0.3, -0.4], [0.3, -0.4]].forEach(p => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 8), lionMat);
    leg.position.set(p[0], 1.1, p[1]);
    group.add(leg);
  });
  const tail = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 8, 8, Math.PI / 2), lionMat);
  tail.position.set(0, 1.2, -0.6);
  tail.rotation.x = -Math.PI / 4;
  group.add(tail);
  group.position.set(pos.x, pos.y, pos.z);
  scene.add(group);
}

function createLantern(pos) {
  const group = new THREE.Group();
  const redMat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
  const goldMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 12), redMat);
  body.scale.y = 1.3;
  group.add(body);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.2, 8), goldMat);
  top.position.y = 1;
  group.add(top);
  const bot = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.2, 8), goldMat);
  bot.position.y = -1;
  group.add(bot);
  const light = new THREE.PointLight(0xff5522, 2.5, 12);
  group.add(light);
  group.position.set(pos.x, pos.y, pos.z);
  scene.add(group);
}

function onKeyDown(event) {
  switch (event.code) {
    case 'KeyW': moveForward = true; break;
    case 'KeyA': moveLeft = true; break;
    case 'KeyS': moveBackward = true; break;
    case 'KeyD': moveRight = true; break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'KeyW': moveForward = false; break;
    case 'KeyA': moveLeft = false; break;
    case 'KeyS': moveBackward = false; break;
    case 'KeyD': moveRight = false; break;

    // Time shortcuts
    case 'Digit1': updateTimeUI('morning'); break;
    case 'Digit2': updateTimeUI('noon'); break;
    case 'Digit3': updateTimeUI('afternoon'); break;
    case 'Digit4': updateTimeUI('night'); break;
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function checkCollision(newPos) {
  if (newPos.z > 20) {
    locationLabel.textContent = "廟宇入口";
  } else if (newPos.z < 15 && newPos.z > -15) {
    locationLabel.textContent = "大雄寶殿";
  } else {
    locationLabel.textContent = "前庭院";
  }
  newPos.x = Math.max(-80, Math.min(80, newPos.x));
  newPos.z = Math.max(-80, Math.min(80, newPos.z));
  return newPos;
}

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now();
  const delta = (time - prevTime) / 1000;
  frameCount++;
  if (time - lastFpsUpdate > 1000) {
    fpsCounter.textContent = `FPS: ${frameCount}`;
    frameCount = 0;
    lastFpsUpdate = time;
  }
  if (controls.isLocked) {
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    direction.z = Number(moveForward) - Number(moveBackward);
    direction.x = Number(moveRight) - Number(moveLeft);
    direction.normalize();
    if (moveForward || moveBackward) velocity.z -= direction.z * MOVE_SPEED * delta * 20;
    if (moveLeft || moveRight) velocity.x -= direction.x * MOVE_SPEED * delta * 20;
    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);
    const correctedPos = checkCollision(camera.position.clone());
    camera.position.copy(correctedPos);
    camera.position.y = PLAYER_HEIGHT;
  }
  prevTime = time;
  renderer.render(scene, camera);
}
