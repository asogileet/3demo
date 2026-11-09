/**
 * Creek terrain: analytic height field, terrain mesh, soil cross-section skirts and plinth.
 */
import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { patchNatureMaterial } from './shaders.js';

export const SIZE_X = 10;
export const SIZE_Z = 8;
export const WATER_LEVEL = 0;
export const BASE_Y = -0.85;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const simplex = new SimplexNoise({ random: mulberry32(1337) });

export const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export function fbm(x, z, octaves = 4) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    s += a * simplex.noise(x * f, z * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

export const channelCenter = (x) => 0.55 * Math.sin(x * 0.42 + 0.6) + 0.28 * Math.sin(x * 0.95 + 2.0);
export const channelHalfWidth = (x) => 1.25 + 0.22 * Math.sin(x * 0.7 + 1.3) + 0.1 * Math.sin(x * 1.9);

/** Signed lateral channel coordinate: 0 at the centerline, +-1 roughly at the shoreline. */
export function channelS(x, z) {
  return (z - channelCenter(x)) / channelHalfWidth(x);
}

/** Unit tangent of the channel centerline at x (downstream = +x). */
export function channelTangent(x) {
  const e = 0.01;
  const dc = (channelCenter(x + e) - channelCenter(x - e)) / (2 * e);
  const l = Math.hypot(1, dc);
  return [1 / l, dc / l];
}

export function terrainHeight(x, z) {
  const s = channelS(x, z);
  const d = Math.abs(s);
  const n = fbm(x * 0.6, z * 0.6);

  // Riverbed: deeper along the thalweg, with a shallow riffle downstream
  let bed = -0.3 - 0.1 * Math.max(0, 1 - d * d) + 0.05 * fbm(x * 1.7 + 10, z * 1.7);
  bed += 0.13 * Math.exp(-((x - 2.5) ** 2) / 0.45);
  bed += 0.012 * fbm(x * 7 + 3, z * 7);

  // Banks rising away from the water with gentle undulation
  const bank = 0.3 + 0.11 * fbm(x * 0.5 + 3, z * 0.5) + 0.05 * Math.min(Math.max(d - 1.4, 0), 2);

  let h = bed + (bank - bed) * smoothstep(0.78, 1.5, d + 0.12 * n);

  // Low gravel bar on the inner bend
  const bar = Math.exp(-((x + 1.6) ** 2) / 2.2) * smoothstep(0.55, 0.95, s) * (1 - smoothstep(1.5, 2.1, s));
  h += (0.02 + 0.02 * fbm(x * 3, z * 3) - h) * bar * 0.9;

  return h + 0.006 * simplex.noise(x * 18, z * 18);
}

/** Grass density on the banks, 0..1 */
export function grassMask(x, z) {
  const h = terrainHeight(x, z);
  const patch = Math.min(Math.max(0.55 + 1.1 * fbm(x * 0.9 + 20, z * 0.9), 0), 1);
  return smoothstep(0.07, 0.2, h) * patch;
}

const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const TERRAIN_ALBEDO = /* glsl */ `
vec2 vorA = voronoi2(vWPos.xz * 24.0);
vec2 vorB = voronoi2(vWPos.xz * 61.0 + 13.0);
float pebA = 1.0 - smoothstep(0.18, 0.62, vorA.x);
float pebB = 1.0 - smoothstep(0.2, 0.6, vorB.x);
vec3 pcA = mix(s2l(vec3(0.42, 0.40, 0.37)), s2l(vec3(0.66, 0.62, 0.55)), vorA.y);
pcA = mix(pcA, s2l(vec3(0.50, 0.40, 0.31)), step(0.86, vorA.y));
pcA = mix(pcA, s2l(vec3(0.30, 0.31, 0.32)), step(vorA.y, 0.1));
vec3 pcB = mix(s2l(vec3(0.38, 0.36, 0.33)), s2l(vec3(0.60, 0.57, 0.52)), vorB.y);
float grain = fbm2(vWPos.xz * 38.0);
vec3 base = diffuseColor.rgb * (0.78 + 0.45 * grain);
float g = vMat.x;
vec3 gravel = mix(base * 0.55, pcB, pebB * 0.85);
gravel = mix(gravel, pcA, pebA);
diffuseColor.rgb = mix(base, gravel, g) * vMat.y;
bumpH = mix(grain * 0.004, pebA * 0.011 + pebB * 0.004, g) + fbm2(vWPos.xz * 95.0) * 0.0012;
`;

/**
 * Build terrain mesh, using stone footprints for contact occlusion.
 * @param {object} shared Shared uniforms
 * @param {Array} stones Stone descriptors from stones.js
 */
export function createTerrain(shared, stones, quality) {
  const segX = quality.low ? 220 : 320;
  const segZ = Math.round(segX * SIZE_Z / SIZE_X);
  const geo = new THREE.PlaneGeometry(SIZE_X, SIZE_Z, segX, segZ);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const mat = new Float32Array(pos.count * 2);

  const cBedSilt = srgb(0.36, 0.33, 0.27);
  const cBedDark = srgb(0.26, 0.26, 0.23);
  const cShore = srgb(0.52, 0.49, 0.44);
  const cSoil = srgb(0.27, 0.2, 0.14);
  const cGrassGround = srgb(0.2, 0.22, 0.1);
  const cDry = srgb(0.4, 0.35, 0.22);
  const tmp = new THREE.Color();
  const tmp2 = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    const n1 = fbm(x * 1.3 + 40, z * 1.3);
    const n2 = fbm(x * 3.1 - 7, z * 3.1);

    // Gravel coverage: shore and bed, partially silted in deeper water
    let gravelAmt = 1 - smoothstep(0.07, 0.19, h + 0.05 * n1);
    gravelAmt *= 1 - 0.45 * smoothstep(-0.06, -0.3, h) * (0.5 + 0.5 * n2);

    const gm = grassMask(x, z);
    tmp.copy(cSoil).lerp(cGrassGround, gm).lerp(cDry, Math.max(0, n2) * 0.5 * gm);
    tmp.lerp(cShore, gravelAmt);
    tmp2.copy(cBedSilt).lerp(cBedDark, 0.5 + 0.5 * n1);
    tmp.lerp(tmp2, 1 - smoothstep(-0.07, 0.02, h));

    // Contact occlusion around stones
    let ao = 1;
    for (const st of stones) {
      const dx = x - st.x;
      const dz = z - st.z;
      const r = Math.max(st.rx, st.rz) * st.groundFactor;
      const dist = Math.max(Math.hypot(dx, dz) - r * 0.85, 0);
      ao *= 1 - 0.5 * Math.exp(-(dist * dist) / (0.012 + 0.03 * r));
    }
    // Darken bank toes slightly (cavity)
    ao *= 1 - 0.18 * smoothstep(0.12, 0.0, Math.abs(h - 0.04)) * smoothstep(-0.2, 0.2, n1);

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
    mat[i * 2] = gravelAmt;
    mat[i * 2 + 1] = ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 2));
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  patchNatureMaterial(material, {
    shared,
    vertexHead: 'attribute vec2 aMat;\nvarying vec2 vMat;',
    vertexBody: 'vMat = aMat;',
    fragmentHead: 'varying vec2 vMat;',
    albedo: TERRAIN_ALBEDO,
    wetRough: 0.22,
    cacheKey: 'terrain',
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

const SOIL_ALBEDO = /* glsl */ `
vec3 p3 = vWPos * vec3(1.0, 1.0, 1.0);
float lat = vWPos.x + vWPos.z;
float grainS = vnoise3(p3 * 70.0) * 0.5 + vnoise3(p3 * 18.0) * 0.5;
vec2 vor = voronoi2(vec2(lat * 22.0, vWPos.y * 22.0));
float stoneBand = 1.0 - smoothstep(0.0, 0.12, abs(vWPos.y + 0.48 + 0.05 * sin(lat * 1.3)));
float pebble = (1.0 - smoothstep(0.25, 0.55, vor.x)) * step(0.45, vor.y) * (0.25 + stoneBand);
vec3 c = diffuseColor.rgb * (0.75 + 0.5 * grainS);
c = mix(c, mix(s2l(vec3(0.45, 0.43, 0.40)), s2l(vec3(0.62, 0.58, 0.52)), vor.y), clamp(pebble, 0.0, 1.0));
diffuseColor.rgb = c;
bumpH = grainS * 0.004 + pebble * 0.01;
`;

/** Vertical cross-section walls exposing soil strata on the four sides of the diorama. */
export function createSkirts(shared) {
  const group = new THREE.Group();
  const hx = SIZE_X / 2;
  const hz = SIZE_Z / 2;
  const edges = [
    { a: [-hx, hz], b: [hx, hz] },
    { a: [hx, -hz], b: [-hx, -hz] },
    { a: [-hx, -hz], b: [-hx, hz] },
    { a: [hx, hz], b: [hx, -hz] },
  ];
  const cTop = srgb(0.17, 0.12, 0.085);
  const cLoam = srgb(0.38, 0.29, 0.2);
  const cSand = srgb(0.52, 0.44, 0.33);
  const cClay = srgb(0.44, 0.33, 0.24);
  const tmp = new THREE.Color();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, side: THREE.DoubleSide,
  });
  patchNatureMaterial(material, { shared, albedo: SOIL_ALBEDO, cacheKey: 'soil', wetRough: 0.3 });

  for (const e of edges) {
    const N = 260;
    const M = 36;
    const positions = [];
    const colors = [];
    const index = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = e.a[0] + (e.b[0] - e.a[0]) * t;
      const z = e.a[1] + (e.b[1] - e.a[1]) * t;
      const top = terrainHeight(x, z);
      const lat = x + z;
      for (let j = 0; j <= M; j++) {
        const v = j / M;
        const y = top + (BASE_Y - top) * v;
        positions.push(x, y, z);
        const depth = top - y;
        const wav = 0.04 * Math.sin(lat * 0.9) + 0.03 * simplex.noise(lat * 2, 0.5);
        // Strata from top: organic topsoil, loam, sandy layer, clay base
        tmp.copy(cLoam);
        tmp.lerp(cSand, smoothstep(-0.35, -0.42, y + wav) * (1 - smoothstep(-0.55, -0.6, y + wav)));
        tmp.lerp(cClay, smoothstep(-0.62, -0.72, y + wav));
        tmp.lerp(cTop, 1 - smoothstep(0.06, 0.16, depth + 0.03 * simplex.noise(lat * 5, 3)));
        if (top < 0.02) tmp.lerp(srgb(0.32, 0.3, 0.27), 1 - smoothstep(0.0, 0.12, depth)); // gravel under the creek
        colors.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const a = i * (M + 1) + j;
        const b = (i + 1) * (M + 1) + j;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Dark walnut plinth plus a soft shadow catcher underneath. */
export function createPlinth() {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: srgb(0.17, 0.11, 0.07), roughness: 0.42, metalness: 0 });
  woodMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vP;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      // Simple wood grain along x
      float gr = sin(vP.z * 90.0 + sin(vP.x * 2.3) * 3.0 + sin(vP.y * 40.0)) * 0.5 + 0.5;
      diffuseColor.rgb *= 0.8 + 0.3 * gr;`);
  };
  const slab = new THREE.Mesh(new THREE.BoxGeometry(SIZE_X + 0.36, 0.3, SIZE_Z + 0.36), woodMat);
  slab.position.y = BASE_Y - 0.15;
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  const catcher = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShadowMaterial({ opacity: 0.38 }),
  );
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = BASE_Y - 0.3;
  catcher.receiveShadow = true;
  group.add(catcher);
  return group;
}
