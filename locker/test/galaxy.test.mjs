// The launch page's galaxy (galaxy.patch): the pixel sky is opt-in and the same stars, the default sky (the lock's,
// the OS's) is the field it was, the hyperdrive is its own opt-in layer, the film's clock is smoothed only while it
// plays, and the pixel sky's bubble has no ring (the black hole's circle is opt-out, the lock's is as it was). The drawn pixels are checked in galaxy-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStars, PIXELS, STARS } from '../../website/stars.mjs';
import { createStars as createBefore } from './fixtures/stars-before-pixels.mjs';
import { pixelRatioOf, PIXEL_BUDGET } from '../../website/scene.mjs';
import { pixelRatioFor, distanceFor } from '../../website/sky.mjs';
import { warpTable } from '../../website/film.mjs';
import { contactBurst, revealAt } from '../../website/reveal.mjs';
import { createBlackHole } from '../../website/blackhole/blackhole.mjs';
import { createBlackHole as holeBefore } from './fixtures/blackhole-before-circle.mjs';
import { BURST } from '../../website/bootup.mjs';

const read = name => readFile(new URL(`../../website/${name}`, import.meta.url), 'utf8');
const SCREENS = [[1024, 640], [390, 844], [1440, 900], [1920, 1080]];

test('the default field (the lock\'s, the OS\'s) is star for star the one live HEAD builds', () => {
  for (const [w, h] of SCREENS) {
    const a = createStars({ width: w, height: h }), b = createBefore({ width: w, height: h }), D = distanceFor(h);
    a.place(w, h, D); b.place(w, h, D);
    assert.equal(a.count, b.count);
    for (const name of ['position', 'orbit', 'anchor', 'size', 'alpha', 'kind', 'twinkle']) assert.deepEqual(a.geometry.attributes[name].array, b.geometry.attributes[name].array, `${w}x${h} ${name}`);
    assert.equal(a.pixels, false); assert.equal(a.streaks, null, 'no hyperdrive layer unless one is flown');
    assert.equal(a.material.fragmentShader, b.material.fragmentShader.replace(/\n  if \(vStreak\.z > 0\.0\) \{[\s\S]*?\n  \}\n  else if/, '\n  if').replace('\nvarying vec4 vStreak; varying float vSprite;', ''), 'the soft stars\' own shader, only the old streak taken out');
  }
});

test('pixels: the same stars in the same places, as small squares, a little brighter; no soft glow in its shader', () => {
  for (const [w, h] of SCREENS) {
    const soft = createStars({ width: w, height: h }), px = createStars({ width: w, height: h, pixels: true }), D = distanceFor(h);
    soft.place(w, h, D); px.place(w, h, D);
    assert.equal(px.count, soft.count); assert.equal(px.pixels, true);
    for (const name of ['position', 'orbit', 'anchor', 'kind', 'twinkle']) assert.deepEqual(px.geometry.attributes[name].array, soft.geometry.attributes[name].array, name);
    const kind = soft.geometry.attributes.kind.array, s0 = soft.base.size, s1 = px.base.size, a0 = soft.base.alpha, a1 = px.base.alpha;
    for (let i = 0; i < px.count; i++) {
      const want = kind[i] === 0 ? PIXELS.size[0] + PIXELS.size[1] * s0[i] : kind[i] === 1 ? s1[i] : PIXELS.core;
      assert.ok(Math.abs(s1[i] - want) < 1e-6, `size ${i}`);
      if (kind[i] === 1) assert.ok(s1[i] >= PIXELS.burst[0] - 1e-6 && s1[i] <= PIXELS.burst[1] + 1e-6, 'a burst is a slightly bigger square');
      assert.ok(Math.abs(a1[i] - Math.min(1, a0[i] * PIXELS.light)) < 1e-6, `alpha ${i}`);
    }
    // whole device pixels: mostly 1-2 on a laptop (DPR 2), 2-3 on a phone (DPR 3), a few bigger
    const share = (dpr, from, to) => [...s1].filter(s => { const n = Math.max(1, Math.floor(s * dpr + 0.5)); return n >= from && n <= to; }).length / s1.length;
    assert.ok(share(2, 1, 2) > 0.97 && share(2, 1, 1) > 0.6, `${w}x${h}: DPR 2 squares mostly 1-2 px`);
    assert.ok(share(3, 2, 3) > 0.97, `${w}x${h}: DPR 3 squares mostly 2-3 px`);
    assert.ok(share(2, 3, 9) > 0, 'with a few bigger');
  }
  const px = createStars({ width: 1024, height: 640, pixels: true });
  assert.doesNotMatch(px.material.fragmentShader, /gl_PointCoord|exp\(|smoothstep/, 'a solid square: no round falloff, no glow, no four-point arms');
  assert.match(px.material.vertexShader, /floor\(size \* uPixelRatio \+ 0\.5\)/, 'a whole number of device pixels');
  assert.match(px.material.vertexShader, /float angle = uTwist \* \(uRotation\.x \+ \(uRotation\.y - uRotation\.x\) \* min\(r, uRotation\.z\)\) \* \(1\.0 - smoothstep\(uRotation\.z, uRotation\.w, r\)\);/, 'the same twist law');
  assert.match(px.material.vertexShader, /if \(uLensScale > 0\.0\) o = uLens\.zw \+ \(o - uLens\.xy\) \* uLensScale;/, 'the bubble\'s lens');
  assert.ok(STARS.twinkle.amount * PIXELS.twinkle <= 0.3, 'a gentle twinkle');
});

test('the hyperdrive is its own layer, built only when flown, and gone at speed 0', () => {
  const f = createStars({ width: 1024, height: 640, pixels: true }); f.place(1024, 640, distanceFor(640));
  f.warp(0.3, 0); assert.equal(f.streaks, null);
  f.warp(NaN, 1); assert.equal(f.streaks, null);
  f.warp(2.3, 1);
  assert.ok(f.streaks && f.streaks.visible && f.streaks.parent === f.points, 'a child of the field: whatever draws the field draws it');
  assert.ok(Math.abs(f.material.uniforms.uWarp.value - 0.3) < 1e-9 && f.material.uniforms.uWarpSpeed.value === 1);
  assert.equal(f.streaks.geometry.instanceCount, f.count);
  const phase = f.streaks.geometry.attributes.phase.array, bins = new Array(20).fill(0);
  for (const p of phase) bins[Math.floor(p * 20)]++;
  assert.ok(Math.max(...bins) - Math.min(...bins) <= 2, `every depth equally full, whatever the stars' order: ${bins}`);
  for (const name of ['uWarp', 'uWarpSpeed', 'uTwist', 'uViewport', 'uColor']) assert.equal(f.streaks.material.uniforms[name], f.material.uniforms[name], `${name} shared`);
  f.warp(); assert.equal(f.streaks.visible, false); assert.equal(f.material.uniforms.uWarpSpeed.value, 0);
});

test('the pixel sky is drawn at the device\'s own pixels (within a budget); the lock\'s ratio is unchanged', async () => {
  assert.equal(pixelRatioOf(390, 844, 3), 3); assert.equal(pixelRatioOf(1440, 900, 2), 2); assert.equal(pixelRatioOf(1024, 640, 1), 1);
  assert.equal(pixelRatioOf(2560, 1440, 3), 1.5, 'past the budget, a whole fraction (each pixel 2 x 2 device pixels)');
  assert.equal(pixelRatioOf(3840, 2160, 2), 1); assert.equal(pixelRatioOf(800, 600, 0), 1);
  for (const [w, h, d] of [[390, 844, 3], [5120, 2880, 2], [3840, 2160, 3]]) assert.ok(w * h * pixelRatioOf(w, h, d) ** 2 <= PIXEL_BUDGET || pixelRatioOf(w, h, d) === 1);
  assert.equal(pixelRatioFor(390, 844, 3), 2, 'the lock and the OS keep theirs');
  const scene = await read('scene.mjs');
  assert.match(scene, /renderer\.setPixelRatio\(pixels \? pixelRatioOf\(w, h, dpr\) : pixelRatioFor\(w, h, dpr\)\);/);
  assert.match(scene, /createScene\(canvas, \{ clear = 0x040308, pixels = false \} = \{\}\)/, 'opt-in');
  assert.match(scene, /if \(pixels\) canvas\.style\.imageRendering = 'pixelated';/);
});

const cues = JSON.parse(await read('media/v8-cues.json'));
// The film on the beat (Noah, 15 Oct): 140 bpm from 7.233 s; each hyperdrive is a 1 s ramp from rest that peaks
// exactly on its drop (beats 176 and 216), and the speed pulses on the beats in between.
const beat = b => 7.233 + b * 0.428543;
test('the cues are kept: a 1 s ramp from rest into each hyperdrive, peaking on its drop, eased in and out of every keyframe', () => {
  const table = warpTable(cues), keys = cues.warp;
  assert.ok(keys.every((k, i) => k.every(Number.isFinite) && k[1] >= 0 && (i === 0 || k[0] > keys[i - 1][0])), 'in time order, never negative');
  assert.deepEqual(keys[0], [81.658, 0], 'starts at rest');
  assert.deepEqual(keys.at(-1), [114.797, 0], 'ends at rest');
  for (const [from, drop, rest] of [[173.67, 176, 0], [213.67, 216, 0.05]]) {
    const start = keys.find(k => Math.abs(k[0] - beat(from)) < 0.002), peak = keys.filter(k => k[0] >= start?.[0] && k[0] <= beat(drop) + 0.5).reduce((a, k) => (k[1] > a[1] ? k : a), [0, -1]);
    assert.ok(start, `the ramp to beat ${drop} starts on beat ${from}`);
    assert.equal(start[1], rest, `from ${rest}`);
    assert.ok(Math.abs(peak[0] - beat(drop)) < 0.002, `peaks on the drop, beat ${drop} (${beat(drop).toFixed(3)} s): ${peak}`);
    assert.ok(Math.abs(peak[0] - start[0] - 1) < 0.01, `a 1 s ramp: ${peak[0] - start[0]}`);
  }
  for (const [t, s] of keys) assert.ok(Math.abs(table.speed(t) - s) < 1e-9, `${t} s: ${s}`);
  // flat at each keyframe (smoothstep): looked at a fiftieth of the way to its neighbour (some beat kicks are 1 ms long)
  keys.forEach(([t, s], i) => {
    for (const side of [1, -1]) {
      const next = keys[i + side]; if (!next) continue;
      const e = side * Math.min(0.0005, Math.abs(next[0] - t) / 50);
      assert.ok(Math.abs(table.speed(t + e) - s) < 0.002 * Math.max(1, s), `${t} s: flat at the keyframe (eased), ${table.speed(t + e)}`);
    }
  });
  for (let t = 97.7; t < 98.8; t += 0.1) assert.equal(table.speed(t), 0.05, 'a constant drift between the two');
});

// a clock and a film that plays at the wall's pace, its currentTime in uneven steps
function playing({ from = 85, frames = 240, jitter = 0.004, drop = 0.01, every = 90, seed = 3 } = {}) {
  let s = seed; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < frames; i++) out.push({ wall: 1000 + i / 60, film: from + i / 60 + (rand() - 0.5) * 2 * jitter - Math.floor(i / every) * drop });
  return out;
}
const flown = (table, a, b) => ((b.distance - a.distance) % 1 + 1) % 1;
test('the film clock: smooth while the film plays, exact at a seek and while held there, and never backwards through a stall', () => {
  let wall = 0;
  // the clock, not the film: a plain cue whose plateau (speed 1) makes even steps the right answer
  const plain = { duration: 120, warp: [[80, 0], [81, 1], [110, 1], [111, 0]] };
  const table = warpTable(plain, { clock: () => wall }), raw = warpTable(plain, { clock: () => NaN }), frames = playing();
  const steps = [], rawSteps = [];
  let last = null, lastRaw = null;
  for (const f of frames) {
    wall = f.wall;
    const at = table.at(f.film), r = raw.at(f.film);
    if (last) { steps.push(flown(table, last, at)); rawSteps.push(flown(raw, lastRaw, r)); }
    last = at; lastRaw = r;
  }
  const spread = v => { const m = v.reduce((a, b) => a + b) / v.length; return { m, cv: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m, min: Math.min(...v) / m, max: Math.max(...v) / m }; };
  const smooth = spread(steps.slice(10)), uneven = spread(rawSteps.slice(10));
  assert.ok(uneven.cv > 0.15, `the film's own steps are uneven: ${JSON.stringify(uneven)}`);
  assert.ok(smooth.cv < 0.03 && smooth.min > 0.9 && smooth.max < 1.1, `the sky's are even: ${JSON.stringify(smooth)}`);
  assert.ok(Math.abs(smooth.m - 0.6 / 60) < 0.0005, 'at the film\'s own pace');
  // a seek, then held there: exactly the film's time
  wall += 1 / 60; const exact = warpTable(plain).at(90);
  assert.deepEqual(table.at(90), exact, 'a seek is exact');
  for (let i = 0; i < 30; i++) { wall += 1 / 60; assert.deepEqual(table.at(90), exact, 'and so is a film held there'); }
  // playing again from there, then a stall (currentTime stops), then playing on
  let t = 90, prev = table.at(t).distance, seen = [];
  for (let i = 0; i < 120; i++) {
    wall += 1 / 60; if (i < 40 || i >= 80) t += 1 / 60;
    const d = table.at(t).distance, step = ((d - prev) % 1 + 1) % 1;
    seen.push(step); prev = d;
  }
  assert.ok(seen.every(step => step < 0.03), `never backwards (a backward step would wrap to ~1), never a leap: ${Math.max(...seen)}`);
  assert.ok(seen.slice(50, 78).every(step => step === 0), 'waits through the stall');
  // a stateless table (no clock) is the integrated table itself
  for (const time of [83, 90.5, 105]) assert.deepEqual(raw.at(time), { distance: raw.distance(time) % 1, speed: raw.speed(time) });
});

// ---- the bubble without a ring (Noah: "idk why there's a circle in the bubble")
test('the black hole keeps its circle unless asked: star for star the one live HEAD runs, every phase', () => {
  const field = (n, seed) => {
    let t = seed; const r = () => ((t = Math.imul(t ^ (t >>> 15), 1 | t) + 0x6d2b79f5 >>> 0) / 4294967296);
    const positions = new Float32Array(n * 3), sizes = new Float32Array(n), alphas = new Float32Array(n);
    for (let i = 0; i < n; i++) { positions[i * 3] = r() * 1200; positions[i * 3 + 1] = -r() * 800; positions[i * 3 + 2] = (r() - 0.5) * 600; sizes[i] = 1 + 3 * r(); alphas[i] = r(); }
    return { positions, sizes, alphas };
  };
  const eye = { x: 600, y: -400, z: 1400 };
  const cases = [{}, { circle: true }, { start: 'explode' }, { unwind: false, eye }, { reducedMotion: true }, { ringNear: 280, eye, ring: 1.27, spin: 0.68, consume: 2.1 }, { ringCount: 40, seed: 3, ring: 0.9, consume: 1.4 }];
  for (const options of cases) {
    const a = field(3000, 11), b = field(3000, 11);
    const before = holeBefore({ ...a, center: { x: 610, y: -390, z: 0 }, radius: 70, ...options });
    const after = createBlackHole({ ...b, center: { x: 610, y: -390, z: 0 }, radius: 70, ...options });
    assert.equal(after.duration, before.duration); assert.equal(after.ringCount, before.ringCount);
    for (let t = 0; t < before.duration + 0.3; t += 1 / 30) {
      const p = before.update(1 / 30), q = after.update(1 / 30);
      assert.deepEqual({ ...q, center: { ...q.center } }, { ...p, center: { ...p.center } }, `${JSON.stringify(options)} at ${t.toFixed(2)}`);
      assert.deepEqual(b.positions, a.positions); assert.deepEqual(b.sizes, a.sizes); assert.deepEqual(b.alphas, a.alphas);
    }
  }
});

// the site's whole black hole as intro.mjs runs it (GROW 1.5, HOLE_FIT 0.26, ZOOM 0.4, a source off the touch)
function bubbleHole(width, height, { pixels, circle }) {
  const stars = createStars({ width, height, pixels }), D = distanceFor(height); stars.place(width, height, D);
  const camera = { position: { x: width / 2, y: -height / 2, z: D } }, at = [width * 0.5, height * 0.6], source = [width * 0.7, height * 0.35];
  const small = revealAt(0, { at, width, height, grow: 1.5 }).small;
  const burst = contactBurst({ stars, camera, at, width, height, whole: true, radius: 0.26 * small, source, zoom: 0.4, ...(circle === undefined ? {} : { circle }) });
  return { stars, camera, at, D, burst };
}
// a circle, as seen: a thin band round the hole (5% of its radius) holding far more visible stars than the bands
// either side of it. Returns the worst band of the whole time before the burst.
function densestBand(width, height, hole) {
  const { stars, D, burst } = hole, a = stars.geometry.attributes, n = a.position.count;
  let worst = { score: 0 }, ringRadius = 0;
  for (let tau = 0.05; tau < BURST - 0.4; tau += 0.05) {
    const info = burst.update(tau), R = info.radius, cx = info.center.x, cy = info.center.y, p = a.position.array, bins = new Array(60).fill(0);
    ringRadius = Math.max(ringRadius, info.ringRadius);
    for (let i = 0; i < n; i++) {
      if (a.alpha.array[i] < 0.05 || a.size.array[i] <= 0) continue;
      const k = D / (D - p[i * 3 + 2]), j = Math.floor(Math.hypot((p[i * 3] - width / 2) * k + width / 2 - cx, (p[i * 3 + 1] + height / 2) * k - height / 2 - cy) / R / 0.05);
      if (j < 60) bins[j]++;
    }
    for (let j = 4; j < 56; j++) if (bins[j] >= 12) {
      const score = bins[j] / Math.max(bins[j - 3], bins[j + 3], 1);
      if (score > worst.score) worst = { score, tau: +tau.toFixed(2), band: j * 0.05, stars: bins[j] };
    }
  }
  return { ...worst, ringRadius };
}
test('the pixel sky\'s bubble: never a circle, the stars only lean and swirl in to one point, which bursts on the beat', () => {
  for (const [width, height] of [[1440, 900], [390, 844], [1024, 640]]) {
    const soft = densestBand(width, height, bubbleHole(width, height, { pixels: false }));
    assert.ok(soft.ringRadius > 0 && soft.score > 40, `${width}x${height}: the soft sky keeps its ring, and this finds it (${JSON.stringify(soft)})`);
    const px = densestBand(width, height, bubbleHole(width, height, { pixels: true }));
    assert.equal(px.ringRadius, 0, 'no ring is drawn');
    assert.ok(px.score < 8, `${width}x${height}: no band of stars round the hole, at any moment (${JSON.stringify(px)})`);
    // the same with the soft stars asked for no circle, and the pixel ones asked for one
    assert.ok(densestBand(width, height, bubbleHole(width, height, { pixels: false, circle: false })).score < 8);
    assert.ok(densestBand(width, height, bubbleHole(width, height, { pixels: true, circle: true })).score > 40);
  }
  // one point flickers at the end, then the lock's own burst at the touch, star for star
  const width = 1024, height = 640, site = bubbleHole(width, height, { pixels: true }), lock = bubbleHole(width, height, { pixels: true });
  const plain = contactBurst({ stars: lock.stars, camera: lock.camera, at: lock.at, width, height });
  const a = site.stars.geometry.attributes, seen = () => { let c = 0; for (let i = 0; i < a.position.count; i++) if (a.alpha.array[i] > 0 && a.size.array[i] > 0) c++; return c; };
  for (const tau of [0.6, 1.2]) { site.burst.update(tau); assert.ok(seen() > 0.95 * a.position.count, `the galaxy as it is at ${tau}`); }
  assert.equal(site.burst.update(BURST - 0.02).phase, 'shrink'); assert.equal(seen(), 1, 'one point, just before the burst');
  for (const tau of [BURST + 0.001, BURST + 0.4, BURST + 2]) {
    site.burst.update(tau); plain.update(tau);
    for (const name of ['position', 'size', 'alpha']) assert.deepEqual(a[name].array, lock.stars.geometry.attributes[name].array, `${name} at ${tau}: the lock's burst`);
  }
});
