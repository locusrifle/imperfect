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
// lens() draws another part of the sky, smaller, at a point on the screen (opt-in, none by default): the launch page's
// bubble looks onto more of a richer part of the sky than the quiet middle it opens in.
//
// warp() is the launch film's hyperdrive (opt-in: never called, or speed 0, leaves every sky exactly as it was). The
// field fades out and a layer of streaks (built the first time it is asked for) fades in, by smoothstep(0, WARP_IN,
// speed): every star flies at the camera again and again, out along its own line from the middle through where it
// rests. Each star has its own place in that flight (a golden-ratio sequence, not where it rests), so at every moment
// the same number are at every depth and the hyperdrive is steady: no waves of stars, no pulsing. (The old one flew
// the field's own depths, which are bunched, so the bunches swept past as waves every 1.7 s.) distance is how far it
// has flown, in whole depths (only its fraction matters), speed how fast now (1 = full hyperdrive: a star crosses the
// whole depth in about 1.7 s).
//
// pixels (createStars' option, the launch page's): the same stars drawn as small crisp squares of whole device pixels,
// like imperfect's own dust on its bars (apps/code's stardust.js), with a gentler twinkle; the four-point bursts and
// the little galaxies' glowing cores are a few slightly bigger squares. Its hyperdrive streaks are crisp too. pixels may
// also be the pixel sky's options: { clusters: false } leaves the little galaxies (the dotted clusters) out, every other
// star exactly as it was (the launch page's).
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

// The launch page's pixel sky (createStars({ pixels: true })): the same stars, as squares of whole device pixels.
export const PIXELS = Object.freeze({
  size: [0.35, 0.3], // a plain star's square, CSS px: size[0] + size[1] x its soft size (0.8-4.5), so 1-2 device px on
                     // a laptop (DPR 2) and 2-3 on a phone (DPR 3), the nearest and brightest a little bigger
  burst: [1.5, 2],   // the four-point bursts, as a few bigger squares
  core: 1.5,         // a little galaxy's glowing core, as one
  light: 1.6,        // each star this much brighter (at most 1): a square is a soft star's core alone, without its glow
  twinkle: 0.5,      // of the soft sky's twinkle: a gentle shimmer, as imperfect's dust has
});
// The hyperdrive: how fast (of full speed) before its streaks have fully taken over from the resting field.
export const WARP_IN = 0.6;

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
uniform float uWarpSpeed; // opt-in hyperdrive: its speed; 0 is none
uniform vec4 uLens; uniform float uLensScale; // opt-in: the sky round uLens.xy drawn at uLens.zw (CSS px), uLensScale times its size; 0 is none
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
  if (uLensScale > 0.0) {
    vec2 o = vec2((gl_Position.x / gl_Position.w + 1.0) * 0.5 * uViewport.x, (1.0 - gl_Position.y / gl_Position.w) * 0.5 * uViewport.y);
    o = uLens.zw + (o - uLens.xy) * uLensScale;
    gl_Position.xy = vec2(o.x / uViewport.x * 2.0 - 1.0, 1.0 - o.y / uViewport.y * 2.0) * gl_Position.w;
  }
  float s = 0.5 + 0.5 * sin(uTime * twinkle.y + twinkle.x);
  float tw = twinkle.y > 0.0 ? 1.0 - uTwinkle * s : 1.0;
  vAlpha = alpha * tw * uOpacity * near; vKind = kind;
  if (uWarpSpeed > 0.0) vAlpha *= 1.0 - smoothstep(0.0, ${WARP_IN.toFixed(2)}, uWarpSpeed); // the hyperdrive's streaks take over
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

// The twist as VERT has it, for the pixel sky and the hyperdrive's streaks: p turned about the first screen's centre
// at the rate of its home (orbit, measured from anchor).
const TWISTED = `
uniform float uTwist; uniform vec4 uRotation; uniform vec3 uSpan; uniform vec2 uViewport;
vec3 twisted(vec3 p, vec3 orbit, vec2 anchor) {
  if (uTwist == 0.0) return p;
  float k = 1.0 - p.z / uSpan.y;
  vec2 centre = vec2(uViewport.x, -uViewport.y) * 0.5;
  float r = length((anchor - centre) / (uViewport * 0.5 * (1.0 - orbit.z / uSpan.y)));
  float angle = uTwist * (uRotation.x + (uRotation.y - uRotation.x) * min(r, uRotation.z)) * (1.0 - smoothstep(uRotation.z, uRotation.w, r));
  float c = cos(angle), s = sin(angle);
  vec2 scale = uViewport * 0.5 * k; // the turn is in screen units, as VERT has it
  return vec3(centre + mat2(c, s, -s, c) * ((p.xy - centre) / scale) * scale, p.z);
}`;
// The pixel sky: each star a square of whole device pixels, on the device pixel grid, so it is crisp at any DPR. It
// keeps the twist, the twinkle (gentler), the lens and the hyperdrive's hand-over; nothing else.
const PIXEL_VERT = `
attribute float size; attribute float alpha; attribute vec2 twinkle; attribute vec3 orbit; attribute vec2 anchor;
uniform float uTime, uPixelRatio, uTwinkle, uOpacity, uWarpSpeed;
uniform vec4 uLens; uniform float uLensScale;
varying float vAlpha;
${TWISTED}
void main() {
  vec4 c = projectionMatrix * modelViewMatrix * vec4(twisted(position, orbit, anchor), 1.0);
  vec2 o = vec2(c.x / c.w + 1.0, 1.0 - c.y / c.w) * 0.5 * uViewport; // CSS px, y down
  if (uLensScale > 0.0) o = uLens.zw + (o - uLens.xy) * uLensScale;
  float n = max(1.0, floor(size * uPixelRatio + 0.5)), dp = uPixelRatio;
  vec2 px = floor(o * dp - 0.5 * n + 0.5) + 0.5 * n; // its n x n device pixels
  gl_Position = vec4(px.x / (uViewport.x * dp) * 2.0 - 1.0, 1.0 - px.y / (uViewport.y * dp) * 2.0, 0.0, 1.0);
  gl_PointSize = n;
  float s = 0.5 + 0.5 * sin(uTime * twinkle.y + twinkle.x);
  vAlpha = alpha * uOpacity * (twinkle.y > 0.0 ? 1.0 - ${PIXELS.twinkle.toFixed(2)} * uTwinkle * s : 1.0);
  if (uWarpSpeed > 0.0) vAlpha *= 1.0 - smoothstep(0.0, ${WARP_IN.toFixed(2)}, uWarpSpeed); // the hyperdrive's streaks take over
}`;
const PIXEL_FRAG = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  if (vAlpha < 0.003) discard;
  gl_FragColor = vec4(uColor * vAlpha, vAlpha);
}`;
// The hyperdrive's streaks: one quad per star (position: x 0 at the tail .. 1 at the star, y -1..1 across). Each star
// flies from FAR to NEAR again and again, phase its own place in that flight, drawn at its resting place x BORN / its
// depth: from halfway out (at FAR) through where it rests (at BORN) and on past the screen's edge. Its streak runs from
// where it was a moment ago to where it is. A little galaxy's dots share one line, so they are dimmer, not a beam.
const STREAK_VERT = `
attribute vec3 orbit; attribute vec2 anchor; attribute float size; attribute float alpha; attribute float phase;
uniform float uPixelRatio, uOpacity, uWarp, uWarpSpeed, uCrisp;
varying float vAlpha; varying float vAlong; varying float vAcross; varying float vTrail;
const float NEAR = 0.15, FAR = 7.05, BORN = 3.5, TRAIL = 0.35; // depths in camera distances; TRAIL: how far back a streak reaches
${TWISTED}
void main() {
  vec4 c = projectionMatrix * modelViewMatrix * vec4(twisted(orbit, orbit, anchor), 1.0);
  vec2 edge = 0.5 * uViewport * uPixelRatio;            // device px, the middle to the edge
  vec2 home = c.xy / c.w * edge;                        // where it rests, device px from the middle
  float f = NEAR + (FAR - NEAR) * fract(phase - uWarp); // where it is in its flight
  vec2 head = home * (BORN / f), tail = home * (BORN / min(f + TRAIL * uWarpSpeed, FAR));
  float w = uCrisp > 0.5 ? max(1.0, floor(size * uPixelRatio + 0.5)) : clamp(size, 1.0, 2.6) * uPixelRatio;
  vec2 d = head - tail; float len = length(d);
  vec2 dir = len > 0.001 ? d / len : vec2(1.0, 0.0);
  // half a width past each end, so a star that has hardly moved yet is its own square
  vec2 at = mix(tail, head, position.x) + (dir * (position.x * 2.0 - 1.0) + vec2(-dir.y, dir.x) * position.y) * 0.5 * w;
  gl_Position = vec4(at / edge, 0.0, 1.0);
  vAlong = position.x; vAcross = position.y; vTrail = len / (len + w);
  vAlpha = alpha * uOpacity * smoothstep(0.0, ${WARP_IN.toFixed(2)}, uWarpSpeed)
    * smoothstep(NEAR, NEAR + 0.4, f) * (1.0 - smoothstep(FAR - 0.6, FAR, f)) // in at the far end, out before the camera
    * mix(0.5, 1.0, smoothstep(0.1, 0.45, length(head) / length(edge)))      // dimmer across the middle, where the film's words are
    * (anchor == orbit.xy ? 1.0 : 0.35);
  if (vAlpha < 0.003 || abs(tail.x) > edge.x + w || abs(tail.y) > edge.y + w) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // nothing to draw
}`;
const STREAK_FRAG = `
uniform vec3 uColor; uniform float uCrisp;
varying float vAlpha; varying float vAlong; varying float vAcross; varying float vTrail;
void main() {
  float a = vAlpha * (1.0 - vTrail * (0.85 - 0.85 * vAlong * vAlong)); // brightest at the star, fading back along its way
  if (uCrisp < 0.5) a *= 1.0 - smoothstep(0.3, 1.0, abs(vAcross));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, a);
}`;

// The field: build once (counts fixed for the visit), place() again on every resize. pixels: the launch page's pixel sky
// (true, or its options: { clusters: false }).
export function createStars({ width, height, pixels = false } = {}) {
  const clusters = pixels?.clusters !== false;
  pixels = Boolean(pixels);
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
  // Without the clusters: each little galaxy (its core and its dots) taken out after the whole field is drawn from the
  // seed, so every other star keeps its place, size, brightness and twinkle, in the same order.
  if (!clusters) {
    let j = 0;
    for (let i = 0; i < u.length; i++) {
      if (kind[i] === 2 || cores[i] !== undefined) continue;
      u[j] = u[i]; v[j] = v[i]; d[j] = d[i]; ox[j] = ox[i]; oy[j] = oy[i]; size[j] = size[i]; alpha[j] = alpha[i]; kind[j] = kind[i];
      tw[2 * j] = tw[2 * i]; tw[2 * j + 1] = tw[2 * i + 1]; j++;
    }
    for (const list of [u, v, d, ox, oy, size, alpha, kind]) list.length = j;
    tw.length = 2 * j;
    for (const i in cores) delete cores[i];
  }

  const n = u.length;
  if (pixels) { // the same stars, as small squares: sizes in CSS px of a square (blackhole/ drives these like any other)
    const P = PIXELS;
    for (let i = 0; i < n; i++) {
      size[i] = kind[i] === 0 ? P.size[0] + P.size[1] * size[i] : kind[i] === 1 ? lerp(P.burst, (size[i] - B.size[0]) / (B.size[1] - B.size[0])) : P.core;
      alpha[i] = Math.min(1, alpha[i] * P.light);
    }
  }
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
    vertexShader: pixels ? PIXEL_VERT : VERT, fragmentShader: pixels ? PIXEL_FRAG : FRAG, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uTwinkle: { value: C.twinkle.amount }, uOpacity: { value: 1 }, uFlow: { value: 0 }, uTwist: { value: 0 }, uRotation: { value: new THREE.Vector4(...RATE) }, uAvoid: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uAvoidCount: { value: 0 }, uCaret: { value: new THREE.Vector3() }, uKick: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uWarp: { value: 0 }, uWarpSpeed: { value: 0 }, uLens: { value: new THREE.Vector4() }, uLensScale: { value: 0 }, uViewport: { value: new THREE.Vector2(1, 1) }, uSpan: { value: new THREE.Vector3(1, 1, m) }, uColor: { value: new THREE.Color(...C.color) } },
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1000;
  // The hyperdrive's streaks, built the first time warp() is asked to fly: one quad per star, drawn over the field
  // (a child of points, so whatever draws the field draws them), sharing its resting arrays and its uniforms.
  let streaks = null;
  function createStreaks() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) phase[i] = (i * 0.6180339887498949) % 1; // evenly through the flight, whatever the order
    for (const [name, array, k] of [['orbit', orbit, 3], ['anchor', anchor, 2], ['size', field.base.size, 1], ['alpha', field.base.alpha, 1], ['phase', phase, 1]]) g.setAttribute(name, new THREE.InstancedBufferAttribute(array, k));
    g.instanceCount = n;
    const U = material.uniforms, shared = ['uPixelRatio', 'uOpacity', 'uTwist', 'uRotation', 'uSpan', 'uViewport', 'uWarp', 'uWarpSpeed', 'uColor'];
    const look = new THREE.ShaderMaterial({
      vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { ...Object.fromEntries(shared.map(name => [name, U[name]])), uCrisp: { value: pixels ? 1 : 0 } },
    });
    const mesh = new THREE.Mesh(g, look);
    mesh.frustumCulled = false; mesh.renderOrder = -999;
    points.add(mesh);
    return mesh;
  }

  const field = {
    points, geometry, material, count: n, pixels,
    get streaks() { return streaks; },
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
      if (streaks) streaks.geometry.attributes.orbit.needsUpdate = streaks.geometry.attributes.anchor.needsUpdate = true;
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
    // lens (opt-in): draw the sky round the screen point `from` at `to` (CSS px), `scale` times its size: a window onto
    // more of another part of the sky (the launch page's bubble before it opens). lens() or never calling it leaves
    // the sky as it is.
    lens(from = null, to = null, scale = 1) {
      const U = material.uniforms, on = from && to && [...from, ...to, scale].every(Number.isFinite) && scale > 0;
      U.uLens.value.set(...(on ? [from[0], from[1], to[0], to[1]] : [0, 0, 0, 0])); U.uLensScale.value = on ? scale : 0;
    },
    warp(distance = 0, speed = 0) {
      const U = material.uniforms, on = speed > 0 && Number.isFinite(speed) && Number.isFinite(distance);
      U.uWarpSpeed.value = on ? speed : 0;
      U.uWarp.value = on ? distance - Math.floor(distance) : 0;
      if (on && !streaks) streaks = createStreaks();
      if (streaks) streaks.visible = on;
    },
  };
  return field;
}
