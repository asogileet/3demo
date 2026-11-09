/**
 * Instanced pebbles and cobbles scattered over the creek bed, gravel bar and shoreline.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { simplex, mulberry32, terrainHeight, grassMask, SIZE_X, SIZE_Z } from './terrain.js';
import { insideStone } from './stones.js';
import { patchNatureMaterial } from './shaders.js';

const PEBBLE_ALBEDO = /* glsl */ `
vec3 sp = vOPos * 3.0 + vRnd * 50.0;
float n = fbm3(sp * 2.0);
float sk = vnoise3(sp * 25.0);
vec3 col = diffuseColor.rgb * (0.75 + 0.5 * n);
col = mix(col, col * 0.55, smoothstep(0.7, 0.8, sk) * 0.6);
float band = 1.0 - smoothstep(0.0, 0.05, abs(fract(vOPos.y * 2.0 + vRnd * 3.0 + n) - 0.5));
col = mix(col, col * 1.35 + 0.02, band * step(0.7, vRnd) * 0.6);
col *= mix(0.5, 1.0, smoothstep(-0.6, 0.25, vOPos.y));
diffuseColor.rgb = col;
bumpH = n * 0.0025 + sk * 0.0006;
`;

const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const PALETTE = [
  [srgb(0.56, 0.54, 0.51), 0.3],
  [srgb(0.63, 0.57, 0.48), 0.2],
  [srgb(0.32, 0.32, 0.32), 0.15],
  [srgb(0.52, 0.4, 0.3), 0.1],
  [srgb(0.42, 0.44, 0.47), 0.15],
  [srgb(0.72, 0.7, 0.66), 0.1],
];

function pickColor(rand) {
  let r = rand();
  for (const [c, w] of PALETTE) {
    if ((r -= w) <= 0) return c;
  }
  return PALETTE[0][0];
}

function makePebbleGeometry(rand) {
  const ico = new THREE.IcosahedronGeometry(1, 2);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico);
  ico.dispose();
  const pos = geo.attributes.position;
  const off = rand() * 100;
  const flat = 0.45 + rand() * 0.25;
  const elong = 1 + rand() * 0.5;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const d = 1 + 0.16 * simplex.noise3d(v.x * 1.2 + off, v.y * 1.2, v.z * 1.2) +
      0.05 * simplex.noise3d(v.x * 3 + off, v.y * 3, v.z * 3);
    v.multiplyScalar(d);
    pos.setXYZ(i, v.x * elong, v.y * flat, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function createGravel(shared, stones, quality) {
  const rand = mulberry32(77);
  const group = new THREE.Group();
  const variants = 5;
  const total = quality.low ? 3500 : 8000;
  const perVariant = Math.floor(total / variants);

  const material = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0 });
  patchNatureMaterial(material, {
    shared,
    vertexHead: 'varying float vRnd;',
    vertexBody: `#ifdef USE_INSTANCING
vRnd = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
#else
vRnd = 0.5;
#endif`,
    fragmentHead: 'varying float vRnd;',
    albedo: PEBBLE_ALBEDO,
    wetRough: 0.14,
    cacheKey: 'pebble',
  });

  const dummy = new THREE.Object3D();
  const hx = SIZE_X / 2 - 0.03;
  const hz = SIZE_Z / 2 - 0.03;

  for (let vi = 0; vi < variants; vi++) {
    const geo = makePebbleGeometry(rand);
    const mesh = new THREE.InstancedMesh(geo, material, perVariant);
    let count = 0;
    let guard = 0;
    while (count < perVariant && guard++ < perVariant * 60) {
      const x = (rand() * 2 - 1) * hx;
      const z = (rand() * 2 - 1) * hz;
      const h = terrainHeight(x, z);
      if (h > 0.16 || h < -0.45) continue;
      const w = 0.18 + 0.82 * Math.exp(-(((h - 0.01) / 0.07) ** 2));
      if (rand() > w) continue;
      if (h > 0.09 && grassMask(x, z) > 0.35) continue;
      if (insideStone(stones, x, z, -0.02)) continue;

      let s = 0.014 * Math.pow(5, rand());
      if (rand() < 0.05) s *= 2.2;
      const yaw = rand() * Math.PI * 2;
      dummy.position.set(x, h + s * 0.15 - 0.004, z);
      dummy.rotation.set((rand() - 0.5) * 0.5, yaw, (rand() - 0.5) * 0.5);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(count, dummy.matrix);
      const c = pickColor(rand).clone().multiplyScalar(0.8 + rand() * 0.35);
      mesh.setColorAt(count, c);
      count++;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = !quality.low;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}
