// The launch page's galaxy as the GPU draws it (galaxy.patch): the default sky (the lock's, the OS's) draws exactly
// what live HEAD's stars.mjs drew; the pixel sky is crisp squares of whole device pixels where the stars are; and the
// hyperdrive is steady (the old in-place one pulsed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDirectory } from '../../tools/serve.mjs';
import { launchChromium } from '../../tools/test-browser.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
let server, browser, page;
test.before(async () => {
  server = await serveDirectory(ROOT);
  browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  await page.goto(server.origin + '/website/world.html?at=login'); // any page of the site: the modules' origin
  await page.evaluate(async () => {
    const T = await import('/website/vendor/three.module.js'), now = await import('/website/stars.mjs');
    const before = await import('/locker/test/fixtures/stars-before-pixels.mjs'), sky = await import('/website/sky.mjs');
    // draw({ module, w, h, ratio, pixels, tick, warp, after, lens, edit, post }) -> the drawing buffer's red channel and size
    const renderers = {}; // one per size, so its compiled shaders are kept
    window.draw = ({ module = 'now', w = 640, h = 400, ratio = 1, pixels = false, tick = { twinkle: false }, warp = null, after = null, lens = null, edit = null, post = null }) => {
      const key = `${w}x${h}@${ratio}`;
      const renderer = renderers[key] ??= new T.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, alpha: false, preserveDrawingBuffer: true });
      renderer.setPixelRatio(ratio); renderer.setSize(w, h, false); renderer.setClearColor(0x000000, 1);
      const camera = new T.PerspectiveCamera(30, 1, 1, 10), D = sky.aim(camera, w, h);
      const stars = (module === 'now' ? now : before).createStars({ width: w, height: h, ...(pixels ? { pixels } : {}) }); stars.place(w, h, D);
      edit?.(stars, camera, D);
      const scene = new T.Scene(); scene.add(stars.points);
      stars.tick(3.21, ratio, tick); if (warp) stars.warp(...warp); if (after) stars.warp(...after); if (lens) stars.lens(...lens); post?.(stars);
      renderer.render(scene, camera);
      const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const red = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) red[i] = px[4 * i];
      stars.geometry.dispose(); stars.streaks?.geometry.dispose();
      return { red, W, H, stars };
    };
    window.hash = red => { let h = 0, lit = 0; for (const v of red) { h = (h * 31 + v) >>> 0; if (v) lit++; } return { h, lit }; };
    window.lit = red => { let n = 0; for (const v of red) if (v > 24) n++; return n; };
    // the lit pixels' 4-connected pieces: their boxes, pixel counts and values
    window.pieces = (red, W, H) => {
      const seen = new Uint8Array(W * H), out = [];
      for (let i = 0; i < W * H; i++) {
        if (seen[i] || !red[i]) continue;
        let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0, lo = 255, hi = 0; const stack = [i]; seen[i] = 1;
        while (stack.length) {
          const j = stack.pop(), x = j % W, y = (j - x) / W, v = red[j];
          n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); lo = Math.min(lo, v); hi = Math.max(hi, v);
          for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j - W, j + W]) if (k >= 0 && k < W * H && !seen[k] && red[k]) { seen[k] = 1; stack.push(k); }
        }
        out.push({ x: (x0 + x1 + 1) / 2, y: (y0 + y1 + 1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1, n, lo, hi });
      }
      return out;
    };
  });
});
test.after(async () => { await browser?.close(); await new Promise(done => server ? server.server.close(done) : done()); });

test('the default sky draws byte for byte what live HEAD drew: the lock, the OS sky, the bubble\'s lens, and after a hyperdrive', async () => {
  const result = await page.evaluate(() => {
    const cases = { still: {}, twinkle: { tick: {} }, twist: { tick: { twist: 7.5, rotation: { centre: 0.03, edge: 0.12, hold: 1.42, rest: 1.7 } } }, flow: { tick: { flow: 130 } },
      avoid: { tick: { avoid: { lines: [[100, 150, 500, 200]], caret: [300, 175, 20], kicks: [[200, 100, 3, 40]] } } }, lens: { lens: [[320, 200], [100, 100], 0.4] }, dpr2: { ratio: 2 } };
    const out = {};
    for (const [name, c] of Object.entries(cases)) out[name] = { before: hash(draw({ module: 'before', ...c }).red), now: hash(draw(c).red), flown: hash(draw({ ...c, warp: [0.37, 1], after: [0, 0] }).red) };
    return out;
  });
  for (const [name, r] of Object.entries(result)) {
    assert.ok(r.before.lit > 100, `${name}: drew stars`);
    assert.equal(r.now.h, r.before.h, `${name}: identical pixels`);
    assert.equal(r.flown.h, r.before.h, `${name}: and back exactly as it was once the hyperdrive is over`);
  }
});

test('the pixel sky: every star a solid square of whole device pixels, exactly where the star is, at DPR 1, 2 and 3', async () => {
  for (const ratio of [1, 2, 3]) {
    const r = await page.evaluate(ratio => {
      // a few dozen bright stars, well apart, the rest dark: each should be one solid n x n square at its place
      let picked = [];
      const { red, W, H } = draw({ pixels: true, ratio, tick: { twinkle: false, twist: 4, rotation: { centre: 0.03, edge: 0.12, hold: 1.42, rest: 1.7 } }, edit: (stars, camera) => {
        const a = stars.geometry.attributes, pos = a.orbit.array, alpha = a.alpha.array, size = a.size.array, T = camera.constructor;
        const placed = [];
        for (let i = 0; i < stars.count; i++) {
          // where it is drawn: its home turned by the twist (as the shader turns it), projected
          const k = 1 - pos[3 * i + 2] / stars.material.uniforms.uSpan.value.y, x = (pos[3 * i] - 320) / (320 * k), y = (pos[3 * i + 1] + 200) / (200 * k);
          const anchorK = 1 - pos[3 * i + 2] / stars.material.uniforms.uSpan.value.y, ax = (a.anchor.array[2 * i] - 320) / (320 * anchorK), ay = (a.anchor.array[2 * i + 1] + 200) / (200 * anchorK), rr = Math.hypot(ax, ay);
          const t = Math.min(1, Math.max(0, (rr - 1.42) / (1.7 - 1.42))), angle = 4 * (0.03 + 0.09 * Math.min(rr, 1.42)) * (1 - t * t * (3 - 2 * t)), c = Math.cos(angle), s = Math.sin(angle);
          const sx = (c * x - s * y + 1) * 320 * ratio, sy = (c * y + s * x + 1) * 200 * ratio; // device px, y up
          const ok = a.kind.array[i] === 0 && sx > 20 && sx < 640 * ratio - 20 && sy > 20 && sy < 400 * ratio - 20 && placed.every(([px, py]) => Math.hypot(px - sx, py - sy) > 14 * ratio) && placed.length < 40;
          if (ok) { placed.push([sx, sy]); picked.push({ sx, sy, n: Math.max(1, Math.floor(size[i] * ratio + 0.5)) }); }
          alpha[i] = ok ? 1 : 0;
        }
      } });
      return { picked, pieces: pieces(red, W, H) };
    }, ratio);
    assert.ok(r.picked.length >= 20, `DPR ${ratio}: ${r.picked.length} stars to look at`);
    assert.equal(r.pieces.length, r.picked.length, `DPR ${ratio}: one piece per star`);
    for (const star of r.picked) {
      const piece = r.pieces.find(p => Math.hypot(p.x - star.sx, p.y - star.sy) < 1.5);
      assert.ok(piece, `DPR ${ratio}: a square where the star is (${star.sx.toFixed(1)}, ${star.sy.toFixed(1)})`);
      assert.deepEqual([piece.w, piece.h, piece.n], [star.n, star.n, star.n * star.n], `DPR ${ratio}: a whole ${star.n} x ${star.n} square`);
      assert.equal(piece.lo, piece.hi, 'solid: no soft edge');
    }
  }
  // the whole field: squares (where two touch, as in a little galaxy's dots, they make one bigger piece)
  const field = await page.evaluate(() => { const { red, W, H } = draw({ pixels: true, ratio: 2 }); const p = pieces(red, W, H); return { all: p.length, square: p.filter(q => q.w === q.h && q.n === q.w * q.w && q.lo === q.hi).length, sizes: p.map(q => q.w) }; });
  assert.ok(field.square / field.all > 0.95, `the field is solid squares: ${field.square}/${field.all}`);
  assert.ok(field.sizes.filter(w => w <= 2).length / field.all > 0.95, 'of 1-2 device px at DPR 2');
});

test('the hyperdrive is steady: as many lit pixels at every point of the flight (the old in-place one swung up and down)', async () => {
  const r = await page.evaluate(() => {
    const flight = (opts, speed) => Array.from({ length: 24 }, (_, k) => lit(draw({ ...opts, tick: { twinkle: false, twist: -20, rotation: { centre: 0.03, edge: 0.12, hold: 1.42, rest: 1.7 } }, warp: [k / 24, speed] }).red));
    const fieldOnly = lit(draw({ pixels: true, warp: [0.5, 1], post: stars => { stars.streaks.visible = false; } }).red);
    return { before: flight({ module: 'before' }, 1), soft: flight({}, 1), pixels: flight({ pixels: true }, 1), fast: flight({ pixels: true }, 1.25), fieldOnly };
  });
  const spread = v => { const m = v.reduce((a, b) => a + b) / v.length; return { mean: Math.round(m), cv: +(Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m).toFixed(3), min: Math.min(...v), max: Math.max(...v) }; };
  const s = Object.fromEntries(['before', 'soft', 'pixels', 'fast'].map(k => [k, spread(r[k])]));
  console.log('HYPERDRIVE:', JSON.stringify(s));
  assert.ok(s.before.cv > 0.3 && s.before.max > 3 * s.before.min, `the old hyperdrive pulsed: ${JSON.stringify(s.before)}`);
  for (const k of ['soft', 'pixels', 'fast']) {
    assert.ok(s[k].cv < 0.05 && s[k].max < 1.15 * s[k].min, `${k}: steady ${JSON.stringify(s[k])}`);
    assert.ok(s[k].mean > 0.5 * s.before.mean, `${k}: as full as the old one on average`);
  }
  assert.equal(r.fieldOnly, 0, 'at full speed the resting field has handed over to the streaks entirely');
});

test('createScene({ pixels }) draws at the device\'s own pixels, pixelated; the default scene is the lock\'s', async () => {
  const r = await page.evaluate(async () => {
    const { createScene } = await import('/website/scene.mjs');
    const make = async (pixels, dpr) => {
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:390px;height:844px'; document.body.append(canvas);
      const s = await createScene(canvas, pixels ? { pixels: true } : {}); await s.resize(390, 844, dpr);
      const out = { ratio: s.renderer.getPixelRatio(), width: canvas.width, rendering: canvas.style.imageRendering, pixels: s.stars.pixels };
      s.renderer.dispose(); canvas.remove(); return out;
    };
    return { pixels: await make(true, 3), lock: await make(false, 3) };
  });
  assert.deepEqual(r.pixels, { ratio: 3, width: 1170, rendering: 'pixelated', pixels: true });
  assert.deepEqual(r.lock, { ratio: 2, width: 780, rendering: '', pixels: false });
});
