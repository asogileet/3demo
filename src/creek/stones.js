/**
 * Procedural stones: water-worn creek stones and more angular, mossy bank boulders.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { simplex, mulberry32, terrainHeight, channelCenter, channelHalfWidth, WATER_LEVEL } from './terrain.js';
import { patchNatureMaterial } from './shaders.js';

// x, s (lateral channel coordinate), rx, ry, rz, top height (null = resting on the bank), palette, angular
const LAYOUT = [
  [-4.2, -0.35, 0.5, 0.34, 0.42, 0.16, 0, false],
  [-3.45, 0.28, 0.28, 0.18, 0.24, 0.03, 3, false],
  [-2.6, -0.62, 0.36, 0.24, 0.3, 0.1, 1, false],
  [-2.15, 0.12, 0.22, 0.15, 0.2, -0.035, 2, false],
  [-1.3, -0.15, 0.64, 0.42, 0.52, 0.23, 0, true],
  [-0.65, 0.55, 0.3, 0.2, 0.26, 0.06, 4, false],
  [0.2, -0.76, 0.42, 0.27, 0.34, 0.14, 1, false],
  [0.62, 0.1, 0.26, 0.16, 0.3, 0.025, 3, false],
  [1.4, -0.3, 0.34, 0.22, 0.28, 0.09, 2, false],
  [1.95, 0.45, 0.46, 0.31, 0.38, 0.18, 0, true],
  [2.5, -0.05, 0.2, 0.12, 0.18, 0.025, 4, false],
  [2.85, -0.58, 0.25, 0.15, 0.22, 0.045, 3, false],
  [3.45, 0.2, 0.38, 0.24, 0.3, 0.1, 1, false],
  [4.3, -0.4, 0.3, 0.2, 0.34, 0.05, 2, false],
  [4.0, 0.72, 0.22, 0.14, 0.2, -0.04, 4, false],
  [-0.1, -0.05, 0.18, 0.11, 0.16, -0.06, 3, false],
  // Bank boulders
  [-3.0, 1.6, 0.46, 0.28, 0.38, null, 0, true],
  [1.0, -1.65, 0.52, 0.32, 0.42, null, 1, true],
  [3.6, 1.5, 0.36, 0.22, 0.3, null, 2, true],
  [-0.15, 1.45, 0.26, 0.18, 0.24, null, 3, true],
  [-4.4, -1.55, 0.32, 0.2, 0.28, null, 0, true],
  [2.4, -1.45, 0.24, 0.16, 0.22, null, 4, true],
];

const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const PALETTES = [
  { a: srgb(0.52, 0.51, 0.48), b: srgb(0.36, 0.35, 0.34), band: 0.0, vein: 0.5 }, // granite
  { a: srgb(0.56, 0.48, 0.39), b: srgb(0.41, 0.34, 0.27), band: 1.0, vein: 0.1 }, // sandstone
  { a: srgb(0.32, 0.32, 0.33), b: srgb(0.21, 0.21, 0.22), band: 0.2, vein: 0.9 }, // basalt
  { a: srgb(0.42, 0.44, 0.46), b: srgb(0.29, 0.3, 0.32), band: 0.7, vein: 0.3 }, // slate
  { a: srgb(0.64, 0.61, 0.56), b: srgb(0.5, 0.47, 0.42), band: 0.1, vein: 0.2 }, // quartzite
];

const STONE_ALBEDO = /* glsl */ `
vec3 sp = vOPos * 1.8 + uSeed;
float n1 = fbm3(sp * 1.4);
float n2 = fbm3(sp * 5.5 + 3.0);
float speck = vnoise3(sp * 42.0);
float speck2 = vnoise3(sp * 23.0 + 7.0);
vec3 col = mix(uColB, uColA, smoothstep(0.3, 0.7, n1));
col *= 1.0 + uBand * sin(vOPos.y * 9.0 + vOPos.x * 1.5 + n1 * 4.0) * 0.12;
col *= 0.82 + 0.36 * n2;
col = mix(col, col * 0.5, smoothstep(0.72, 0.8, speck) * 0.7);
col = mix(col, col * 1.5 + 0.02, smoothstep(0.78, 0.86, speck2) * 0.35);
float vein = 1.0 - smoothstep(0.0, 0.02, abs(fbm3(sp * 0.9 + 21.0) - 0.5));
col = mix(col, s2l(vec3(0.8, 0.78, 0.74)), vein * uVein);
float aboveW = smoothstep(0.05, 0.14, vWPos.y - uWaterLevel);
float moss = smoothstep(0.45, 0.9, vWNormal.y) * aboveW * smoothstep(0.46, 0.6, fbm3(sp * 2.6 + 11.0));
float lichen = aboveW * smoothstep(0.62, 0.7, fbm3(sp * 4.0 + 5.0)) * smoothstep(0.0, 0.5, vWNormal.y);
col = mix(col, s2l(vec3(0.66, 0.66, 0.55)), lichen * 0.35);
col = mix(col, s2l(vec3(0.2, 0.25, 0.09)) * (0.7 + 0.6 * n2), moss * uMoss);
float algae = 1.0 - smoothstep(-0.1, 0.02, vWPos.y - uWaterLevel);
col = mix(col, col * s2l(vec3(0.72, 0.78, 0.55)), algae * 0.6);
col *= mix(0.45, 1.0, smoothstep(-0.85, -0.2, vOPos.y));
diffuseColor.rgb = col;
bumpH = (n2 * 0.02 + speck * 0.003 + fbm3(sp * 14.0) * 0.008 + moss * 0.006) * uScale;
`;

function makeStoneGeometry(rand, angular, detail) {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico);
  ico.dispose();

  const pos = geo.attributes.position;
  const off = [rand() * 100, rand() * 100, rand() * 100];
  const amp = angular ? [0.2, 0.07, 0.025] : [0.14, 0.04, 0.01];
  const cuts = [];
  const nCuts = angular ? 3 : 1;
  for (let k = 0; k < nCuts; k++) {
    const n = new THREE.Vector3(rand() - 0.5, (rand() - 0.3) * 0.8, rand() - 0.5).normalize();
    cuts.push({ n, d: (angular ? 0.62 : 0.8) + rand() * 0.2, k: angular ? 0.85 : 0.5 });
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n3 = (f, o) => simplex.noise3d(v.x * f + off[0] + o, v.y * f + off[1], v.z * f + off[2]);
    const d = 1 + amp[0] * n3(1.1, 0) + amp[1] * n3(2.7, 5) + amp[2] * n3(6.5, 9);
    v.multiplyScalar(d);
    for (const c of cuts) {
      const t = v.dot(c.n) - c.d;
      if (t > 0) v.addScaledVector(c.n, -t * c.k);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

/**
 * Create stones and return descriptors used by terrain, gravel, grass and water.
 */
export function createStones(shared, quality) {
  const rand = mulberry32(2024);
  const group = new THREE.Group();
  const stones = [];

  LAYOUT.forEach(([x, s, rx, ry, rz, top, pal, angular], idx) => {
    const z = channelCenter(x) + s * channelHalfWidth(x);
    const ground = terrainHeight(x, z);
    const big = Math.max(rx, rz) > 0.35;
    const geo = makeStoneGeometry(rand, angular, big && !quality.low ? 5 : 4);
    const bb = geo.boundingBox;

    let topY = top === null ? ground + ry * 0.75 : top;
    let posY = topY - ry * bb.max.y;
    const bottom = posY + ry * bb.min.y;
    if (bottom > ground - 0.04) {
      posY = ground - 0.04 - ry * bb.min.y;
      topY = posY + ry * bb.max.y;
    }

    const p = PALETTES[pal];
    const material = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 });
    patchNatureMaterial(material, {
      shared,
      uniforms: {
        uColA: { value: p.a },
        uColB: { value: p.b },
        uSeed: { value: idx * 13.37 },
        uBand: { value: p.band },
        uVein: { value: p.vein * (rand() < 0.5 ? 1 : 0) },
        uMoss: { value: angular ? 0.9 : 0.55 },
        uScale: { value: (rx + ry + rz) / 3 },
      },
      fragmentHead: 'uniform vec3 uColA; uniform vec3 uColB; uniform float uSeed; uniform float uBand; uniform float uVein; uniform float uMoss; uniform float uScale;',
      albedo: STONE_ALBEDO,
      wetRough: 0.16,
      cacheKey: 'stone',
    });

    const mesh = new THREE.Mesh(geo, material);
    const rotY = rand() * Math.PI * 2;
    mesh.scale.set(rx, ry, rz);
    mesh.rotation.set((rand() - 0.5) * 0.15, rotY, (rand() - 0.5) * 0.15);
    mesh.position.set(x, posY, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const yl = (ground - posY) / ry;
    const groundFactor = Math.sqrt(Math.max(0.05, 1 - Math.min(yl * yl, 1)));
    const yw = (WATER_LEVEL - posY) / ry;
    const waterFactor = topY > WATER_LEVEL ? Math.sqrt(Math.max(0, 1 - Math.min(yw * yw, 1))) : 0;

    stones.push({
      x, z, rx, ry, rz, rotY, posY, topY, maxY: bb.max.y, groundFactor,
      waterR: 0.5 * (rx + rz) * waterFactor * 0.92,
      mesh,
    });
  });

  return { group, stones };
}

/** Approximate top surface of stones at (x, z), or -Infinity if outside every stone. */
export function stoneTopAt(stones, x, z) {
  let best = -Infinity;
  for (const st of stones) {
    const dx = x - st.x;
    const dz = z - st.z;
    const m = Math.max(st.rx, st.rz) * 1.05;
    if (Math.abs(dx) > m || Math.abs(dz) > m) continue;
    const c = Math.cos(st.rotY);
    const s = Math.sin(st.rotY);
    const lx = (dx * c - dz * s) / st.rx;
    const lz = (dx * s + dz * c) / st.rz;
    const r2 = lx * lx + lz * lz;
    if (r2 < 1) best = Math.max(best, st.posY + st.ry * st.maxY * Math.sqrt(1 - r2));
  }
  return best;
}

/** True if (x, z) lies within the ground footprint of any stone (with margin). */
export function insideStone(stones, x, z, margin = 0) {
  for (const st of stones) {
    const dx = x - st.x;
    const dz = z - st.z;
    const r = Math.max(st.rx, st.rz) * st.groundFactor + margin;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
