// The website's contact reveal, also drawn by the lock. Both are only renderers
// of this result: same recording, bubble, edge, touch light and burst clock.
import { BURST, bubbleMotion } from './bootup.mjs';
import { reach } from './bubble.mjs';
import { createBlackHole, DEFAULTS as HOLE } from './blackhole/blackhole.mjs';
export const REVEAL = Object.freeze({ breathe: BURST, open: 0.8, length: BURST + 0.8, fade: BURST, small: 0.095, light: 0.45 });
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
// grow (opt-in, the launch page's): a larger breathing bubble before the pop; 1 is the lock's. motion (opt-in, the
// launch page's): the bubble's motion, bubble-sound.mjs's soundMotion; bootup.mjs's bubbleMotion is the lock's.
export function revealAt(tau, { at, width, height, scale = width / 1536, grow = 1, motion = bubbleMotion }) {
  const b = motion(tau, REVEAL.open), small = Math.max(14, REVEAL.small * grow * Math.min(width, height));
  const r = small * b.radius, full = reach(...at, width, height), R = r + (full - r) * b.ex;
  const light = smooth(tau / REVEAL.light);
  // shine (soundMotion's only): the touch light brightens with the sound's loudness, brightness and hits.
  // The rim stays fully opaque; only its shape moves with the sound.
  const lit = b.shine ?? null;
  return { ...b, R, at, small, pop: tau >= BURST,
    rim: 1,
    // The site's existing warm cream/gold radial touch glow, not a new flash.
    // It builds over .45s, stays behind the bubble and fades over .4s at pop.
    glow: light * (1 - smooth((tau - BURST) / 0.4)) * (lit === null ? 1 : 0.8 + 0.2 * lit),
    glowScale: (0.3 + 0.7 * light) * (1 + 0.6 * b.ex) * (lit === null ? 1 : 1 + 0.12 * b.kick),
    glowSize: Math.max(120, 300 * scale),
  };
}
// Shared burst integrator. Catch up on the contact/audio clock rather than
// accumulating capped frame dt. First birth fills the disc, never a point.
// whole (opt-in, the launch page's): the black hole's whole sequence from the touch, inside the bubble (ring, spin,
// consume, swell, collapse, flicker), its phases scaled to end exactly at BURST; then, from BURST, the lock's own
// burst out of the touch. source (with whole): the bubble is a window onto the sky round that screen point (CSS px)
// instead of the quiet middle the touch is in, `zoom` times its size (so more of it shows): the hole forms there,
// from the stars round it (ringNear), its ring drawn the given radius, and `lens` says how to draw the field so it
// sits in the bubble. At BURST every star but the last point is swallowed, so handing over to the burst at the touch
// moves nothing that can be seen. circle (with whole): false draws no ring at any moment, the stars only lean in and
// swirl to the point (blackhole.mjs circle); by default the pixel sky (stars.pixels, the launch page's) has none and
// the soft one keeps its ring. Without whole, as the lock has it: only the
// burst, at BURST.
export const WHOLE = Object.freeze(['ring', 'spin', 'consume', 'expand', 'shrink', 'pulse']);
export function contactBurst({ stars, camera, at, width, height, whole = false, radius = null, source = null, zoom = 1, circle = !stars.pixels }) {
  const a = stars.geometry.attributes;
  const arrays = { positions: a.position.array, sizes: a.size.array, alphas: a.alpha.array, eye: camera.position, unwind: false };
  const burst = createBlackHole({ ...arrays, center: { x: at[0], y: -at[1], z: 0 }, radius: Math.min(height * 0.2, width * 0.3), start: 'explode' });
  const pre = WHOLE.reduce((sum, name) => sum + HOLE[name], 0), k = BURST / pre, from = whole ? source || at : null;
  const g = source && zoom > 0 ? zoom : 1;
  const hole = whole ? createBlackHole({ ...arrays, center: { x: from[0], y: -from[1], z: 0 }, radius: (radius || Math.min(height * 0.2, width * 0.3)) / g,
    start: 'ring', ringNear: source ? 4 * Math.max(36, Math.min(96, Math.round(a.position.count * 0.024))) : 0, circle,
    ...Object.fromEntries(WHOLE.map(name => [name, HOLE[name] * k])) }) : null;
  let elapsed = 0, before = 0, handed = !whole;
  const flag = info => { if (info.dirty) for (const name of ['position', 'size', 'alpha']) a[name].needsUpdate = true; return info; };
  return {
    whole,
    source: from,
    // how to draw the field while the bubble looks onto the source (stars.lens), else null
    get lens() { return handed || !source ? null : { from, to: at, scale: g }; },
    get done() { return burst.done; },
    get duration() { return burst.duration; },
    get phase() { return handed ? burst.info.phase : hole.info.phase; },
    update(tau) {
      if (!handed) {
        const target = Math.min(Math.max(0, tau) + 1 / 60, BURST - 1e-6);
        let info = hole.info;
        while (before < target) { const dt = Math.min(0.1, target - before); info = hole.update(dt); before += dt; }
        if (tau < BURST) return flag(info);
        hole.stop(); handed = true; // every star home, for the burst to gather at the touch
      }
      const target = Math.min(Math.max(0, tau - BURST) + 1 / 60, burst.duration + 0.001);
      let info = burst.info;
      while (elapsed < target && !burst.done) { const dt = Math.min(0.1, target - elapsed); info = burst.update(dt); elapsed += dt; }
      return flag(info);
    },
  };
}
// Where the bubble should look before it opens: a part of the first screen's sky as rich as the open galaxy (dust,
// stars and a four-point burst beside where the ring will be), not the quiet middle. Pure: the field's resting
// positions (world, as stars.place() puts them), kinds and alphas, the camera distance D and the screen; look is the
// window's radius (CSS px). Returns the screen point [x, y].
export function pickSource({ positions, kinds, alphas, D, width, height, look }) {
  const n = Math.min(positions.length / 3, kinds.length, alphas.length), sx = new Float32Array(n), sy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = 1 - positions[3 * i + 2] / D;
    sx[i] = width / 2 + (positions[3 * i] - width / 2) / k; sy[i] = height / 2 + (-positions[3 * i + 1] - height / 2) / k;
  }
  // the stars on screen, binned by the window's size, so each candidate only looks at its neighbours
  const cols = Math.ceil(width / look) + 2, rows = Math.ceil(height / look) + 2, bins = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(sx[i] / look) + 1, r = Math.floor(sy[i] / look) + 1;
    if (c >= 0 && c < cols && r >= 0 && r < rows) bins[r * cols + c].push(i);
  }
  const step = Math.max(6, look / 4), edge = Math.min(1.2 * look, width / 2, height / 2), out = [];
  for (let y = edge; y <= height - edge; y += step) for (let x = edge; x <= width - edge; x += step) {
    let dust = 0, burst = false;
    const c0 = Math.floor(x / look) + 1, r0 = Math.floor(y / look) + 1;
    for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) for (const i of bins[r * cols + c] ?? []) {
      const d = Math.hypot(sx[i] - x, sy[i] - y);
      if (d > look) continue;
      if (kinds[i] === 1) { if (d > 0.25 * look && d < 0.75 * look) burst = true; } else if (kinds[i] === 0) dust += alphas[i];
    }
    out.push({ x, y, dust, burst });
  }
  if (!out.length) return [width / 2, height / 2];
  const ranked = out.map(c => c.dust).sort((p, q) => p - q), aim = ranked[Math.floor(0.7 * (ranked.length - 1))];
  const pool = out.some(c => c.burst) ? out.filter(c => c.burst) : out;
  const best = pool.reduce((p, q) => (Math.abs(q.dust - aim) < Math.abs(p.dust - aim) ? q : p));
  return [best.x, best.y];
}
