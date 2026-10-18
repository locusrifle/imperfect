// The air around the cast, after Shopify's Winter '26 hero: about 500 small warm motes (#FFE28C) drifting with a slow
// turbulence and a blink, some behind the characters and some in front of them (never over a face), and a soft glow
// standing in for bloom: the world plate's own light, taken from its most blurred mip level and bright-passed, plus a
// warm haze about the contact, added over the scene. No post-processing, so it costs phones almost nothing.
import * as T from '../vendor/three.module.js';

const MOTE = /* glsl */`
  uniform float uTime, uOpacity, uSize;
  uniform vec3 uCenter, uHalf;
  uniform vec2 uView;            // drawing buffer, device px
  uniform vec4 uFaceA, uFaceB;   // faces on screen: centre (device px, from the top left) and radii
  attribute vec4 seed;           // xyz in -1..1 (place in the volume), w in 0..1 (phase)
  varying float vAlpha;
  void main() {
    vec3 p = uCenter + seed.xyz * uHalf;
    float t = uTime * 0.5, ph = seed.w * 6.2832;
    p.x += uHalf.x * (0.05 * sin(t * 0.37 + ph + seed.y * 3.1) + 0.025 * sin(t * 0.83 + seed.z * 5.0));
    p.y += uHalf.y * (0.06 * sin(t * 0.29 + ph * 0.7 + seed.x * 2.3) + 0.03 * cos(t * 0.71 + seed.z * 4.0));
    p.y = uCenter.y - uHalf.y + mod(p.y - (uCenter.y - uHalf.y) + uTime * uHalf.y * 0.012, 2.0 * uHalf.y); // a slow rise
    p.z += uHalf.z * 0.1 * sin(t * 0.23 + ph * 1.3);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + 0.8 * fract(seed.w * 7.31)) * projectionMatrix[1][1] * uView.y * 0.5 / -mv.z;
    vec2 sp = (gl_Position.xy / gl_Position.w * 0.5 + 0.5) * uView; sp.y = uView.y - sp.y;
    float fa = length((sp - uFaceA.xy) / uFaceA.zw), fb = length((sp - uFaceB.xy) / uFaceB.zw);
    float blink = mix(0.19, 1.0, 0.5 + 0.5 * sin(uTime * 2.2 + seed.w * 40.0));
    vAlpha = uOpacity * blink * smoothstep(1.0, 1.7, fa) * smoothstep(1.0, 1.7, fb);
  }`;
const MOTE_FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-r * r * 3.5) * (1.0 - smoothstep(0.75, 1.0, r));
    gl_FragColor = vec4(uColor * a * vAlpha, 1.0);
  }`;
const GLOW = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GLOW_FRAG = /* glsl */`
  uniform sampler2D map;
  uniform float uAmount, uBias;
  uniform vec3 uWarm;
  uniform vec2 uContact, uRadius;  // device px, from the bottom left (gl_FragCoord)
  varying vec2 vUv;
  void main() {
    vec3 c = texture(map, vUv, uBias).rgb;
    float l = dot(c, vec3(0.3, 0.59, 0.11));
    vec3 light = mix(c, vec3(l) * uWarm, 0.6) * max(l - 0.3, 0.0) * 2.4;  // only the bright parts, leaning warm
    vec2 d = (gl_FragCoord.xy - uContact) / uRadius;
    float haze = exp(-dot(d, d) * 1.4);
    gl_FragColor = vec4((light + uWarm * haze * 0.55) * uAmount, 1.0);
  }`;

export function createAir({ count = 500, seed = 26 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const uniforms = {
    uTime: { value: 0 }, uOpacity: { value: 0 }, uSize: { value: 5 }, uCenter: { value: new T.Vector3() }, uHalf: { value: new T.Vector3(1, 1, 1) },
    uView: { value: new T.Vector2(1, 1) }, uFaceA: { value: new T.Vector4(-1e4, -1e4, 1, 1) }, uFaceB: { value: new T.Vector4(-1e4, -1e4, 1, 1) },
    uColor: { value: new T.Vector3(1, 0xe2 / 255, 0x8c / 255) },
  };
  const material = new T.ShaderMaterial({ uniforms, vertexShader: MOTE, fragmentShader: MOTE_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending });
  // the volume's front part (z > 0.15) floats in front of the characters, the rest behind them
  const back = [], front = [];
  for (let i = 0; i < count; i++) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd()]; (v[2] > 0.15 ? front : back).push(...v); }
  const points = (arr, order) => {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(arr.length / 4 * 3), 3));
    g.setAttribute('seed', new T.Float32BufferAttribute(arr, 4));
    const m = new T.Points(g, material); m.frustumCulled = false; m.renderOrder = order; return m;
  };
  const motes = { back: points(back, 0.5), front: points(front, 4) };

  const glowUniforms = { map: { value: null }, uAmount: { value: 0 }, uBias: { value: 5 }, uWarm: { value: new T.Vector3(1, 0.86, 0.6) }, uContact: { value: new T.Vector2() }, uRadius: { value: new T.Vector2(1, 1) } };
  const glow = new T.Mesh(new T.PlaneGeometry(1, 1), new T.ShaderMaterial({ uniforms: glowUniforms, vertexShader: GLOW, fragmentShader: GLOW_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending }));
  glow.frustumCulled = false; glow.renderOrder = 3;

  return {
    motes, glow, uniforms, glowUniforms,
    // volume: centre and half extents in scene units; the glow follows the world plate (it is the plate's child)
    place({ center, half, size }) { uniforms.uCenter.value.set(...center); uniforms.uHalf.value.set(...half); uniforms.uSize.value = size; },
    update({ time, opacity, glow: amount, view, faces, contact, radius, map }) {
      uniforms.uTime.value = time; uniforms.uOpacity.value = opacity; uniforms.uView.value.set(...view);
      uniforms.uFaceA.value.set(...faces[0]); uniforms.uFaceB.value.set(...faces[1]);
      motes.back.visible = motes.front.visible = opacity > 0.002;
      glowUniforms.uAmount.value = amount; glow.visible = amount > 0.002;
      glowUniforms.uContact.value.set(contact[0], view[1] - contact[1]); glowUniforms.uRadius.value.set(radius, radius);
      if (map && glowUniforms.map.value !== map) glowUniforms.map.value = map;
    },
  };
}
