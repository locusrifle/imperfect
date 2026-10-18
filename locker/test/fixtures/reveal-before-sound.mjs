// Live website/reveal.mjs as of d6bb7372 (before the follow-up), its imports pointed at the site: the lock's reveal, to
// prove the staged one gives the lock exactly what it had.
// The website's contact reveal, also drawn by the lock. Both are only renderers
// of this result: same recording, bubble, edge, touch light and burst clock.
import { BURST, bubbleMotion } from '../../../website/bootup.mjs';
import { reach } from './bubble-before-sound.mjs';
import { createBlackHole, DEFAULTS as HOLE } from './blackhole-before-ring-near.mjs';
export const REVEAL = Object.freeze({ breathe: BURST, open: 0.8, length: BURST + 0.8, fade: BURST, small: 0.095, light: 0.45 });
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
// grow (opt-in, the launch page's): a larger breathing bubble before the pop; 1 is the lock's.
export function revealAt(tau, { at, width, height, scale = width / 1536, grow = 1 }) {
  const b = bubbleMotion(tau, REVEAL.open), small = Math.max(14, REVEAL.small * grow * Math.min(width, height));
  const r = small * b.radius, full = reach(...at, width, height), R = r + (full - r) * b.ex;
  const light = smooth(tau / REVEAL.light);
  return { ...b, R, at, small, pop: tau >= BURST,
    rim: clamp(R / (0.5 * small)) * (1 - smooth((b.ex - 0.7) / 0.3)),
    // The site's existing warm cream/gold radial touch glow, not a new flash.
    // It builds over .45s, stays behind the bubble and fades over .4s at pop.
    glow: light * (1 - smooth((tau - BURST) / 0.4)),
    glowScale: (0.3 + 0.7 * light) * (1 + 0.6 * b.ex),
    glowSize: Math.max(120, 300 * scale),
  };
}
// Shared burst integrator. Catch up on the contact/audio clock rather than
// accumulating capped frame dt. First birth fills the disc, never a point.
// whole (opt-in, the launch page's): the black hole's whole sequence from the touch, round the contact point and
// inside the bubble (ring, spin, consume, swell, collapse, flicker), its phases scaled so the explode starts exactly
// at BURST, then the same burst. Without it, as the lock has it: only the burst, at BURST.
export const WHOLE = Object.freeze(['ring', 'spin', 'consume', 'expand', 'shrink', 'pulse']);
export function contactBurst({ stars, camera, at, width, height, whole = false, radius = null }) {
  const a = stars.geometry.attributes;
  const pre = WHOLE.reduce((sum, name) => sum + HOLE[name], 0), k = BURST / pre;
  const burst = createBlackHole({ positions: a.position.array, sizes: a.size.array, alphas: a.alpha.array,
    center: { x: at[0], y: -at[1], z: 0 }, radius: whole && radius ? radius : Math.min(height * 0.2, width * 0.3),
    eye: camera.position, start: whole ? 'ring' : 'explode', unwind: false,
    ...(whole ? Object.fromEntries(WHOLE.map(name => [name, HOLE[name] * k])) : {}) });
  let elapsed = 0;
  return {
    whole,
    get done() { return burst.done; },
    get duration() { return burst.duration; },
    get phase() { return burst.info.phase; },
    update(tau) {
      const target = Math.min(Math.max(0, whole ? tau : tau - BURST) + 1 / 60, burst.duration + 0.001);
      let info = burst.info;
      while (elapsed < target && !burst.done) { const dt = Math.min(0.1, target - elapsed); info = burst.update(dt); elapsed += dt; }
      if (info.dirty) for (const name of ['position', 'size', 'alpha']) a[name].needsUpdate = true;
      return info;
    },
  };
}
