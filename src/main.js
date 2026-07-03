/**
 * 3D Church Virtual Tour - Main Entry Point
 * Initializes Three.js scene with first-person controls
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import './style.css';

// ===== Constants =====
const MOVE_SPEED = 8.0;
const PLAYER_HEIGHT = 1.7;
const CHURCH_WIDTH = 30;
const CHURCH_LENGTH = 50;
const CHURCH_HEIGHT = 15;
const COLUMN_RADIUS = 0.5;
const COLUMN_COUNT = 6;

// ===== Global Variables =====
let scene, camera, renderer, controls;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let velocity = new THREE.Vector3();
let direction = new THREE.Vector3();
let prevTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = 0;

// ===== DOM Elements =====
const loadingScreen = document.getElementById('loading-screen');
const instructions = document.getElementById('instructions');
const hud = document.getElementById('hud');
const fpsCounter = document.getElementById('fps');
const progressFill = document.getElementById('progress-fill');

// ===== Initialize =====
init();
animate();

function init() {
  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 5, 60);

  // Camera setup
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, PLAYER_HEIGHT, CHURCH_LENGTH / 2 - 5);

  // Renderer setup
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
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

  // Build the scene
  updateProgress(20);
  createLighting();
  updateProgress(40);
  createChurchStructure();
  updateProgress(60);
  createInterior();
  updateProgress(80);
  createDecorations();
  updateProgress(100);

  // Keyboard controls
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // Window resize
  window.addEventListener('resize', onWindowResize);

  // Hide loading screen after short delay
  setTimeout(() => {
    loadingScreen.classList.add('hidden');
  }, 1000);
}

function updateProgress(percent) {
  if (progressFill) {
    progressFill.style.width = `${percent}%`;
  }
}

// ===== Lighting =====
function createLighting() {
  // Ambient light for base illumination
  const ambient = new THREE.AmbientLight(0x404060, 0.3);
  scene.add(ambient);

  // Main directional light (sun through windows)
  const sunLight = new THREE.DirectionalLight(0xffd4a6, 1.2);
  sunLight.position.set(10, 20, 5);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 50;
  sunLight.shadow.camera.left = -30;
  sunLight.shadow.camera.right = 30;
  sunLight.shadow.camera.top = 30;
  sunLight.shadow.camera.bottom = -30;
  scene.add(sunLight);

  // Altar spotlight
  const altarSpot = new THREE.SpotLight(0xffffff, 2);
  altarSpot.position.set(0, CHURCH_HEIGHT - 2, -CHURCH_LENGTH / 2 + 8);
  altarSpot.target.position.set(0, 0, -CHURCH_LENGTH / 2 + 5);
  altarSpot.angle = Math.PI / 6;
  altarSpot.penumbra = 0.5;
  altarSpot.castShadow = true;
  scene.add(altarSpot);
  scene.add(altarSpot.target);

  // Candle lights along the sides
  const candlePositions = [
    { x: -CHURCH_WIDTH / 2 + 2, z: 0 },
    { x: CHURCH_WIDTH / 2 - 2, z: 0 },
    { x: -CHURCH_WIDTH / 2 + 2, z: -10 },
    { x: CHURCH_WIDTH / 2 - 2, z: -10 },
  ];

  candlePositions.forEach(pos => {
    const candleLight = new THREE.PointLight(0xff9933, 0.8, 10);
    candleLight.position.set(pos.x, 2, pos.z);
    scene.add(candleLight);
  });
}

// ===== Church Structure =====
function createChurchStructure() {
  // Materials
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x8b7355,
    roughness: 0.9,
    metalness: 0.1,
  });

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3c31,
    roughness: 0.8,
    metalness: 0.1,
  });

  const marbleMaterial = new THREE.MeshStandardMaterial({
    color: 0xe8e0d5,
    roughness: 0.3,
    metalness: 0.1,
  });

  // Floor
  const floorGeometry = new THREE.PlaneGeometry(CHURCH_WIDTH, CHURCH_LENGTH);
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Floor pattern - center aisle
  const aisleGeometry = new THREE.PlaneGeometry(4, CHURCH_LENGTH);
  const aisleMaterial = new THREE.MeshStandardMaterial({
    color: 0x722f37,
    roughness: 0.6,
  });
  const aisle = new THREE.Mesh(aisleGeometry, aisleMaterial);
  aisle.rotation.x = -Math.PI / 2;
  aisle.position.y = 0.01;
  scene.add(aisle);

  // Ceiling
  const ceilingGeometry = new THREE.PlaneGeometry(CHURCH_WIDTH, CHURCH_LENGTH);
  const ceiling = new THREE.Mesh(ceilingGeometry, stoneMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = CHURCH_HEIGHT;
  scene.add(ceiling);

  // Walls
  createWall(stoneMaterial, CHURCH_LENGTH, CHURCH_HEIGHT, { x: -CHURCH_WIDTH / 2, y: CHURCH_HEIGHT / 2, z: 0 }, Math.PI / 2); // Left
  createWall(stoneMaterial, CHURCH_LENGTH, CHURCH_HEIGHT, { x: CHURCH_WIDTH / 2, y: CHURCH_HEIGHT / 2, z: 0 }, -Math.PI / 2); // Right
  createWall(stoneMaterial, CHURCH_WIDTH, CHURCH_HEIGHT, { x: 0, y: CHURCH_HEIGHT / 2, z: -CHURCH_LENGTH / 2 }, 0); // Back (altar)
  createWall(stoneMaterial, CHURCH_WIDTH, CHURCH_HEIGHT, { x: 0, y: CHURCH_HEIGHT / 2, z: CHURCH_LENGTH / 2 }, Math.PI); // Front (entrance)

  // Columns
  const columnSpacing = CHURCH_LENGTH / (COLUMN_COUNT + 1);
  for (let i = 1; i <= COLUMN_COUNT; i++) {
    const z = CHURCH_LENGTH / 2 - i * columnSpacing;
    createColumn(marbleMaterial, -CHURCH_WIDTH / 2 + 4, z);
    createColumn(marbleMaterial, CHURCH_WIDTH / 2 - 4, z);
  }

  // Arches between columns
  for (let i = 1; i < COLUMN_COUNT; i++) {
    const z = CHURCH_LENGTH / 2 - i * columnSpacing - columnSpacing / 2;
    createArch(stoneMaterial, -CHURCH_WIDTH / 2 + 4, z);
    createArch(stoneMaterial, CHURCH_WIDTH / 2 - 4, z);
  }
}

function createWall(material, width, height, position, rotationY) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const wall = new THREE.Mesh(geometry, material);
  wall.position.set(position.x, position.y, position.z);
  wall.rotation.y = rotationY;
  wall.receiveShadow = true;
  scene.add(wall);
}

function createColumn(material, x, z) {
  // Column base
  const baseGeometry = new THREE.BoxGeometry(1.2, 0.3, 1.2);
  const base = new THREE.Mesh(baseGeometry, material);
  base.position.set(x, 0.15, z);
  base.castShadow = true;
  scene.add(base);

  // Column shaft
  const shaftGeometry = new THREE.CylinderGeometry(COLUMN_RADIUS, COLUMN_RADIUS * 1.1, CHURCH_HEIGHT - 2, 16);
  const shaft = new THREE.Mesh(shaftGeometry, material);
  shaft.position.set(x, CHURCH_HEIGHT / 2 - 0.5, z);
  shaft.castShadow = true;
  scene.add(shaft);

  // Column capital
  const capitalGeometry = new THREE.BoxGeometry(1.4, 0.5, 1.4);
  const capital = new THREE.Mesh(capitalGeometry, material);
  capital.position.set(x, CHURCH_HEIGHT - 1.5, z);
  capital.castShadow = true;
  scene.add(capital);
}

function createArch(material, x, z) {
  // Simple arch representation using a torus segment
  const archGeometry = new THREE.TorusGeometry(2, 0.3, 8, 16, Math.PI);
  const arch = new THREE.Mesh(archGeometry, material);
  arch.position.set(x, CHURCH_HEIGHT - 3, z);
  arch.rotation.z = Math.PI;
  arch.rotation.y = Math.PI / 2;
  scene.add(arch);
}

// ===== Interior =====
function createInterior() {
  // Altar
  createAltar();

  // Pews
  createPews();

  // Stained glass windows
  createStainedGlassWindows();
}

function createAltar() {
  const marbleMaterial = new THREE.MeshStandardMaterial({
    color: 0xf5f5f5,
    roughness: 0.2,
    metalness: 0.3,
  });

  const goldMaterial = new THREE.MeshStandardMaterial({
    color: 0xd4af37,
    roughness: 0.3,
    metalness: 0.8,
  });

  // Altar platform
  const platformGeometry = new THREE.BoxGeometry(8, 0.4, 6);
  const platform = new THREE.Mesh(platformGeometry, marbleMaterial);
  platform.position.set(0, 0.2, -CHURCH_LENGTH / 2 + 6);
  platform.castShadow = true;
  platform.receiveShadow = true;
  scene.add(platform);

  // Main altar table
  const altarGeometry = new THREE.BoxGeometry(4, 1.2, 2);
  const altar = new THREE.Mesh(altarGeometry, marbleMaterial);
  altar.position.set(0, 1, -CHURCH_LENGTH / 2 + 5);
  altar.castShadow = true;
  scene.add(altar);

  // Cross behind altar
  const crossVertical = new THREE.BoxGeometry(0.3, 4, 0.2);
  const crossHorizontal = new THREE.BoxGeometry(2, 0.3, 0.2);
  
  const crossV = new THREE.Mesh(crossVertical, goldMaterial);
  crossV.position.set(0, 6, -CHURCH_LENGTH / 2 + 2);
  crossV.castShadow = true;
  scene.add(crossV);

  const crossH = new THREE.Mesh(crossHorizontal, goldMaterial);
  crossH.position.set(0, 7.2, -CHURCH_LENGTH / 2 + 2);
  crossH.castShadow = true;
  scene.add(crossH);

  // Candles on altar
  const candleMaterial = new THREE.MeshStandardMaterial({ color: 0xfff8dc });
  const flameMaterial = new THREE.MeshStandardMaterial({ 
    color: 0xff6600, 
    emissive: 0xff3300,
    emissiveIntensity: 0.5 
  });

  [-1.2, 1.2].forEach(x => {
    const candleGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.5, 8);
    const candle = new THREE.Mesh(candleGeometry, candleMaterial);
    candle.position.set(x, 1.85, -CHURCH_LENGTH / 2 + 5);
    scene.add(candle);

    const flameGeometry = new THREE.ConeGeometry(0.05, 0.15, 8);
    const flame = new THREE.Mesh(flameGeometry, flameMaterial);
    flame.position.set(x, 2.2, -CHURCH_LENGTH / 2 + 5);
    scene.add(flame);
  });
}

function createPews() {
  const woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3728,
    roughness: 0.7,
    metalness: 0.1,
  });

  const pewRows = 10;
  const pewsPerRow = 2; // Left and right side
  const pewWidth = 5;
  const pewDepth = 0.8;
  const pewHeight = 0.9;
  const pewSpacing = 1.8;
  const startZ = 10;

  for (let row = 0; row < pewRows; row++) {
    const z = startZ - row * pewSpacing;
    
    for (let side = 0; side < pewsPerRow; side++) {
      const x = side === 0 ? -pewWidth / 2 - 1.5 : pewWidth / 2 + 1.5;
      
      // Pew seat
      const seatGeometry = new THREE.BoxGeometry(pewWidth, 0.1, pewDepth);
      const seat = new THREE.Mesh(seatGeometry, woodMaterial);
      seat.position.set(x, 0.5, z);
      seat.castShadow = true;
      seat.receiveShadow = true;
      scene.add(seat);

      // Pew back
      const backGeometry = new THREE.BoxGeometry(pewWidth, pewHeight - 0.5, 0.1);
      const back = new THREE.Mesh(backGeometry, woodMaterial);
      back.position.set(x, pewHeight - 0.2, z - pewDepth / 2 + 0.05);
      back.castShadow = true;
      scene.add(back);

      // Pew supports
      [-pewWidth / 2 + 0.1, pewWidth / 2 - 0.1].forEach(supportX => {
        const supportGeometry = new THREE.BoxGeometry(0.1, 0.5, pewDepth);
        const support = new THREE.Mesh(supportGeometry, woodMaterial);
        support.position.set(x + supportX - x + x, 0.25, z);
        support.position.x = x + (supportX === -pewWidth / 2 + 0.1 ? -pewWidth / 2 + 0.1 : pewWidth / 2 - 0.1);
        scene.add(support);
      });
    }
  }
}

function createStainedGlassWindows() {
  // Window positions along the walls
  const windowPositions = [
    { x: -CHURCH_WIDTH / 2 + 0.1, z: -15, rotY: Math.PI / 2 },
    { x: -CHURCH_WIDTH / 2 + 0.1, z: 0, rotY: Math.PI / 2 },
    { x: -CHURCH_WIDTH / 2 + 0.1, z: 15, rotY: Math.PI / 2 },
    { x: CHURCH_WIDTH / 2 - 0.1, z: -15, rotY: -Math.PI / 2 },
    { x: CHURCH_WIDTH / 2 - 0.1, z: 0, rotY: -Math.PI / 2 },
    { x: CHURCH_WIDTH / 2 - 0.1, z: 15, rotY: -Math.PI / 2 },
  ];

  const colors = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xf38181, 0xaa96da];

  windowPositions.forEach((pos, index) => {
    // Window frame
    const frameGeometry = new THREE.BoxGeometry(0.2, 6, 3);
    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x3c3c3c });
    const frame = new THREE.Mesh(frameGeometry, frameMaterial);
    frame.position.set(pos.x, 7, pos.z);
    scene.add(frame);

    // Stained glass
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: colors[index % colors.length],
      emissive: colors[index % colors.length],
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });

    const glassGeometry = new THREE.PlaneGeometry(2.5, 5.5);
    const glass = new THREE.Mesh(glassGeometry, glassMaterial);
    glass.position.set(pos.x, 7, pos.z);
    glass.rotation.y = pos.rotY;
    scene.add(glass);

    // Add point light behind each window to simulate light coming through
    const windowLight = new THREE.PointLight(colors[index % colors.length], 0.5, 15);
    windowLight.position.set(
      pos.x + (pos.x > 0 ? -2 : 2),
      7,
      pos.z
    );
    scene.add(windowLight);
  });

  // Large rose window at the back (behind altar)
  const roseWindowMaterial = new THREE.MeshStandardMaterial({
    color: 0xd4af37,
    emissive: 0xd4af37,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.8,
  });

  const roseGeometry = new THREE.CircleGeometry(3, 32);
  const roseWindow = new THREE.Mesh(roseGeometry, roseWindowMaterial);
  roseWindow.position.set(0, 11, -CHURCH_LENGTH / 2 + 0.1);
  scene.add(roseWindow);

  // Rose window light
  const roseLight = new THREE.PointLight(0xffd700, 1, 20);
  roseLight.position.set(0, 11, -CHURCH_LENGTH / 2 + 3);
  scene.add(roseLight);
}

// ===== Decorations =====
function createDecorations() {
  // Add some floating dust particles for atmosphere
  const particlesGeometry = new THREE.BufferGeometry();
  const particleCount = 500;
  const positions = new Float32Array(particleCount * 3);

  for (let i = 0; i < particleCount * 3; i += 3) {
    positions[i] = (Math.random() - 0.5) * CHURCH_WIDTH;
    positions[i + 1] = Math.random() * CHURCH_HEIGHT;
    positions[i + 2] = (Math.random() - 0.5) * CHURCH_LENGTH;
  }

  particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const particlesMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.05,
    transparent: true,
    opacity: 0.4,
  });

  const particles = new THREE.Points(particlesGeometry, particlesMaterial);
  scene.add(particles);
}

// ===== Event Handlers =====
function onKeyDown(event) {
  switch (event.code) {
    case 'ArrowUp':
    case 'KeyW':
      moveForward = true;
      break;
    case 'ArrowLeft':
    case 'KeyA':
      moveLeft = true;
      break;
    case 'ArrowDown':
    case 'KeyS':
      moveBackward = true;
      break;
    case 'ArrowRight':
    case 'KeyD':
      moveRight = true;
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'ArrowUp':
    case 'KeyW':
      moveForward = false;
      break;
    case 'ArrowLeft':
    case 'KeyA':
      moveLeft = false;
      break;
    case 'ArrowDown':
    case 'KeyS':
      moveBackward = false;
      break;
    case 'ArrowRight':
    case 'KeyD':
      moveRight = false;
      break;
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ===== Collision Detection =====
function checkCollision(newPosition) {
  const padding = 1; // Distance from walls
  const halfWidth = CHURCH_WIDTH / 2 - padding;
  const halfLength = CHURCH_LENGTH / 2 - padding;

  // Clamp position within church bounds
  newPosition.x = Math.max(-halfWidth, Math.min(halfWidth, newPosition.x));
  newPosition.z = Math.max(-halfLength, Math.min(halfLength, newPosition.z));

  // Check collision with columns
  const columnSpacing = CHURCH_LENGTH / (COLUMN_COUNT + 1);
  for (let i = 1; i <= COLUMN_COUNT; i++) {
    const z = CHURCH_LENGTH / 2 - i * columnSpacing;
    const leftColX = -CHURCH_WIDTH / 2 + 4;
    const rightColX = CHURCH_WIDTH / 2 - 4;

    // Distance check for each column
    const distLeft = Math.sqrt(
      Math.pow(newPosition.x - leftColX, 2) + 
      Math.pow(newPosition.z - z, 2)
    );
    const distRight = Math.sqrt(
      Math.pow(newPosition.x - rightColX, 2) + 
      Math.pow(newPosition.z - z, 2)
    );

    const minDist = COLUMN_RADIUS + 0.5;
    if (distLeft < minDist) {
      const angle = Math.atan2(newPosition.z - z, newPosition.x - leftColX);
      newPosition.x = leftColX + Math.cos(angle) * minDist;
      newPosition.z = z + Math.sin(angle) * minDist;
    }
    if (distRight < minDist) {
      const angle = Math.atan2(newPosition.z - z, newPosition.x - rightColX);
      newPosition.x = rightColX + Math.cos(angle) * minDist;
      newPosition.z = z + Math.sin(angle) * minDist;
    }
  }

  // Check altar platform collision
  const altarBounds = {
    minX: -4,
    maxX: 4,
    minZ: -CHURCH_LENGTH / 2 + 3,
    maxZ: -CHURCH_LENGTH / 2 + 9,
  };

  if (
    newPosition.x > altarBounds.minX - 0.5 &&
    newPosition.x < altarBounds.maxX + 0.5 &&
    newPosition.z > altarBounds.minZ - 0.5 &&
    newPosition.z < altarBounds.maxZ + 0.5
  ) {
    // Allow walking on the platform but not through the altar table
    if (
      newPosition.x > -2.5 &&
      newPosition.x < 2.5 &&
      newPosition.z > -CHURCH_LENGTH / 2 + 4 &&
      newPosition.z < -CHURCH_LENGTH / 2 + 6
    ) {
      // Push player away from altar table
      if (camera.position.z > -CHURCH_LENGTH / 2 + 5) {
        newPosition.z = -CHURCH_LENGTH / 2 + 6.5;
      }
    }
  }

  return newPosition;
}

// ===== Animation Loop =====
function animate() {
  requestAnimationFrame(animate);

  const time = performance.now();
  const delta = (time - prevTime) / 1000;

  // Update FPS counter
  frameCount++;
  if (time - lastFpsUpdate > 1000) {
    fpsCounter.textContent = `FPS: ${frameCount}`;
    frameCount = 0;
    lastFpsUpdate = time;
  }

  if (controls.isLocked) {
    // Calculate movement direction
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;

    direction.z = Number(moveForward) - Number(moveBackward);
    direction.x = Number(moveRight) - Number(moveLeft);
    direction.normalize();

    if (moveForward || moveBackward) velocity.z -= direction.z * MOVE_SPEED * delta * 20;
    if (moveLeft || moveRight) velocity.x -= direction.x * MOVE_SPEED * delta * 20;

    // Apply movement with collision detection
    const newPosition = camera.position.clone();
    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);

    // Check and apply collision
    const correctedPosition = checkCollision(camera.position.clone());
    camera.position.copy(correctedPosition);
    camera.position.y = PLAYER_HEIGHT;
  }

  prevTime = time;
  renderer.render(scene, camera);
}
