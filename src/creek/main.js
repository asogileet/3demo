/**
 * Creekside Miniature - realistic creek diorama with interactive ripples.
 *
 * Rendering pipeline per frame:
 *   1. Ripple simulation steps (GPU ping-pong).
 *   2. Opaque scene (layer 0) -> HDR render target with depth texture.
 *   3. Composite render target to screen (tone mapped, depth restored).
 *   4. Water surface and cut-edge water faces (layer 1) sampling step 2 for refraction/SSR.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createTerrain, createSkirts, createPlinth, WATER_LEVEL, SIZE_X, SIZE_Z, smoothstep } from './terrain.js';
import { createStones } from './stones.js';
import { createGravel } from './gravel.js';
import { createGrass } from './grass.js';
import { createWater } from './water.js';
import { NOISE_GLSL, SKY_GLSL } from './shaders.js';

const container = document.getElementById('canvas-container');
const loading = document.getElementById('loading-screen');
const quality = {
  low: window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 700,
};

const DEFAULT_CAM = new THREE.Vector3(7.2, 5.6, 8.4);
const DEFAULT_TARGET = new THREE.Vector3(0, -0.1, 0);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(160);

/* ---------------------------------------------------------------- Renderer */

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.low ? 1.25 : 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.autoClear = false;
renderer.setClearColor(0x000000, 0);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 80);
camera.position.copy(DEFAULT_CAM);

const shared = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uWaterLevel: { value: WATER_LEVEL },
  uFlowScale: { value: 1 },
  uWind: { value: 0.35 },
};

/* ------------------------------------------------------------------ Lights */

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(quality.low ? 1024 : 2048, quality.low ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -7.5, right: 7.5, top: 7.5, bottom: -7.5, near: 1, far: 40 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.layers.enableAll();
scene.add(sun, sun.target);

const hemi = new THREE.HemisphereLight(0xb8cde0, 0x4a3f2c, 0.35);
hemi.layers.enableAll();
scene.add(hemi);

/* ------------------------------------------------------------- Environment */

const pmrem = new THREE.PMREMGenerator(renderer);
const skyScene = new THREE.Scene();
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uSunDir: shared.uSunDir, uSunColor: shared.uSunColor },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    varying vec3 vDir;
    ${NOISE_GLSL}
    ${SKY_GLSL}
    void main() {
      gl_FragColor = vec4(skyColor(normalize(vDir), uSunDir, uSunColor, 1.0), 1.0);
    }`,
});
skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), skyMat));
let envRT = null;
scene.environmentIntensity = 0.55;

function updateEnvironment() {
  const next = pmrem.fromScene(skyScene, 0, 0.1, 50);
  scene.environment = next.texture;
  if (envRT) envRT.dispose();
  envRT = next;
}

function setSun(elevationDeg) {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.cos(SUN_AZIMUTH),
    Math.sin(el),
    Math.cos(el) * Math.sin(SUN_AZIMUTH),
  ).normalize();
  const t = smoothstep(5, 45, elevationDeg);
  const warm = new THREE.Color().setRGB(1.0, 0.62, 0.38, THREE.SRGBColorSpace);
  const noon = new THREE.Color().setRGB(1.0, 0.96, 0.9, THREE.SRGBColorSpace);
  const color = warm.lerp(noon, t);
  const intensity = 3.2 * (0.35 + 0.65 * t);

  sun.position.copy(dir).multiplyScalar(15);
  sun.color.copy(color);
  sun.intensity = intensity;
  hemi.intensity = 0.2 + 0.2 * t;
  shared.uSunDir.value.copy(dir);
  shared.uSunColor.value.copy(color).multiplyScalar(intensity / Math.PI);
}

/* ------------------------------------------------------------- Render targets */

const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const sceneRT = new THREE.WebGLRenderTarget(bufferSize.x, bufferSize.y, {
  type: THREE.HalfFloatType,
  samples: quality.low ? 0 : 4,
  depthBuffer: true,
  depthTexture: new THREE.DepthTexture(bufferSize.x, bufferSize.y),
});

const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compScene = new THREE.Scene();
const compMat = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: sceneRT.texture }, tDepth: { value: sceneRT.depthTexture } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(tColor, vUv);
      gl_FragDepth = texture2D(tDepth, vUv).r;
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  depthTest: true,
  depthWrite: true,
  depthFunc: THREE.AlwaysDepth,
});
const compQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat);
compQuad.frustumCulled = false;
compScene.add(compQuad);

/* ---------------------------------------------------------------- Controls */

let water = null;
let dragging = false;
let lastHit = null;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** Return the water-surface point under the pointer, or null if blocked or not water. */
function pickWater(ev, checkOcclusion) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const { origin, direction } = raycaster.ray;
  if (direction.y >= -1e-4) return null;
  const t = (WATER_LEVEL - origin.y) / direction.y;
  const p = origin.clone().addScaledVector(direction, t);
  if (!water.isWater(p.x, p.z)) return null;
  if (checkOcclusion) {
    for (let k = 1; k < 120; k++) {
      const q = origin.clone().addScaledVector(direction, (t * k) / 120);
      if (Math.abs(q.x) < SIZE_X / 2 && Math.abs(q.z) < SIZE_Z / 2 && water.bedAt(q.x, q.z) > q.y + 0.004) return null;
    }
  }
  return p;
}

// Registered before OrbitControls so a press on the water disables orbiting for that drag
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (!water || ev.button !== 0) return;
  const hit = pickWater(ev, true);
  if (!hit) return;
  dragging = true;
  lastHit = hit;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(ev.pointerId);
  water.addDrop(hit.x, hit.z, 0.13, -0.03);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!water) return;
  if (!dragging) {
    renderer.domElement.style.cursor = pickWater(ev, true) ? 'crosshair' : 'grab';
    return;
  }
  const hit = pickWater(ev, false);
  if (!hit) return;
  const dist = hit.distanceTo(lastHit);
  const steps = Math.min(Math.floor(dist / 0.06), 12);
  for (let k = 1; k <= steps; k++) {
    const p = lastHit.clone().lerp(hit, k / steps);
    water.addDrop(p.x, p.z, 0.09, -0.012);
  }
  if (steps > 0) lastHit = hit;
});

const endDrag = (ev) => {
  if (!dragging) return;
  dragging = false;
  controls.enabled = true;
  if (renderer.domElement.hasPointerCapture(ev.pointerId)) renderer.domElement.releasePointerCapture(ev.pointerId);
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 4.5;
controls.maxDistance = 20;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = 1.32;
controls.autoRotateSpeed = 0.6;
controls.update();

/* ---------------------------------------------------------------------- UI */

const flowInput = document.getElementById('flow-speed');
const sunInput = document.getElementById('sun-angle');
const windInput = document.getElementById('wind-strength');
const autoRotateInput = document.getElementById('auto-rotate');
const resetBtn = document.getElementById('reset-view');

flowInput.addEventListener('input', () => { shared.uFlowScale.value = flowInput.value / 100; });
windInput.addEventListener('input', () => { shared.uWind.value = windInput.value / 100; });
autoRotateInput.addEventListener('change', () => { controls.autoRotate = autoRotateInput.checked; });
let envTimer = 0;
sunInput.addEventListener('input', () => {
  setSun(Number(sunInput.value));
  clearTimeout(envTimer);
  envTimer = setTimeout(updateEnvironment, 120);
});
resetBtn.addEventListener('click', () => {
  camera.position.copy(DEFAULT_CAM);
  controls.target.copy(DEFAULT_TARGET);
  controls.update();
});

/* ------------------------------------------------------------------- Build */

function build() {
  setSun(Number(sunInput.value));
  shared.uFlowScale.value = flowInput.value / 100;
  shared.uWind.value = windInput.value / 100;
  updateEnvironment();

  const { group: stoneGroup, stones } = createStones(shared, quality);
  scene.add(stoneGroup);
  scene.add(createTerrain(shared, stones, quality));
  scene.add(createSkirts(shared));
  scene.add(createPlinth());
  scene.add(createGravel(shared, stones, quality));
  scene.add(createGrass(shared, stones, quality));

  water = createWater(renderer, shared, stones);
  scene.add(water.surface, water.sides);

  renderer.compile(scene, camera);
}

/* -------------------------------------------------------------------- Loop */

const clock = new THREE.Clock();
let elapsed = 0;
let nextDrip = 2;

function randomDrip() {
  for (let k = 0; k < 30; k++) {
    const x = (Math.random() * 2 - 1) * (SIZE_X / 2 - 0.2);
    const z = (Math.random() * 2 - 1) * (SIZE_Z / 2 - 0.2);
    if (water.isWater(x, z)) {
      water.addDrop(x, z, 0.035 + Math.random() * 0.03, -0.006 - Math.random() * 0.006);
      return;
    }
  }
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  shared.uTime.value = elapsed;
  controls.update(dt);

  if (elapsed > nextDrip) {
    randomDrip();
    nextDrip = elapsed + 1.2 + Math.random() * 2.8;
  }
  water.update(dt);

  // Opaque scene into HDR target
  camera.layers.set(0);
  renderer.shadowMap.needsUpdate = true;
  renderer.setRenderTarget(sceneRT);
  renderer.clear();
  renderer.render(scene, camera);

  // Composite to screen (restores depth for the water pass)
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(compScene, quadCam);

  // Water surface on top
  water.setView(sceneRT, camera);
  camera.layers.set(1);
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(bufferSize);
  sceneRT.setSize(bufferSize.x, bufferSize.y);
}
window.addEventListener('resize', onResize);

// Let the loading screen paint before the synchronous procedural generation
requestAnimationFrame(() => {
  setTimeout(() => {
    try {
      build();
      loading.classList.add('hidden');
      renderer.setAnimationLoop(frame);
    } catch (err) {
      console.error('Creek scene initialization failed:', err);
      loading.querySelector('p').textContent = '場景初始化失敗，請確認瀏覽器支援 WebGL2。';
    }
  }, 30);
});
