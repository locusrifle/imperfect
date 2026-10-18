// The sky, drawn by code: one THREE.Points holding every star, the fine stipple dust, the four-point star bursts and
// the dotted little galaxies, spread through several depths behind the page. Change the look in STARS below.
//
// For the black hole (blackhole/): field.points is ONE THREE.Points; its geometry's attributes 'position' (xyz,
// world space), 'size' (CSS px) and 'alpha' (0..1) are plain Float32Arrays the module may drive each frame (set
// .needsUpdate on the attribute). field.base keeps the resting values. Twinkle and the fade-in multiply alpha in
// the shader, so whatever the module writes stays in charge.
//
// tick()'s flow streams the field as imperfect's own sky streams across its bars (apps/code's stardust.js): the upper
// half of the screen rightwards, the lower half leftwards, each star wrapping round within its layer. flow is how far
// the page plane has gone, in world units; a star at depth d goes 1 / (1 + d) of that on screen, so the nearest
// cross the screen about five times faster than the farthest, as the app's do.
//
// tick()'s avoid is imperfect's (sky.mjs, its kept sky behind the window): the composer's lines push the points
// over them aside, past the nearer edge, its cursor keeps a little round room, and each keystroke knocks the
// points near it away on a spring that brings them home. All in screen px and a pure function of the time, so
// nothing is integrated and nothing resets. Without it nothing moves.
//
// World units: CSS px on the page plane (z = 0), y up (page y is -y). The camera sits at z = D looking down -z.
import * as THREE from './vendor/three.module.js';

export const STARS = {
  seed: 20261008,
  // per screenful at 1536x864 (smaller screens get fewer, never under half). depth: behind the page plane, in
  // camera distances (1 = as far behind the page as the camera is in front of it). size in CSS px.
  layers: [
    { name: 'dust', count: 2600, depth: [2.5, 6], size: [0.8, 1.4], alpha: [0.22, 0.6], twinkle: 0.12 },
    { name: 'stipple', count: 1500, depth: [1.2, 2.5], size: [1, 1.8], alpha: [0.35, 0.85], twinkle: 0.3 },
    { name: 'stars', count: 220, depth: [0.5, 1.2], size: [1.6, 2.9], alpha: [0.7, 1], twinkle: 0.5 },
    { name: 'bright', count: 30, depth: [0.3, 0.8], size: [2.8, 4.5], alpha: [0.9, 1], twinkle: 0.6 },
  ],
  bursts: { count: 11, depth: [0.4, 1.4], size: [18, 46] },                // four-point star bursts, like the painted ones
  galaxies: { count: 1.3, depth: [1, 2.2], radius: [24, 58], dots: 240, core: [30, 64] }, // dotted discs, glowing core
  twinkle: { speed: [0.5, 2.4], amount: 0.6 },
  // the middle of the first screen, behind the wordmark (screen units, x -1..1, y -1 top .. 1 bottom): fewer, dimmer
  // stars, fully so within radius[0] and easing out by radius[1]. Round, about the twist's centre, so the turn can
  // never wind it into an arm.
  quiet: { radius: [0.28, 0.62], keep: 0.3, dim: 0.55 },
  fill: 1.72,    // stars also fill the disc this far out (screen units, past ROTATION.rest), so the turn never brings empty sky in
  screens: 2,    // the camera travels down this many screens
  margin: 1.15,  // stars reach this far past each screen edge, for the pointer's parallax
  color: [1, 0.985, 0.96],
};

// The twist's law, shared by the website, the lock and imperfect's kept sky (sky.mjs): radians a second at the centre
// and at the screen's edge (r = 1, in screen units about the first screen's centre), climbing linearly with the
// radius out to hold (past the screen's corners, r = 1.414) and easing to stillness by rest. Constant in time.
export const ROTATION = Object.freeze({ centre: 0.03, edge: 0.12, hold: 1.42, rest: 1.7 });
const RATE = [ROTATION.centre, ROTATION.edge, ROTATION.hold, ROTATION.rest];
// The same law in JS (the vertex shader below is what draws): rad/s at r screen units from the centre.
export function twistRate(r, { centre, edge, hold, rest } = ROTATION) {
  const t = Math.min(1, Math.max(0, (r - hold) / (rest - hold)));
  return (centre + (edge - centre) * Math.min(r, hold)) * (1 - t * t * (3 - 2 * t));
}

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const VERT = `
attribute float size; attribute float alpha; attribute float kind; attribute vec2 twinkle;
attribute vec3 orbit; // resting position: each star keeps its own constant rate even during the burst
attribute vec2 anchor; // what its rate is measured from: itself, or its little galaxy's core (so that turns whole)
uniform float uTime, uPixelRatio, uTwinkle, uOpacity, uFlow;
uniform vec3 uSpan; // the screen's width, the camera's distance D, and the field's margin
uniform vec2 uViewport;
uniform float uTwist; // opt-in elapsed motion seconds; zero leaves the website unchanged
uniform vec4 uRotation; // rad/s at the centre and at the screen's edge (r = 1); the rate climbs linearly out to
                        // r = z, then eases to nothing by r = w (only the website's second screen sees past z)
uniform vec4 uAvoid[8]; uniform float uAvoidCount; // opt-in: lines kept clear (CSS px: left, top, right, bottom)
uniform vec3 uCaret;   // and a cursor's centre and the room round it (px); radius 0 is none
uniform vec4 uKick[4]; // and keystrokes: where (px), when (uTime), how hard (px/s); strength 0 is none
varying float vAlpha; varying float vKind;
void main() {
  vec3 p = position;
  if (uTwist != 0.0) {
    // Rotate at each depth about the first screen's centre: slow in the middle, faster and faster outwards, each
    // star at its own constant rate. The turn keeps every star at its radius, so the evenly filled disc stays even.
    float k = 1.0 - p.z / uSpan.y;
    vec2 centre = vec2(uViewport.x, -uViewport.y) * 0.5;
    vec2 q = (p.xy - centre) / (uViewport * 0.5 * k);
    vec2 home = (anchor - centre) / (uViewport * 0.5 * (1.0 - orbit.z / uSpan.y));
    float r = length(home);
    float angle = uTwist * (uRotation.x + (uRotation.y - uRotation.x) * min(r, uRotation.z)) * (1.0 - smoothstep(uRotation.z, uRotation.w, r));
    float c = cos(angle), s = sin(angle);
    q = mat2(c, s, -s, c) * q;
    p.xy = centre + q * (uViewport * 0.5 * k);
  }
  if (uFlow > 0.0) {
    vec4 c = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    float dir = smoothstep(-0.2, 0.2, c.y / c.w) * 2.0 - 1.0;
    float w = uSpan.z * uSpan.x * (1.0 - p.z / uSpan.y); // how wide the field is at this star's depth
    p.x = 0.5 * uSpan.x + mod(p.x - 0.5 * uSpan.x + 0.5 * w + dir * uFlow, w) - 0.5 * w;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float near = 1.0;
  if (uAvoidCount > 0.0 || uCaret.z > 0.0 || uKick[0].w > 0.0) {
    vec2 o = vec2((gl_Position.x / gl_Position.w + 1.0) * 0.5 * uViewport.x, (1.0 - gl_Position.y / gl_Position.w) * 0.5 * uViewport.y);
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uAvoidCount) break;
      vec4 b = uAvoid[i];
      if (o.x > b.x && o.x < b.z && o.y > b.y && o.y < b.w) { float up = o.y - b.y, down = b.w - o.y; o.y = up < down ? b.y - 0.5 * up : b.w + 0.5 * down; }
      vec2 gap = max(vec2(b.x - o.x, b.y - o.y), vec2(o.x - b.z, o.y - b.w));
      near = min(near, mix(0.45, 1.0, clamp(max(gap.x, gap.y) / 8.0, 0.0, 1.0)));
    }
    vec2 d = o - uCaret.xy; float r = length(d);
    if (uCaret.z > 0.0 && r < uCaret.z) o = uCaret.xy + (r > 0.001 ? d / r : vec2(0.0, -1.0)) * (uCaret.z + 0.5 * (uCaret.z - r));
    for (int k = 0; k < 4; k++) {
      vec4 kick = uKick[k]; float age = uTime - kick.z;
      if (kick.w <= 0.0 || age <= 0.0 || age > 1.5) continue;
      vec2 e = o - kick.xy; float er = max(length(e), 1.0);
      o += e / er * kick.w / 3.7 * exp(-7.5 * age) * sin(3.7 * age) * exp(-er / 52.0); // stardust.js's spring: 70/s², 15/s
    }
    gl_Position.xy = vec2(o.x / uViewport.x * 2.0 - 1.0, 1.0 - o.y / uViewport.y * 2.0) * gl_Position.w;
  }
  float s = 0.5 + 0.5 * sin(uTime * twinkle.y + twinkle.x);
  float tw = twinkle.y > 0.0 ? 1.0 - uTwinkle * s : 1.0;
  vAlpha = alpha * tw * uOpacity * near; vKind = kind;
  float grow = kind > 0.5 && kind < 1.5 ? 0.88 + 0.12 * s : 1.0;
  gl_PointSize = max(size * grow * uPixelRatio, 1.0);
}`;
const FRAG = `
uniform vec3 uColor;
varying float vAlpha; varying float vKind;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p); float a;
  if (vKind < 0.5) a = smoothstep(1.0, 0.35, r);
  else if (vKind < 1.5) {
    float arms = max(exp(-abs(p.y) * 26.0) * pow(max(1.0 - abs(p.x), 0.0), 2.4), exp(-abs(p.x) * 26.0) * pow(max(1.0 - abs(p.y), 0.0), 2.4));
    vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.7071;
    float diag = 0.45 * max(exp(-abs(q.y) * 34.0) * pow(max(1.0 - abs(q.x) * 1.9, 0.0), 3.0), exp(-abs(q.x) * 34.0) * pow(max(1.0 - abs(q.y) * 1.9, 0.0), 3.0));
    a = arms + diag + exp(-r * r * 40.0) + 0.22 * exp(-r * r * 7.0);
  } else a = (0.5 * exp(-r * r * 6.0) + exp(-r * r * 70.0)) * smoothstep(1.0, 0.6, r);
  a = clamp(a, 0.0, 1.0) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, a);
}`;

// The field: build once (counts fixed for the visit), place() again on every resize.
export function createStars({ width, height } = {}) {
  const C = STARS, rand = rng(C.seed), m = C.margin, travel = C.screens - 1;
  const area = Math.min(1.4, Math.max(0.5, ((width || 1536) * (height || 864)) / (1536 * 864)));
  const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;
  const u = [], v = [], d = [], ox = [], oy = [], size = [], alpha = [], kind = [], tw = [];
  const [q0, q1] = C.quiet.radius, quiet = (x, y) => { const t = Math.min(1, Math.max(0, (q1 - Math.hypot(x, y)) / (q1 - q0))); return t * t * (3 - 2 * t); };
  const span = dd => 2 * m + 2 * travel / (1 + dd); // screen units of height a layer at depth dd spans
  const push = (uu, vv, dd, s, al, k, twk, oxx = 0, oyy = 0) => {
    u.push(uu); v.push(vv); d.push(dd); ox.push(oxx); oy.push(oyy); size.push(s); alpha.push(al); kind.push(k);
    tw.push(twk ? rand() * 6.283 : 0, twk ? lerp(C.twinkle.speed, rand()) : 0);
  };
  for (const L of C.layers) {
    const mid = (L.depth[0] + L.depth[1]) / 2, n = Math.round(L.count * area * (2 * m * span(mid)) / 4);
    for (let i = 0; i < n; i++) {
      const dd = lerp(L.depth, rand()), uu = (rand() * 2 - 1) * m, vv = -m + rand() * span(dd);
      let al = lerp(L.alpha, rand() ** 1.5);
      const qq = quiet(uu, vv);
      if (qq > 0) { if (L.name !== 'dust' && rand() > 1 - qq * (1 - C.quiet.keep)) continue; al *= 1 - qq * (1 - C.quiet.dim); }
      push(uu, vv, dd, lerp(L.size, rand() ** 2), al, 0, rand() < L.twinkle);
    }
  }
  const cores = {}; // a little galaxy's dot -> its core's index
  const B = C.bursts, nb = Math.round(B.count * area * (2 * m * span(1)) / 4);
  for (let i = 0, tries = 0; i < nb && tries < nb * 20; tries++) {
    const dd = lerp(B.depth, rand()), uu = (rand() * 2 - 1) * m, vv = -m + rand() * span(dd);
    if (quiet(uu, vv) > 0.5) continue;
    push(uu, vv, dd, lerp(B.size, rand() ** 1.6), 0.8 + 0.2 * rand(), 1, true); i++;
  }
  const G = C.galaxies, ng = Math.max(1, Math.round(G.count * (2 * m * span(1.5)) / 4));
  for (let i = 0, tries = 0; i < ng && tries < ng * 40; tries++) {
    const dd = lerp(G.depth, rand()), uu = (rand() * 1.6 - 0.8), vv = -0.85 + rand() * (span(dd) - 2 * m + 1.7);
    if (quiet(uu, vv) > 0 || Math.abs(uu) < 0.3) continue; // keep them off the line's path down the middle
    i++;
    const R = lerp(G.radius, rand()), tilt = rand() * Math.PI, flat = 0.45 + 0.4 * rand(), twist = 2 + rand() * 3;
    push(uu, vv, dd, lerp(G.core, rand()), 0.9, 2, false);
    const core = u.length - 1;
    for (let k = 0; k < G.dots; k++) {
      const rr = R * Math.min(1, Math.sqrt(-Math.log(1 - rand() * 0.98)) / 2.2), arm = (k % 2) * Math.PI;
      const th = arm + rr / R * twist + (rand() - 0.5) * 1.6;
      const x = rr * Math.cos(th), y = rr * Math.sin(th) * flat;
      push(uu, vv, dd, 0.8 + rand() * 1.1, (0.35 + 0.65 * rand()) * (1 - 0.6 * rr / R), 0, rand() < 0.3,
        x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt));
      cores[u.length - 1] = core;
    }
  }
  // The rest of the disc the turn sweeps through, outside the field above: the same layers at the same density,
  // after every star above so none of those moves. Without them the faster rim would bring empty sky round.
  const outside = (uu, vv, dd) => Math.hypot(uu, vv) <= C.fill && (Math.abs(uu) > m || vv < -m || vv > -m + span(dd));
  for (const L of C.layers) {
    const tries = Math.round(L.count * area * (2 * C.fill) ** 2 / 4);
    for (let i = 0; i < tries; i++) {
      const dd = lerp(L.depth, rand()), uu = (rand() * 2 - 1) * C.fill, vv = (rand() * 2 - 1) * C.fill;
      const sz = lerp(L.size, rand() ** 2), al = lerp(L.alpha, rand() ** 1.5), twk = rand() < L.twinkle;
      if (outside(uu, vv, dd)) push(uu, vv, dd, sz, al, 0, twk);
    }
  }
  for (let i = 0, tries = Math.round(B.count * area * (2 * C.fill) ** 2 / 4); i < tries; i++) {
    const dd = lerp(B.depth, rand()), uu = (rand() * 2 - 1) * C.fill, vv = (rand() * 2 - 1) * C.fill;
    const sz = lerp(B.size, rand() ** 1.6), al = 0.8 + 0.2 * rand();
    if (outside(uu, vv, dd)) push(uu, vv, dd, sz, al, 1, true);
  }

  const n = u.length;
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(n * 3), orbit = new Float32Array(n * 3), anchor = new Float32Array(n * 2);
  geometry.setAttribute('orbit', new THREE.BufferAttribute(orbit, 3));
  geometry.setAttribute('anchor', new THREE.BufferAttribute(anchor, 2));
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(size), 1));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(alpha), 1));
  geometry.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(kind), 1));
  geometry.setAttribute('twinkle', new THREE.BufferAttribute(new Float32Array(tw), 2));
  for (const name of ['position', 'size', 'alpha']) geometry.attributes[name].setUsage(THREE.DynamicDrawUsage);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uTwinkle: { value: C.twinkle.amount }, uOpacity: { value: 1 }, uFlow: { value: 0 }, uTwist: { value: 0 }, uRotation: { value: new THREE.Vector4(...RATE) }, uAvoid: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uAvoidCount: { value: 0 }, uCaret: { value: new THREE.Vector3() }, uKick: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uViewport: { value: new THREE.Vector2(1, 1) }, uSpan: { value: new THREE.Vector3(1, 1, m) }, uColor: { value: new THREE.Color(...C.color) } },
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1000;

  const field = {
    points, geometry, material, count: n,
    base: { position: orbit, size: new Float32Array(size), alpha: new Float32Array(alpha) },
    // where each star rests for a viewport of vw x vh with the camera D in front of the page plane
    place(vw, vh, D) {
      for (let i = 0; i < n; i++) {
        const k = 1 + d[i];
        position[3 * i] = vw / 2 + u[i] * (vw / 2) * k + ox[i] * k;
        position[3 * i + 1] = -(vh / 2 + v[i] * (vh / 2) * k) - oy[i] * k;
        position[3 * i + 2] = -d[i] * D;
      }
      for (let i = 0; i < n; i++) { const c = cores[i] ?? i; anchor[2 * i] = position[3 * c]; anchor[2 * i + 1] = position[3 * c + 1]; }
      field.base.position.set(position);
      geometry.attributes.orbit.needsUpdate = true;
      geometry.attributes.anchor.needsUpdate = true;
      geometry.attributes.position.needsUpdate = true;
      material.uniforms.uSpan.value.set(vw, D, m);
      material.uniforms.uViewport.value.set(vw, vh);
    },
    // back to resting values (after the black hole, or to replay)
    reset() {
      geometry.attributes.position.array.set(field.base.position);
      geometry.attributes.size.array.set(field.base.size);
      geometry.attributes.alpha.array.set(field.base.alpha);
      for (const name of ['position', 'size', 'alpha']) geometry.attributes[name].needsUpdate = true;
    },
    // avoid: { lines: [[left, top, right, bottom]…] (8 at most), caret: [x, y, r] or null, kicks: [[x, y, t, strength]…] (4) }
    tick(t, pixelRatio, { twinkle = true, opacity = 1, flow = 0, twist = 0, rotation = null, avoid = null } = {}) {
      const U = material.uniforms, lines = avoid?.lines || [], kicks = avoid?.kicks || [];
      U.uAvoidCount.value = Math.min(8, lines.length);
      for (let i = 0; i < U.uAvoidCount.value; i++) U.uAvoid.value[i].set(...lines[i]);
      U.uCaret.value.set(...(avoid?.caret || [0, 0, 0]));
      for (let k = 0; k < 4; k++) U.uKick.value[k].set(...(kicks[k] || [0, 0, 0, 0]));
      material.uniforms.uTime.value = t;
      material.uniforms.uPixelRatio.value = pixelRatio;
      material.uniforms.uTwinkle.value = twinkle ? C.twinkle.amount : 0;
      material.uniforms.uOpacity.value = opacity;
      material.uniforms.uFlow.value = flow;
      material.uniforms.uTwist.value = twist;
      const R = rotation || {};
      U.uRotation.value.set(R.centre ?? RATE[0], R.edge ?? RATE[1], R.hold ?? RATE[2], R.rest ?? RATE[3]);
    },
  };
  return field;
}
