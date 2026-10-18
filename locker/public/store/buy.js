// The buy page: the black hole's specks behind it, as the power screen shows
// them before the press (the same art at its first step, in the same colours),
// and the goat at the end of the buy line.
import { Session } from '/assets/js/wte/ttfx.js';
import { paintFrame } from '/assets/js/paint.js';
import { sizeCanvas } from '/assets/js/sequence.js';

const v = new URL(import.meta.url).search;
const { PALETTES, loadEngine, recolour } = await import(`/engine.js${v}`);
const { bestArt, fontReady } = await import(`/shared/blockmark.js${v}`);

// The page waits, hidden, for its specks, and then all of it shows at once
// (locker.css has it shown anyway after a moment, should any of this be slow
// or fail).
const arrive = () => document.documentElement.classList.remove('arriving');

const canvas = document.createElement('canvas');
canvas.className = 'buy-stars';
canvas.setAttribute('aria-hidden', 'true');
document.body.prepend(canvas);
const light = window.matchMedia('(prefers-color-scheme: light)');

function stars() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const phone = width < 600;
  const { art, metrics } = bestArt(['imperfect'], width, height, { maxCell: phone ? 9 : 14, share: phone ? [0.86, 0.5] : [0.7, 0.5] });
  const ctx = sizeCanvas(canvas, width, height);
  const palette = PALETTES[light.matches ? 'light' : 'dark'];
  const session = new Session(art, 'blackhole', metrics.columns, metrics.rows, undefined, 120);
  try {
    session.step();
    const count = session.width() * session.height();
    const frame = { symbols: new Uint32Array(count), fg: new Uint32Array(count), bg: new Uint32Array(count), flags: new Uint8Array(count), width: session.width(), height: session.height() };
    session.fill(frame.symbols, frame.fg, frame.bg, frame.flags);
    paintFrame(ctx, metrics, frame, { tint: recolour(palette.stops, palette.across) });
  } finally { session.free(); }
}

// Drawn as soon as the engine is in, and again once the Omarchy Font has
// come (the specks are its glyphs), on a resize, and when light or dark changes.
const late = ms => new Promise(done => window.setTimeout(() => done(false), ms));
if (await Promise.race([loadEngine(), late(2000)])) {
  await Promise.race([fontReady(), late(800)]);
  try { stars(); } catch { /* the page shows without them */ }
  arrive();
  let later = 0;
  const again = () => { window.clearTimeout(later); later = window.setTimeout(stars, 150); };
  void fontReady().then(again);
  window.addEventListener('resize', again);
  light.addEventListener('change', again);
}
else {
  arrive();
  void loadEngine().then(ok => { if (ok) try { stars(); } catch { /* without them */ } });
}
