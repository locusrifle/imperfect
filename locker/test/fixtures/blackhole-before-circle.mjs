// website/blackhole/blackhole.mjs as live HEAD has it (last changed in 4f4c87d0; these two lines added), so the tests
// can show that the black hole without the circle opt-out (the lock's, and the soft sky's) is exactly as it was. Do not edit.
// The black hole, for the site's one field of stars. A ring of stars forms
// around the centre, starts to spin, swallows every other star along curved
// paths, swells, collapses to a point that flickers, and explodes everything
// back out to where it was. After the `blackhole` effect in
// terminaltexteffects (MIT, Chris Builds) that Omarchy's screensaver runs
// through ttfx, translated from terminal cells to stars in world space.
//
// createBlackHole drives the star field's own arrays (positions, sizes,
// alphas) in place and allocates nothing per frame; after each update the
// caller flags them for upload when info.dirty is set. It knows nothing of
// the renderer. While it runs nothing else may write those arrays (keep
// twinkle in the shader); when it is done they hold exactly what they held
// before it started.
//
// createHoleVisuals() is an optional dark disc, accretion glow and flash,
// built with the THREE it is handed.

const TAU = Math.PI * 2;
const PRE = 0.035;   // how far the field leans in while the ring spins up
const TWIST = 0.05;  // and how far it turns (radians)
const SPIN_OUT = 0.6; // radians the burst unwinds as it leaves the centre

export const DEFAULTS = Object.freeze({
  ring: 1.5,          // ring stars fly to the circle, one after another
  spin: 0.8,          // the ring starts to turn
  consume: 2.5,       // the rest spiral in; the ring keeps turning faster
  expand: 0.55,       // the ring swells
  shrink: 0.55,       // it collapses to a point (phase 'shrink')
  pulse: 0.45,        // the point flickers (still phase 'shrink')
  explode: 2.0,       // everything bursts out and settles home
  fade: 1.2,          // reduced motion: the whole thing
  spinSpeed: 0.8,     // turns per second the ring reaches by the end of consume
  swirl: 0.3,         // turns a swallowed star winds on its way in
  expandScale: 1.35,  // the ring's radius at the top of the swell
  ringCount: 0,       // stars in the ring; 0 picks from the count
  ringSize: 0,        // their size; 0 picks from the field's sizes
  seed: 7,
  reducedMotion: false,
  start: 'ring',      // 'explode': skip straight to the burst, every star leaving the centre at once
  unwind: true,       // the lock opts out: sky.mjs supplies its one steady angular motion
  ringNear: 0,        // opt-in (the launch page's bubble): the ring's stars are picked from this many nearest the
                      // hole as seen, so it forms from the stars around it; 0 picks from the whole field
});

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const inQuad = x => x * x;
const inCubic = x => x * x * x;
const outCubic = x => 1 - (1 - x) * (1 - x) * (1 - x);
const inOutSine = x => 0.5 - 0.5 * Math.cos(Math.PI * x);
const inOutCubic = x => (x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2);
const outExpo = x => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// createBlackHole({ positions, sizes, alphas, count, center, radius, eye,
//   ...DEFAULTS }) → { update(dt) → info, info, phase, done, duration,
//   phases, ringCount, stop() }
// positions (xyz), sizes and alphas are the star field's Float32Arrays;
// center {x,y,z} and radius are in world units; the ring lies in the XY
// plane through the centre. eye (the camera's position, looking down -z)
// is optional and orders the swallowing by distance on screen. info is
// one object, updated in place: { phase, progress, time, total, flash,
// glow, disc, dim, center, radius, ringRadius, horizon, angle, swirl,
// dirty }. Phases: ring, spin, consume, expand, shrink, explode, done
// (reduced motion: fade, done). dt is clamped to 0.1 s. start: 'explode'
// plays only the last phase: the stars burst out of the centre (where
// update(0) gathers them) and settle where they live.
export function createBlackHole(options) {
  const o = { ...DEFAULTS, ...options };
  const { positions, sizes, alphas } = o;
  const count = Math.max(0, Math.min(o.count ?? positions.length / 3, positions.length / 3, sizes.length, alphas.length) | 0);
  const cx = o.center?.x ?? 0, cy = o.center?.y ?? 0, cz = o.center?.z ?? 0;
  const R = o.radius ?? 1;
  const random = mulberry32(o.seed);

  // Where every star lives, to come back to.
  const home = positions.slice(0, count * 3);
  const baseSize = sizes.slice(0, count);
  const baseAlpha = alphas.slice(0, count);
  const r0 = new Float32Array(count), a0 = new Float32Array(count), z0 = new Float32Array(count);
  // How far from the hole each star looks: on screen, measured at the
  // hole's depth, when the camera (eye, looking down -z) is given; else in
  // the world. The stars that look nearest go first, as in ttfx.
  const seen = new Float32Array(count);
  const eye = o.eye, depthC = eye ? eye.z - cz : 0;
  let sizeSum = 0, sizeMax = 0;
  for (let i = 0; i < count; i++) {
    const dx = home[i * 3] - cx, dy = home[i * 3 + 1] - cy;
    r0[i] = Math.hypot(dx, dy);
    a0[i] = Math.atan2(dy, dx);
    z0[i] = home[i * 3 + 2] - cz;
    if (eye && depthC > 0) {
      const depth = eye.z - home[i * 3 + 2];
      const k = depthC / Math.max(depth, 1e-3);
      seen[i] = depth > 0 ? Math.hypot((home[i * 3] - eye.x) * k - (cx - eye.x), (home[i * 3 + 1] - eye.y) * k - (cy - eye.y)) : Infinity;
    } else seen[i] = r0[i];
    sizeSum += baseSize[i];
    if (baseSize[i] > sizeMax) sizeMax = baseSize[i];
  }
  const far = Math.max(1e-6, seen.slice().sort()[Math.floor(count * 0.97)] ?? 1); // ignore the odd outlier

  // The ring: random stars, each given a place on the circle, a little
  // uneven so a fast spin reads as a swirl, not a strobing dotted line.
  const M = Math.min(o.ringCount > 0 ? o.ringCount | 0 : Math.max(36, Math.min(96, Math.round(count * 0.024))), count >> 1);
  const ringSize = o.ringSize > 0 ? o.ringSize : Math.min(sizeMax, (sizeSum / Math.max(1, count)) * 2.5);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const pool = o.ringNear > 0 ? Math.min(count, Math.max(M, o.ringNear | 0)) : count;
  if (pool < count) order.sort((a, b) => seen[a] - seen[b]);
  for (let i = 0; i < M; i++) {
    const j = i + Math.floor(random() * (pool - i));
    const swap = order[i]; order[i] = order[j]; order[j] = swap;
  }
  const ringIdx = order.slice(0, M);
  const isRing = new Uint8Array(count);
  const slotA = new Float32Array(M), slotR = new Float32Array(M), slotZ = new Float32Array(M);
  const launch = new Float32Array(M), collapseRate = new Float32Array(M);
  const travel = Math.max(1e-6, Math.min(0.75, o.ring * 0.5));
  const collapse = Math.max(1e-6, o.shrink), pulse = Math.max(1e-6, o.pulse);
  for (let k = 0; k < M; k++) {
    isRing[ringIdx[k]] = 1;
    slotA[k] = Math.PI / 2 + (TAU * (k + (random() - 0.5) * 0.7)) / M;
    slotR[k] = 1 + (random() - 0.5) * 0.05;
    slotZ[k] = (random() - 0.5) * 0.04 * R;
    launch[k] = (k / M) * Math.max(0, o.ring - travel);
    collapseRate[k] = 1 + random() * 0.25;
  }

  // Each star's way in and way out.
  const cStart = new Float32Array(count), cDur = new Float32Array(count), cSwirl = new Float32Array(count);
  const xBurst = new Float32Array(count), xOver = new Float32Array(count), xJit = new Float32Array(count);
  const xSize = new Float32Array(count), xFreq = new Float32Array(count), xPhase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const q = seen[i] >= far ? 1 : (seen[i] / far) ** 0.7;
    cStart[i] = random() * 0.12 * o.consume;
    cDur[i] = (o.consume - cStart[i]) * (0.45 + 0.55 * q) * (0.85 + 0.15 * random());
    cSwirl[i] = o.swirl * TAU * (0.75 + 0.5 * random());
    xBurst[i] = 0.3 + 0.3 * random();
    xOver[i] = 0.03 + 0.12 * random();
    xJit[i] = (random() - 0.5) * 0.18;
    xSize[i] = 0.3 + 1.4 * random() * random();
    xFreq[i] = 7 + 14 * random();
    xPhase[i] = random() * TAU;
  }

  const burstOnly = o.start === 'explode' && !o.reducedMotion;
  const names = o.reducedMotion ? ['fade'] : burstOnly ? ['explode'] : ['ring', 'spin', 'consume', 'expand', 'shrink', 'explode'];
  const durations = o.reducedMotion ? [o.fade] : burstOnly ? [o.explode] : [o.ring, o.spin, o.consume, o.expand, o.shrink + o.pulse, o.explode];
  const phases = [];
  let total = 0;
  for (let i = 0; i < names.length; i++) {
    phases.push(Object.freeze({ name: names[i], start: total, duration: durations[i] }));
    total += durations[i];
  }

  const info = {
    phase: names[0], progress: 0, time: 0, total,
    flash: 0, glow: 0, disc: 0, dim: 1,
    center: { x: cx, y: cy, z: cz }, radius: R,
    ringRadius: R, horizon: 0, angle: 0, swirl: o.swirl * TAU,
    dirty: false,
  };
  let index = 0, entered = -1, finished = false;

  const put = (i, r, a, z, size, alpha) => {
    positions[i * 3] = cx + r * Math.cos(a);
    positions[i * 3 + 1] = cy + r * Math.sin(a);
    positions[i * 3 + 2] = cz + z;
    sizes[i] = size;
    alphas[i] = alpha;
  };
  const restore = () => {
    for (let i = 0; i < count * 3; i++) positions[i] = home[i];
    for (let i = 0; i < count; i++) { sizes[i] = baseSize[i]; alphas[i] = baseAlpha[i]; }
  };
  const swallowed = i => put(i, 0, 0, 0, 0, 0);

  // The frame's numbers live in a typed array, and the phases below take no
  // arguments, so no number is ever boxed: nothing is allocated per frame.
  const T = 0, ANGLE = 1, LOCAL = 2, P = 3, RING_R = 4, HORIZON = 5, SWELL = 6;
  const S = new Float64Array(7);

  // ring: one star after another flies to its place on the circle.
  function forming() {
    const local = S[LOCAL];
    for (let k = 0; k < M; k++) {
      const e = inOutSine(clamp01((local - launch[k]) / travel));
      if (e <= 0) continue;
      const i = ringIdx[k];
      const hx = home[i * 3], hy = home[i * 3 + 1], hz = home[i * 3 + 2];
      const sx = cx + R * slotR[k] * Math.cos(slotA[k]), sy = cy + R * slotR[k] * Math.sin(slotA[k]), sz = cz + slotZ[k];
      const bend = 0.12 * Math.sin(Math.PI * e); // a slight arc, the way the ring will turn
      positions[i * 3] = lerp(hx, sx, e) - (sy - hy) * bend;
      positions[i * 3 + 1] = lerp(hy, sy, e) + (sx - hx) * bend;
      positions[i * 3 + 2] = lerp(hz, sz, e);
      sizes[i] = lerp(baseSize[i], ringSize, e);
      alphas[i] = lerp(baseAlpha[i], 1, e);
    }
  }
  // spin, consume, expand: the ring on its turning circle.
  function circling() {
    const angle = S[ANGLE], ringR = S[RING_R], swell = S[SWELL];
    for (let k = 0; k < M; k++) put(ringIdx[k], ringR * slotR[k], slotA[k] + angle, slotZ[k], ringSize * swell, 1);
  }
  // spin: the rest of the field leans in a little.
  function leaning() {
    const e = inQuad(S[P]);
    for (let i = 0; i < count; i++) if (!isRing[i]) put(i, r0[i] * (1 - PRE * e), a0[i] + TWIST * e, z0[i] * (1 - PRE * e), baseSize[i], baseAlpha[i]);
  }
  // consume: every other star spirals in, brightening, then smaller as it
  // nears the hole and gone at the horizon; one that starts that close
  // shrinks and fades only once it moves.
  function swallowing() {
    const local = S[LOCAL], hz = Math.max(S[HORIZON], 1e-6);
    for (let i = 0; i < count; i++) {
      if (isRing[i]) continue;
      const u = clamp01((local - cStart[i]) / cDur[i]);
      if (u >= 1) { swallowed(i); continue; }
      const e = inCubic(u);
      const r = r0[i] * (1 - PRE) * (1 - e);
      const bright = smooth(0, 0.45, e);
      const moving = smooth(0, 0.3, e);
      const fade = 1 - (1 - smooth(0.25 * hz, hz, r)) * moving;
      const shrink = 1 - 0.7 * (1 - smooth(0.2 * hz, 2 * hz, r)) * moving;
      put(i, r, a0[i] + TWIST + cSwirl[i] * e ** 1.3, z0[i] * (1 - PRE) * (1 - e),
        baseSize[i] * (1 + 0.7 * bright) * shrink,
        lerp(baseAlpha[i], 1, bright) * fade);
    }
  }
  function swallowAll() { for (let i = 0; i < count; i++) if (!isRing[i]) swallowed(i); }
  // shrink: the ring falls in, then one point is left, flickering three
  // times (◦ ◎ ◉ ● ◉ ◎ ◦ in ttfx).
  function collapsing() {
    const local = S[LOCAL], angle = S[ANGLE];
    if (local < collapse) {
      const pc = local / collapse;
      for (let k = 0; k < M; k++) {
        const e = inCubic(clamp01(pc * collapseRate[k]));
        put(ringIdx[k], R * o.expandScale * slotR[k] * (1 - e), slotA[k] + angle, slotZ[k] * (1 - e), ringSize * (1.25 - 0.45 * e), 1);
      }
      return;
    }
    const h = clamp01((local - collapse) / pulse);
    const beat = 0.5 - 0.5 * Math.cos(TAU * 3 * h);
    put(ringIdx[0], 0, 0, 0, ringSize * (1.1 + (1.6 + 1.2 * h) * beat), 1);
    for (let k = 1; k < M; k++) swallowed(ringIdx[k]);
  }
  // explode: everything bursts out past where it lived, unwinding, hot and
  // twinkling, then settles home.
  function exploding() {
    const local = S[LOCAL], p = S[P], E = phases[index].duration;
    const heat = 1 - p, heat2 = heat * heat, tw = heat ** 1.5 * 0.5;
    for (let i = 0; i < count; i++) {
      const b = xBurst[i] * E;
      const eb = outExpo(clamp01(local / b));
      const es = inOutCubic(clamp01((local - b) / (E - b)));
      const rn = r0[i] * (1 + xOver[i]) + R * 0.04, an = a0[i] + xJit[i], zn = z0[i] * (1 + xOver[i]);
      put(i,
        lerp(rn * eb, r0[i], es),
        o.unwind ? lerp(an - SPIN_OUT * (1 - eb), a0[i], es) : a0[i],
        lerp(zn * eb, z0[i], es),
        baseSize[i] * (1 + heat2 * xSize[i]),
        Math.min(1, baseAlpha[i] + heat2 * 0.6) * (1 - tw * (0.5 + 0.5 * Math.sin(local * xFreq[i] + xPhase[i]))));
    }
  }
  // fade (reduced motion): the field dims and comes back where it is.
  function dimming() {
    const dim = info.dim;
    for (let i = 0; i < count; i++) alphas[i] = baseAlpha[i] * dim;
  }

  function update(dt) {
    if (finished) { info.dirty = false; return info; }
    dt = Math.min(Math.max(+dt || 0, 0), 0.1);
    const t = (S[T] += dt);
    while (index < phases.length && t >= phases[index].start + phases[index].duration) index++;
    if (index >= phases.length) {
      restore();
      finished = true;
      info.phase = 'done'; info.progress = 1; info.time = total;
      info.flash = 0; info.glow = 0; info.disc = 0; info.dim = 1; info.horizon = 0; info.ringRadius = 0;
      info.dirty = true;
      return info;
    }
    const name = phases[index].name;
    const local = t - phases[index].start;
    const p = clamp01(local / phases[index].duration);
    const first = entered !== index;
    entered = index;

    // The ring's size, the hole's, how bright things burn, and how fast the
    // ring turns (turns per second: still while it forms, then speeding up).
    const w = o.spinSpeed;
    let ringR = R, horizon = 0.5 * R, glow = 0, disc = 0, flash = 0, dim = 1, turns = 0;
    if (name === 'ring') { glow = 0.12 * smooth(0.5, 1, p); horizon = 0; }
    else if (name === 'spin') { glow = lerp(0.12, 0.6, smooth(0, 1, p)); disc = smooth(0, 1, p); horizon = 0.5 * R * outCubic(p); turns = w * 0.4 * inQuad(p); }
    else if (name === 'consume') { glow = 0.6 + 0.4 * smooth(0, 0.6, p); disc = 1; turns = w * lerp(0.4, 1, p); }
    else if (name === 'expand') { ringR = R * lerp(1, o.expandScale, inOutCubic(p)); glow = 1 + 0.35 * inOutCubic(p); disc = 1; horizon = 0.5 * ringR; turns = w * lerp(1, 1.5, p); }
    else if (name === 'shrink') {
      const pc = clamp01(local / collapse);
      ringR = R * o.expandScale * (1 - inCubic(pc));
      horizon = 0.5 * ringR;
      glow = 1.35 * (1 - smooth(0.6, 1, pc));
      disc = 1 - smooth(0.7, 1, pc);
      turns = w * 1.5 * Math.min(6, (R * o.expandScale) / Math.max(ringR, 1e-6)); // faster as it falls in
      if (local < collapse) flash = 0.9 * inCubic(pc) ** 2;
      else {
        const h = clamp01((local - collapse) / pulse);
        flash = 0.25 + 0.35 * (0.5 - 0.5 * Math.cos(TAU * 3 * h)) + 0.65 * Math.exp(-(local - collapse) / 0.08);
      }
    } else if (name === 'explode') { ringR = 0; horizon = 0; flash = Math.exp(-local / 0.2); }
    else if (name === 'fade') { const s = Math.sin(Math.PI * p); dim = 1 - 0.8 * s; flash = 0.4 * s * s; ringR = 0; horizon = 0; }
    S[ANGLE] += turns * TAU * dt;
    S[LOCAL] = local; S[P] = p; S[RING_R] = ringR; S[HORIZON] = horizon;
    S[SWELL] = name === 'expand' ? 1 + 0.25 * inOutCubic(p) : 1;
    info.phase = name; info.progress = p; info.time = t;
    info.flash = flash; info.glow = glow; info.disc = disc; info.dim = dim;
    info.ringRadius = ringR; info.horizon = horizon; info.angle = S[ANGLE];
    info.dirty = true;

    if (name === 'ring') forming();
    else if (name === 'spin') { leaning(); circling(); }
    else if (name === 'consume') { swallowing(); circling(); }
    else if (name === 'expand') { if (first) swallowAll(); circling(); }
    else if (name === 'shrink') { if (first) swallowAll(); collapsing(); }
    else if (name === 'explode') exploding();
    else dimming();
    return info;
  }

  return {
    update,
    info,
    phases,
    duration: total,
    ringCount: M,
    get phase() { return info.phase; },
    get done() { return finished; },
    // Put every star back where it was and finish now.
    stop() {
      if (finished) return;
      restore();
      finished = true;
      info.phase = 'done'; info.progress = 1; info.flash = 0; info.glow = 0; info.disc = 0; info.dim = 1;
      info.dirty = true;
    },
  };
}

// The hole itself, for a Three.js scene: a dark disc, a faint accretion glow
// that turns with the ring, and the flash. Flat in the XY plane at the
// centre, like the ring. Add `object` to the scene and call update(info)
// each frame after the black hole's update. Draws after the stars
// (renderOrder) so the disc hides what is behind it.
export function createHoleVisuals(THREE, { center, renderOrder = 2 } = {}) {
  const object = new THREE.Group();
  object.position.set(center?.x ?? 0, center?.y ?? 0, center?.z ?? 0);
  const plane = new THREE.PlaneGeometry(2, 2);
  const vertexShader = 'varying vec2 vP; void main() { vP = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const layer = (fragmentShader, uniforms, blending, order) => {
    const mesh = new THREE.Mesh(plane, new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader, blending, transparent: true, depthWrite: false,
    }));
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.visible = false;
    object.add(mesh);
    return mesh;
  };
  // The disc reaches |p| = 1 / 1.5 of its plane, with a soft edge.
  const disc = layer(`
    uniform float uOpacity; varying vec2 vP;
    void main() {
      float d = length(vP);
      gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity * (1.0 - smoothstep(0.58, 0.68, d)));
    }`, { uOpacity: { value: 0 } }, THREE.NormalBlending, renderOrder);
  // The glow plane is 1.8 ring radii across each way; r is in ring radii.
  const glow = layer(`
    uniform float uGlow, uAngle, uHorizon; varying vec2 vP;
    void main() {
      float r = length(vP) * 1.8;
      float a = atan(vP.y, vP.x);
      float band = exp(-pow((r - 1.0) / 0.24, 2.0));
      float edge = exp(-pow((r - uHorizon) / 0.05, 2.0)) * step(0.01, uHorizon);
      float s = a - uAngle - r * 2.4;
      float streak = 0.55 + 0.45 * sin(s * 5.0) * sin(s * 3.0 + 1.7);
      float g = (band * 0.5 * streak + edge * 0.7 + exp(-r * r * 1.5) * 0.06) * uGlow;
      vec3 col = mix(vec3(1.0), vec3(1.0, 0.886, 0.549), clamp(0.5 * edge + 0.2 * band, 0.0, 1.0));
      gl_FragColor = vec4(col * g * 0.3 * (1.0 - smoothstep(0.85, 1.0, length(vP))), 1.0);
    }`, { uGlow: { value: 0 }, uAngle: { value: 0 }, uHorizon: { value: 0.5 } }, THREE.AdditiveBlending, renderOrder + 1);
  const flash = layer(`
    uniform float uFlash; varying vec2 vP;
    void main() {
      float d2 = dot(vP, vP);
      float g = (exp(-d2 * 30.0) + exp(-d2 * 6.0) * 0.35) * (1.0 - smoothstep(0.7, 1.0, sqrt(d2)));
      vec3 col = mix(vec3(1.0), vec3(1.0, 0.886, 0.549), 0.45 * (1.0 - clamp(d2 * 4.0, 0.0, 1.0)));
      gl_FragColor = vec4(col * g * uFlash, 1.0);
    }`, { uFlash: { value: 0 } }, THREE.AdditiveBlending, renderOrder + 2);

  return {
    object,
    update(info) {
      const R = info.radius;
      disc.visible = info.disc > 0.001 && info.horizon > 0;
      if (disc.visible) {
        disc.material.uniforms.uOpacity.value = info.disc;
        disc.scale.setScalar(info.horizon * 1.5);
      }
      glow.visible = info.glow > 0.001 && info.ringRadius > 0.001;
      if (glow.visible) {
        glow.material.uniforms.uGlow.value = info.glow;
        glow.material.uniforms.uAngle.value = info.angle;
        glow.material.uniforms.uHorizon.value = info.horizon / info.ringRadius;
        glow.scale.setScalar(info.ringRadius * 1.8);
      }
      flash.visible = info.flash > 0.002;
      if (flash.visible) {
        flash.material.uniforms.uFlash.value = info.flash;
        flash.scale.setScalar(R * (0.6 + 2.6 * info.flash));
      }
    },
    dispose() {
      plane.dispose();
      for (const mesh of [disc, glow, flash]) mesh.material.dispose();
    },
  };
}
