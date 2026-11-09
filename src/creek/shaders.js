/**
 * Shared GLSL chunks and a helper that patches MeshStandardMaterial with
 * procedural albedo, micro-bump, wetness and underwater caustics.
 */

export const NOISE_GLSL = /* glsl */ `
vec3 s2l(vec3 c) { return pow(c, vec3(2.2)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0));
  float c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1));
  float h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
             mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise2(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.01 + vec3(7.3, 3.1, 11.7); a *= 0.5; }
  return s;
}
// Cellular noise: x = distance to nearest feature point, y = random id of that cell
vec2 voronoi2(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  float md = 8.0; vec2 id = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g) * 0.85 + 0.075;
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; id = n + g; }
    }
  }
  return vec2(sqrt(md), hash12(id));
}
// Tileable caustic pattern (period 1.0 in uv), based on the classic iterative trig caustic
float caustic(vec2 uv, float time) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
// Screen-space bump mapping from an arbitrary scalar height (Mikkelsen surface gradient)
vec3 perturbNormalH(vec3 surfPos, vec3 surfNorm, float h) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

export const SKY_GLSL = /* glsl */ `
vec3 skyColor(vec3 d, vec3 sunDir, vec3 sunColor, float withDisc) {
  float y = max(d.y, 0.0);
  float day = clamp(sunDir.y * 2.5, 0.25, 1.0);
  vec3 zen = s2l(vec3(0.36, 0.52, 0.74)) * day;
  vec3 hor = mix(s2l(vec3(0.95, 0.78, 0.62)), s2l(vec3(0.78, 0.84, 0.88)), day) * day;
  vec3 c = mix(hor, zen, pow(y, 0.45));
  vec2 cp = d.xz / (d.y + 0.18);
  float cl = smoothstep(0.5, 0.85, fbm2(cp * 1.3 + 3.0));
  c = mix(c, hor * 1.25, cl * 0.55 * smoothstep(0.0, 0.25, d.y));
  float sd = max(dot(d, sunDir), 0.0);
  c += sunColor * (pow(sd, 900.0) * 8.0 * withDisc + pow(sd, 10.0) * 0.12);
  if (d.y < 0.0) c = mix(hor * 0.55, s2l(vec3(0.24, 0.22, 0.18)) * day, clamp(-d.y * 3.0, 0.0, 1.0));
  return c;
}
`;

/**
 * Patch a MeshStandardMaterial with procedural shading.
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} opts
 * @param {object} opts.shared     Shared uniforms (uTime, uSunDir, uSunColor, uWaterLevel, uFlowScale)
 * @param {object} [opts.uniforms] Extra per-material uniforms
 * @param {string} [opts.vertexHead]  Extra vertex declarations
 * @param {string} [opts.vertexBody]  Extra vertex code (after world position is known)
 * @param {string} [opts.fragmentHead] Extra fragment declarations/functions
 * @param {string} opts.albedo     Fragment code: may modify diffuseColor.rgb, must assign bumpH
 * @param {number} [opts.wetRough] Roughness of wet surfaces
 * @param {string} [opts.cacheKey] Program cache key
 */
export function patchNatureMaterial(material, opts) {
  const {
    shared, uniforms = {}, vertexHead = '', vertexBody = '', fragmentHead = '',
    albedo, wetRough = 0.18, cacheKey = 'nature',
  } = opts;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
varying vec3 vWPos;
varying vec3 vOPos;
varying vec3 vWNormal;
${vertexHead}`)
      .replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
{
  vec4 cwp = vec4(transformed, 1.0);
  vec3 cwn = objectNormal;
#ifdef USE_INSTANCING
  cwp = instanceMatrix * cwp;
  cwn = mat3(instanceMatrix) * cwn;
#endif
  cwp = modelMatrix * cwp;
  vWPos = cwp.xyz;
  vOPos = position;
  vWNormal = normalize(mat3(modelMatrix) * cwn);
}
${vertexBody}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uWaterLevel;
uniform float uFlowScale;
varying vec3 vWPos;
varying vec3 vOPos;
varying vec3 vWNormal;
${NOISE_GLSL}
${fragmentHead}`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
float bumpH = 0.0;
${albedo}
// Wetness: fully wet underwater, plus a ragged damp band just above the waterline
float wetLine = uWaterLevel + 0.03 + 0.025 * vnoise2(vWPos.xz * 9.0);
float wet = 1.0 - smoothstep(wetLine - 0.025, wetLine, vWPos.y);
diffuseColor.rgb *= mix(1.0, 0.58, wet);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * diffuseColor.rgb * 2.2, wet * 0.25);
// Underwater caustics drifting with the current
float uwDepth = uWaterLevel - vWPos.y;
vec3 causticLight = vec3(0.0);
if (uwDepth > 0.0) {
  vec2 cuv = vWPos.xz * 0.42 - vec2(uTime * 0.035 * uFlowScale, 0.0);
  float ca = caustic(cuv, uTime * 0.55) * 0.6 + caustic(cuv * 1.37 + 0.3, uTime * 0.47) * 0.4;
  float sunUp = max(uSunDir.y, 0.0);
  causticLight = uSunColor * ca * sunUp * 1.6 * exp(-uwDepth * 3.0) * smoothstep(0.0, 0.04, uwDepth);
  diffuseColor.rgb *= mix(vec3(1.0), s2l(vec3(0.82, 0.9, 0.84)), clamp(uwDepth * 2.5, 0.0, 1.0));
}`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, ${wetRough.toFixed(3)}, wet);`)
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
normal = perturbNormalH(-vViewPosition, normal, bumpH * mix(1.0, 0.6, wet));`)
      .replace('#include <opaque_fragment>', /* glsl */ `outgoingLight += diffuseColor.rgb * causticLight;
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}
