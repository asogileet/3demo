/**
 * Instanced grass clumps on the banks and sedges along the waterline, swaying in the wind.
 */
import * as THREE from 'three';
import { mulberry32, terrainHeight, grassMask, SIZE_X, SIZE_Z } from './terrain.js';
import { insideStone } from './stones.js';

const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

function makeBladeGeometry() {
  const SEG = 5;
  const BW = 0.06;
  const positions = [];
  const normals = [];
  const index = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const w = (BW * 0.5) * (1 - Math.pow(t, 1.6)) + 0.0015;
    const z = t * t * 0.28;
    const ny = 0.25 + t * 0.5;
    if (i < SEG) {
      positions.push(-w, t, z, w, t, z);
      normals.push(0, ny, 1, 0, ny, 1);
    } else {
      positions.push(0, t, z);
      normals.push(0, ny, 1);
    }
  }
  for (let i = 0; i < SEG - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = (SEG - 1) * 2;
  index.push(last, last + 1, last + 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const nAttr = new THREE.Float32BufferAttribute(normals, 3);
  geo.setAttribute('normal', nAttr);
  geo.normalizeNormals();
  geo.setIndex(index);
  return geo;
}

export function createGrass(shared, stones, quality) {
  const rand = mulberry32(4242);
  const target = quality.low ? 14000 : 32000;
  const reedClumps = quality.low ? 22 : 45;
  const geo = makeBladeGeometry();

  const material = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.uniforms.uSunColor = shared.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform float uTime;
uniform float uWind;
varying float vH;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
}`)
      .replace('#include <project_vertex>', /* glsl */ `
vH = position.y;
vec4 ip = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
ip = instanceMatrix * ip;
vec3 root = instanceMatrix[3].xyz;
float bladeH = length(instanceMatrix[1].xyz);
#else
vec3 root = vec3(0.0);
float bladeH = 1.0;
#endif
// Wind: slow gust field plus per-blade flutter, increasing toward the tip
float gust = gNoise(root.xz * 0.55 - vec2(uTime * 0.9, uTime * 0.35));
float flutter = sin(uTime * 3.2 + root.x * 7.1 + root.z * 5.3) * 0.35 + sin(uTime * 5.7 + root.z * 11.0) * 0.15;
float bend = position.y * position.y;
vec2 windDir = normalize(vec2(1.0, 0.35));
float sway = (gust * 0.9 + 0.15 + flutter * (0.3 + gust)) * uWind * 0.55;
ip.xz += windDir * sway * bend * bladeH;
ip.y -= abs(sway) * bend * bladeH * 0.25;
vec4 mvPosition = modelViewMatrix * ip;
gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunColor;\nvarying float vH;')
      .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;')
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
diffuseColor.rgb *= mix(0.28, 1.12, smoothstep(0.0, 0.9, vH));
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 1.12, 0.62), smoothstep(0.65, 1.0, vH) * 0.55);`)
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
// Cheap translucency: thin blades let some sunlight through
reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * 0.1 * vH;`);
  };
  material.customProgramCacheKey = () => 'grass';

  const maxCount = target + reedClumps * 22;
  const mesh = new THREE.InstancedMesh(geo, material, maxCount);
  const dummy = new THREE.Object3D();
  const hx = SIZE_X / 2 - 0.02;
  const hz = SIZE_Z / 2 - 0.02;
  const greens = [srgb(0.3, 0.42, 0.13), srgb(0.24, 0.37, 0.11), srgb(0.36, 0.45, 0.17), srgb(0.27, 0.34, 0.12)];
  const dry = srgb(0.58, 0.52, 0.32);
  const reed = srgb(0.24, 0.34, 0.16);
  let count = 0;

  const placeBlade = (x, z, height, widthScale, yaw, tilt, color) => {
    if (count >= maxCount) return;
    const h = terrainHeight(x, z);
    dummy.position.set(x, h - 0.006, z);
    dummy.rotation.set(0, 0, 0);
    dummy.rotateY(yaw);
    dummy.rotateX(tilt);
    dummy.scale.set(height * widthScale, height, height);
    dummy.updateMatrix();
    mesh.setMatrixAt(count, dummy.matrix);
    mesh.setColorAt(count, color);
    count++;
  };

  // Grass clumps
  let guard = 0;
  while (count < target && guard++ < 200000) {
    const cx = (rand() * 2 - 1) * hx;
    const cz = (rand() * 2 - 1) * hz;
    const m = grassMask(cx, cz);
    if (rand() > m * 1.15) continue;
    const n = 10 + Math.floor(rand() * 40);
    const radius = 0.04 + rand() * 0.12;
    const clumpH = (0.1 + 0.2 * rand()) * (0.6 + 0.6 * m);
    const isDryClump = rand() < 0.12;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = radius * Math.sqrt(rand());
      const dx = Math.cos(a) * r;
      const dz = Math.sin(a) * r;
      const x = cx + dx;
      const z = cz + dz;
      if (Math.abs(x) > hx || Math.abs(z) > hz) continue;
      if (terrainHeight(x, z) < 0.045) continue;
      if (insideStone(stones, x, z, -0.01)) continue;
      const height = clumpH * (0.55 + 0.6 * rand());
      const yaw = Math.atan2(dx, dz) + (rand() - 0.5) * 0.6;
      const tilt = 0.12 + 0.55 * (r / radius) + rand() * 0.1;
      const base = isDryClump || rand() < 0.06 ? dry : greens[Math.floor(rand() * greens.length)];
      placeBlade(x, z, height, 0.8 + rand() * 0.5, yaw, tilt, base.clone().multiplyScalar(0.78 + rand() * 0.4));
    }
  }

  // Sedges along the waterline
  let placed = 0;
  guard = 0;
  while (placed < reedClumps && guard++ < 20000) {
    const cx = (rand() * 2 - 1) * hx;
    const cz = (rand() * 2 - 1) * hz;
    const h = terrainHeight(cx, cz);
    if (h < 0.015 || h > 0.1) continue;
    if (insideStone(stones, cx, cz, 0.03)) continue;
    placed++;
    const n = 12 + Math.floor(rand() * 10);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.05 * Math.sqrt(rand());
      const dx = Math.cos(a) * r;
      const dz = Math.sin(a) * r;
      if (Math.abs(cx + dx) > hx || Math.abs(cz + dz) > hz) continue;
      const height = 0.28 + rand() * 0.3;
      placeBlade(cx + dx, cz + dz, height, 0.45, Math.atan2(dx, dz), 0.06 + rand() * 0.25,
        reed.clone().multiplyScalar(0.8 + rand() * 0.35));
    }
  }

  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = !quality.low;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}
