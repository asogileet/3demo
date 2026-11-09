/**
 * Creek water: CPU-built flow field, GPU heightfield ripple simulation with advection,
 * and a physically-inspired water surface shader (refraction, absorption, SSR, Fresnel, foam).
 */
import * as THREE from 'three';
import {
  SIZE_X, SIZE_Z, WATER_LEVEL, mulberry32, smoothstep,
  terrainHeight, channelS, channelTangent,
} from './terrain.js';
import { stoneTopAt } from './stones.js';
import { NOISE_GLSL, SKY_GLSL } from './shaders.js';

export const NX = 320;
export const NZ = 256;
const CELL = SIZE_X / NX; // equals SIZE_Z / NZ
const SIM_DT = 1 / 100;

/* ----------------------------------------------------------------------------
 * Flow field (velocity, turbulence, bed height)
 * ------------------------------------------------------------------------- */

function baseFlow(x, z) {
  const depth = WATER_LEVEL - terrainHeight(x, z);
  const s = channelS(x, z);
  const [tx, tz] = channelTangent(x);
  const speed = 0.42
    * (0.55 + 0.9 * smoothstep(0.35, 0.04, depth))
    * smoothstep(0.0, 0.08, depth)
    * (1 - 0.45 * smoothstep(0.6, 1.15, Math.abs(s)));
  return [tx * speed, tz * speed, depth];
}

function buildField(stones) {
  const bed = new Float32Array(NX * NZ);
  const data = new Float32Array(NX * NZ * 4);

  const emergent = [];
  const submerged = [];
  for (const st of stones) {
    const [ux, uz] = baseFlow(st.x, st.z);
    const u = Math.hypot(ux, uz);
    const [tx, tz] = channelTangent(st.x);
    const dir = u > 1e-4 ? [ux / u, uz / u] : [tx, tz];
    const item = { st, ux, uz, u, dir };
    if (st.waterR > 0.02) emergent.push(item);
    else if (st.topY > -0.12 && st.topY <= WATER_LEVEL) submerged.push(item);
  }

  for (let j = 0; j < NZ; j++) {
    const z = -SIZE_Z / 2 + (j + 0.5) * CELL;
    for (let i = 0; i < NX; i++) {
      const x = -SIZE_X / 2 + (i + 0.5) * CELL;
      const idx = j * NX + i;
      const tH = terrainHeight(x, z);
      const b = Math.max(tH, stoneTopAt(stones, x, z));
      bed[idx] = b;

      let vx = 0;
      let vz = 0;
      let wake = 0;
      if (b < WATER_LEVEL - 0.004) {
        const [bx, bz, depth] = baseFlow(x, z);
        vx = bx;
        vz = bz;
        let slow = 1;
        const speed = Math.hypot(bx, bz);

        for (const it of emergent) {
          const R = it.st.waterR;
          const px = x - it.st.x;
          const pz = z - it.st.z;
          const r = Math.hypot(px, pz);
          if (r > 7 * R + 0.3) continue;

          // Potential flow around a cylinder: perturbation = conj(-U * R^2 / p^2)
          if (r > R * 0.5) {
            const fall = 1 - smoothstep(2.5 * R, 4.5 * R, r);
            const z2x = px * px - pz * pz;
            const z2y = 2 * px * pz;
            const m = z2x * z2x + z2y * z2y;
            const ix = z2x / m;
            const iy = -z2y / m;
            const prx = -(R * R) * (it.ux * ix - it.uz * iy);
            const pry = -(R * R) * (it.ux * iy + it.uz * ix);
            vx += prx * fall;
            vz += -pry * fall;
          }

          // Wake tail downstream and a foam collar hugging the stone
          const a = px * it.dir[0] + pz * it.dir[1];
          const bLat = -px * it.dir[1] + pz * it.dir[0];
          let tail = 0;
          if (a > 0) {
            const spread = R * (0.7 + 0.35 * a / R);
            tail = Math.exp(-(bLat * bLat) / (spread * spread)) * Math.exp(-a / (6 * R)) * smoothstep(R * 0.6, R * 1.2, r);
          }
          const ring = Math.exp(-(((r - R) / (0.04 + 0.2 * R)) ** 2)) * (0.6 + 0.5 * Math.max(0, -a / Math.max(r, 1e-4)));
          const strength = Math.min(Math.max(it.u / 0.3, 0.3), 1.2);
          wake += (tail * 0.85 + ring * 0.6) * strength;
          slow *= 1 - 0.6 * tail;
        }

        for (const it of submerged) {
          const R0 = 0.4 * (it.st.rx + it.st.rz);
          const qx = x - it.st.x - it.dir[0] * 0.6 * R0;
          const qz = z - it.st.z - it.dir[1] * 0.6 * R0;
          const boil = Math.exp(-(qx * qx + qz * qz) / (R0 * R0)) * (1 - (-it.st.topY) / 0.12);
          wake += boil * 0.7;
        }

        wake += 0.35 * smoothstep(0.12, 0.03, depth) + speed * 0.25;
        vx *= slow;
        vz *= slow;
      }

      data[idx * 4] = vx;
      data[idx * 4 + 1] = vz;
      data[idx * 4 + 2] = Math.min(wake, 1.5);
      data[idx * 4 + 3] = b;
    }
  }

  const half = new Uint16Array(data.length);
  for (let k = 0; k < data.length; k++) half[k] = THREE.DataUtils.toHalfFloat(data[k]);
  const tex = new THREE.DataTexture(half, NX, NZ, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, bed };
}

/* ----------------------------------------------------------------------------
 * Tileable detail texture: rg = slope, b = height (used for flow-mapped micro waves and foam)
 * ------------------------------------------------------------------------- */

function buildDetailTexture(size = 256) {
  const rand = mulberry32(99);
  const H = new Float32Array(size * size);
  const octaves = [[4, 1.0], [8, 0.55], [16, 0.32], [32, 0.18], [64, 0.1]];
  for (const [P, amp] of octaves) {
    const g = new Float32Array(P * P);
    for (let k = 0; k < g.length; k++) g[k] = rand();
    for (let y = 0; y < size; y++) {
      const v = (y / size) * P;
      const y0 = Math.floor(v);
      const fy = v - y0;
      const sy = fy * fy * (3 - 2 * fy);
      const r0 = (y0 % P) * P;
      const r1 = ((y0 + 1) % P) * P;
      for (let x = 0; x < size; x++) {
        const u = (x / size) * P;
        const x0 = Math.floor(u);
        const fx = u - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const c0 = x0 % P;
        const c1 = (x0 + 1) % P;
        const a = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * sx;
        const b = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * sx;
        let n = a + (b - a) * sy;
        if (P >= 16) n = 1 - Math.abs(n * 2 - 1); // sharper crests for capillary-like detail
        H[y * size + x] += n * amp;
      }
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const h of H) { min = Math.min(min, h); max = Math.max(max, h); }
  for (let k = 0; k < H.length; k++) H[k] = (H[k] - min) / (max - min);

  const sl = new Float32Array(size * size * 2);
  let sum2 = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const yd = (y - 1 + size) % size;
      const yu = (y + 1) % size;
      const dx = (H[y * size + xr] - H[y * size + xl]) * size * 0.5;
      const dy = (H[yu * size + x] - H[yd * size + x]) * size * 0.5;
      sl[(y * size + x) * 2] = dx;
      sl[(y * size + x) * 2 + 1] = dy;
      sum2 += dx * dx + dy * dy;
    }
  }
  const std = Math.sqrt(sum2 / (size * size * 2));
  const scale = 1 / (2.5 * std);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, sl[k * 2] * scale)));
    data[k * 4 + 1] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, sl[k * 2 + 1] * scale)));
    data[k * 4 + 2] = Math.round(H[k] * 255);
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ----------------------------------------------------------------------------
 * Shaders
 * ------------------------------------------------------------------------- */

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const SIM_FRAG = /* glsl */ `
uniform sampler2D uState;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform vec2 uDomain;
uniform float uDt;
uniform float uFlowScale;
uniform float uTime;
uniform float uTurb;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec4 f = texture2D(uField, vUv);
  float mask = step(f.w, -0.004);
  // Semi-Lagrangian advection: ripples drift downstream with the current
  vec2 back = vUv - f.xy * uFlowScale * uDt / uDomain;
  vec4 s = texture2D(uState, back);
  float avg = (
    texture2D(uState, back + vec2(uTexel.x, 0.0)).r +
    texture2D(uState, back - vec2(uTexel.x, 0.0)).r +
    texture2D(uState, back + vec2(0.0, uTexel.y)).r +
    texture2D(uState, back - vec2(0.0, uTexel.y)).r) * 0.25;
  s.g += (avg - s.r) * 2.0;
  s.g *= 0.993;
  // Turbulent forcing behind stones, over riffles and in fast water
  float n = vnoise3(vec3(vUv * uDomain * 11.0, uTime * 3.0)) - 0.5;
  s.g += n * f.z * uTurb * clamp(uFlowScale, 0.0, 2.0);
  s.r += s.g;
  // Absorb waves at the cut edges of the diorama, reflect them at banks and stones
  float edge = smoothstep(0.0, 0.025, min(vUv.x, 1.0 - vUv.x)) * smoothstep(0.0, 0.025, min(vUv.y, 1.0 - vUv.y));
  float keep = mask * mix(0.94, 1.0, edge);
  s.r = clamp(s.r * keep * 0.9995, -0.08, 0.08);
  s.g *= keep;
  gl_FragColor = s;
}`;

const DROP_FRAG = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uDomain;
uniform vec4 uDrops[8];
uniform int uCount;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(uState, vUv);
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec2 d = (vUv - uDrops[i].xy) * uDomain;
    float l = length(d) / uDrops[i].z;
    if (l < 1.0) {
      float drop = 0.5 - 0.5 * cos((1.0 - l) * 3.14159265);
      s.r += drop * uDrops[i].w;
    }
  }
  gl_FragColor = s;
}`;

const WATER_VERT = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uDomain;
varying vec3 vWPos;
varying vec2 vSimUv;
varying float vViewZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vSimUv = vec2((wp.x + uDomain.x * 0.5) / uDomain.x, (wp.z + uDomain.y * 0.5) / uDomain.y);
  wp.y += texture2D(uState, vSimUv).r;
  vWPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const WATER_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D uState;
uniform sampler2D uField;
uniform sampler2D uDetail;
uniform sampler2D uScene;
uniform sampler2D uSceneDepth;
uniform vec2 uTexel;
uniform vec2 uDomain;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uFlowScale;
uniform float uTurbidity;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform mat4 uViewProj;
varying vec3 vWPos;
varying vec2 vSimUv;
varying float vViewZ;
${NOISE_GLSL}
${SKY_GLSL}

float sceneDepthAt(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(uSceneDepth, uv).r, uNear, uFar);
}

// Screen-space reflection of the above-water scene (stones, banks, grass)
vec3 ssr(vec3 P, vec3 R, out float hit) {
  hit = 0.0;
  float tPrev = 0.0;
  float t = 0.03;
  for (int i = 0; i < 18; i++) {
    vec3 q = P + R * t;
    vec4 c = uViewProj * vec4(q, 1.0);
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float diff = c.w - sceneDepthAt(uv);
    if (diff > 0.0 && diff < 0.05 + t * 0.3) {
      float lo = tPrev, hi = t;
      for (int k = 0; k < 5; k++) {
        float mid = 0.5 * (lo + hi);
        vec4 cm = uViewProj * vec4(P + R * mid, 1.0);
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        if (cm.w - sceneDepthAt(um) > 0.0) hi = mid; else lo = mid;
      }
      vec4 cf = uViewProj * vec4(P + R * hi, 1.0);
      vec2 uf = cf.xy / cf.w * 0.5 + 0.5;
      vec2 e = min(uf, 1.0 - uf);
      hit = smoothstep(0.0, 0.08, e.x) * smoothstep(0.0, 0.08, e.y) * (1.0 - float(i) / 18.0);
      return texture2D(uScene, uf).rgb;
    }
    tPrev = t;
    t *= 1.36;
  }
  return vec3(0.0);
}

void main() {
  vec4 f = texture2D(uField, vSimUv);

  // Ripple normal from the simulated height field
  vec2 cell = uDomain * uTexel;
  float hL = texture2D(uState, vSimUv - vec2(uTexel.x, 0.0)).r;
  float hR = texture2D(uState, vSimUv + vec2(uTexel.x, 0.0)).r;
  float hD = texture2D(uState, vSimUv - vec2(0.0, uTexel.y)).r;
  float hU = texture2D(uState, vSimUv + vec2(0.0, uTexel.y)).r;
  vec2 slope = vec2(hR - hL, hU - hD) / (2.0 * cell);

  // Flow-mapped micro waves (two phases blended to hide the reset)
  vec2 flow = f.xy * uFlowScale;
  float spd = length(flow);
  float T = 1.6;
  float ph0 = fract(uTime / T);
  float ph1 = fract(uTime / T + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 p = vWPos.xz;
  vec4 d0 = texture2D(uDetail, p * 0.55 - flow * ph0 * T * 0.55);
  vec4 d1 = texture2D(uDetail, p * 0.55 - flow * ph1 * T * 0.55 + 0.37);
  vec4 e0 = texture2D(uDetail, p * 1.7 - flow * ph0 * T * 1.7 + 0.13);
  vec4 e1 = texture2D(uDetail, p * 1.7 - flow * ph1 * T * 1.7 + 0.71);
  vec2 ds = ((d0.xy * 2.0 - 1.0) * w0 + (d1.xy * 2.0 - 1.0) * (1.0 - w0)) * 0.6
          + ((e0.xy * 2.0 - 1.0) * w0 + (e1.xy * 2.0 - 1.0) * (1.0 - w0)) * 0.4;
  float wake = clamp(f.z, 0.0, 1.5);
  float detailAmt = 0.05 + 0.5 * clamp(spd * 1.8, 0.0, 1.0) + 0.4 * clamp(wake, 0.0, 1.0);
  slope += ds * detailAmt;

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 V = normalize(cameraPosition - vWPos);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // Refraction with depth-aware fallback
  vec2 suv = gl_FragCoord.xy / uResolution;
  float wz = vViewZ;
  float s0 = sceneDepthAt(suv);
  float thick0 = max(s0 - wz, 0.0);
  vec2 dNv = (viewMatrix * vec4(N - vec3(0.0, 1.0, 0.0), 0.0)).xy;
  vec2 ruv = suv + dNv * min(thick0, 0.35) * 2.2 / max(wz, 0.5);
  float s1 = sceneDepthAt(ruv);
  if (s1 < wz) { ruv = suv; s1 = s0; }
  vec3 refr = texture2D(uScene, ruv).rgb;
  float thick = max(s1 - wz, 0.0);

  // Beer-Lambert absorption plus in-scattering (tea-green creek water)
  float sunUp = clamp(uSunDir.y, 0.15, 1.0);
  vec3 trans = exp(-vec3(2.4, 0.95, 1.15) * uTurbidity * thick);
  vec3 scatter = s2l(vec3(0.2, 0.28, 0.22)) * 1.2 * sunUp;
  vec3 water = refr * trans + scatter * (1.0 - trans);

  // Reflection: SSR of the scene above water, falling back to the sky
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.02);
  R = normalize(R);
  vec3 sky = skyColor(R, uSunDir, uSunColor, 0.0);
  float hit;
  vec3 ssrC = ssr(vWPos, R, hit);
  vec3 refl = mix(sky, ssrC, hit);
  float shore = smoothstep(0.0, 0.02, thick);
  vec3 col = mix(water, refl, F * shore);

  // Sun glints
  vec3 H = normalize(uSunDir + V);
  float NdH = max(dot(N, H), 0.0);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  float spec = pow(NdH, 1400.0) * 40.0 + pow(NdH, 160.0) * 1.5;
  col += uSunColor * spec * Fh * smoothstep(0.0, 0.1, uSunDir.y) * shore;

  // Foam streaks in turbulent water, advected with the same flow map
  float fn = d0.z * w0 + d1.z * (1.0 - w0);
  float fn2 = e0.z * w0 + e1.z * (1.0 - w0);
  float foamMask = clamp(wake - 0.25, 0.0, 1.0) * clamp(spd * 3.0, 0.2, 1.0);
  float foam = smoothstep(0.5, 0.8, fn * 0.55 + fn2 * 0.45 + foamMask * 0.35) * foamMask;
  vec3 foamCol = s2l(vec3(0.86, 0.88, 0.86)) * (0.3 + 0.9 * sunUp);
  col = mix(col, foamCol, clamp(foam, 0.0, 0.7) * shore);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ----------------------------------------------------------------------------
 * Water system
 * ------------------------------------------------------------------------- */

export function createWater(renderer, shared, stones) {
  const { tex: fieldTex, bed } = buildField(stones);
  const detailTex = buildDetailTexture();

  const rtOpts = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  };
  let rtA = new THREE.WebGLRenderTarget(NX, NZ, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(NX, NZ, rtOpts);

  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const domain = new THREE.Vector2(SIZE_X, SIZE_Z);
  const texel = new THREE.Vector2(1 / NX, 1 / NZ);

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      uState: { value: null },
      uField: { value: fieldTex },
      uTexel: { value: texel },
      uDomain: { value: domain },
      uDt: { value: SIM_DT },
      uFlowScale: shared.uFlowScale,
      uTime: shared.uTime,
      uTurb: { value: 0.00009 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: SIM_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const dropMat = new THREE.ShaderMaterial({
    uniforms: {
      uState: { value: null },
      uDomain: { value: domain },
      uDrops: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      uCount: { value: 0 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: DROP_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const clearColor = new THREE.Color();
  function clearTargets() {
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    renderer.setClearColor(0x000000, 0);
    for (const rt of [rtA, rtB]) {
      renderer.setRenderTarget(rt);
      renderer.clear();
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor, prevAlpha);
  }
  clearTargets();

  function runPass(material) {
    material.uniforms.uState.value = rtA.texture;
    quad.material = material;
    renderer.setRenderTarget(rtB);
    renderer.render(quadScene, quadCam);
    const t = rtA;
    rtA = rtB;
    rtB = t;
  }

  // Surface mesh
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uState: { value: rtA.texture },
      uField: { value: fieldTex },
      uDetail: { value: detailTex },
      uScene: { value: null },
      uSceneDepth: { value: null },
      uTexel: { value: texel },
      uDomain: { value: domain },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 100 },
      uTime: shared.uTime,
      uFlowScale: shared.uFlowScale,
      uTurbidity: { value: 1.0 },
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uViewProj: { value: new THREE.Matrix4() },
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  });
  const waterGeo = new THREE.PlaneGeometry(SIZE_X, SIZE_Z, NX, NZ);
  waterGeo.rotateX(-Math.PI / 2);
  const surface = new THREE.Mesh(waterGeo, waterMat);
  surface.position.y = WATER_LEVEL;
  surface.layers.set(1);
  surface.name = 'water';

  // Glass-like water cross-sections where the creek meets the diorama's cut edges
  const sideGroup = new THREE.Group();
  const sideMat = new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, opacity: 0.62, roughness: 0.06, metalness: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const cTop = new THREE.Color().setRGB(0.32, 0.4, 0.34, THREE.SRGBColorSpace);
  const cDeep = new THREE.Color().setRGB(0.08, 0.14, 0.1, THREE.SRGBColorSpace);
  for (const sx of [-SIZE_X / 2, SIZE_X / 2]) {
    const N = 240;
    const pos = [];
    const col = [];
    const index = [];
    for (let k = 0; k <= N; k++) {
      const z = -SIZE_Z / 2 + (k / N) * SIZE_Z;
      const h = Math.min(terrainHeight(sx, z), WATER_LEVEL);
      pos.push(sx, WATER_LEVEL, z, sx, h, z);
      col.push(cTop.r, cTop.g, cTop.b);
      const deep = cTop.clone().lerp(cDeep, Math.min((WATER_LEVEL - h) / 0.4, 1));
      col.push(deep.r, deep.g, deep.b);
    }
    for (let k = 0; k < N; k++) {
      const a = k * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, sideMat);
    m.layers.set(1);
    m.renderOrder = 2;
    sideGroup.add(m);
  }

  const pending = [];
  let acc = 0;

  /** Sample bed height (terrain or stone top) at world (x, z). */
  function bedAt(x, z) {
    const fi = Math.min(Math.max((x + SIZE_X / 2) / CELL - 0.5, 0), NX - 1.001);
    const fj = Math.min(Math.max((z + SIZE_Z / 2) / CELL - 0.5, 0), NZ - 1.001);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const tx = fi - i;
    const tz = fj - j;
    const a = bed[j * NX + i] + (bed[j * NX + i + 1] - bed[j * NX + i]) * tx;
    const b = bed[(j + 1) * NX + i] + (bed[(j + 1) * NX + i + 1] - bed[(j + 1) * NX + i]) * tx;
    return a + (b - a) * tz;
  }

  function isWater(x, z) {
    if (Math.abs(x) >= SIZE_X / 2 || Math.abs(z) >= SIZE_Z / 2) return false;
    return bedAt(x, z) < WATER_LEVEL - 0.006;
  }

  /** Queue a disturbance at world (x, z). Negative strength pushes the surface down. */
  function addDrop(x, z, radius, strength) {
    pending.push(new THREE.Vector4((x + SIZE_X / 2) / SIZE_X, (z + SIZE_Z / 2) / SIZE_Z, radius, strength));
  }

  function update(dt) {
    while (pending.length) {
      const batch = pending.splice(0, 8);
      batch.forEach((d, k) => dropMat.uniforms.uDrops.value[k].copy(d));
      dropMat.uniforms.uCount.value = batch.length;
      runPass(dropMat);
    }
    acc = Math.min(acc + dt, SIM_DT * 4);
    while (acc >= SIM_DT) {
      runPass(simMat);
      acc -= SIM_DT;
    }
    renderer.setRenderTarget(null);
    waterMat.uniforms.uState.value = rtA.texture;
  }

  /** Bind the opaque scene render target and camera data before drawing the surface. */
  function setView(sceneRT, camera) {
    const u = waterMat.uniforms;
    u.uScene.value = sceneRT.texture;
    u.uSceneDepth.value = sceneRT.depthTexture;
    u.uResolution.value.set(sceneRT.width, sceneRT.height);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }

  return { surface, sides: sideGroup, update, setView, addDrop, isWater, bedAt };
}
