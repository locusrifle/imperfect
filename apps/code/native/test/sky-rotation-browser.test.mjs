import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDirectory } from '../../../../tools/serve.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { ROTATION, twistRate } from '../../../../website/stars.mjs';

// The twist as the GPU draws it (stars.mjs's vertex shader, the one the website, the lock and imperfect's kept sky
// share): three stars on the page plane at radii 0.2, 0.5 and 0.85 of the screen, drawn at several twist times.
// Each one's measured angular speed must be the law's, grow with the radius, and stay the same over time.
const ROOT = new URL('../../../../', import.meta.url).pathname;
const W = 1024, H = 640;
const STARTS = [[0.2, 0], [0.5, Math.PI / 2], [0.85, Math.PI]]; // radius (screen units), resting angle

test('the drawn twist turns each radius at its own constant rate, faster outwards', async () => {
  const server = await serveDirectory(ROOT), browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.origin + '/website/host.html'); // any page of the site: the modules' origin
    const runs = await page.evaluate(async ({ W, H, STARTS, times }) => {
      const THREE = await import('/website/vendor/three.module.js');
      const { createStars, ROTATION } = await import('/website/stars.mjs');
      const { aim } = await import('/website/sky.mjs');
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1); renderer.setSize(W, H, false); renderer.setClearColor(0x000000, 1);
      const camera = new THREE.PerspectiveCamera(30, 1, 1, 10), D = aim(camera, W, H);
      const field = createStars({ width: W, height: H }); field.place(W, H, D); // the shared material, placed for this screen
      const n = STARTS.length, pos = new Float32Array(3 * n), anchor = new Float32Array(2 * n);
      STARTS.forEach(([r, a], i) => { pos[3 * i] = W / 2 + r * Math.cos(a) * W / 2; pos[3 * i + 1] = -H / 2 + r * Math.sin(a) * H / 2; anchor[2 * i] = pos[3 * i]; anchor[2 * i + 1] = pos[3 * i + 1]; });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('orbit', new THREE.BufferAttribute(pos.slice(), 3));
      g.setAttribute('anchor', new THREE.BufferAttribute(anchor, 2)); g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n).fill(9), 1));
      g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1)); g.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(n), 1));
      g.setAttribute('twinkle', new THREE.BufferAttribute(new Float32Array(2 * n), 2));
      const points = new THREE.Points(g, field.material); points.frustumCulled = false;
      const scene = new THREE.Scene(); scene.add(points);
      const gl = renderer.getContext(), px = new Uint8Array(W * H * 4), out = [];
      for (const T of times) {
        field.tick(0, 1, { twinkle: false, twist: -T, rotation: ROTATION });
        renderer.render(scene, camera);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // the lit blobs' centroids, in screen units about the centre (y up)
        const seen = new Uint8Array(W * H), blobs = [];
        for (let i = 0; i < W * H; i++) {
          if (seen[i] || px[4 * i] < 60) continue;
          let sx = 0, sy = 0, sw = 0; const stack = [i]; seen[i] = 1;
          while (stack.length) {
            const j = stack.pop(), x = j % W, y = Math.floor(j / W), w = px[4 * j];
            sx += x * w; sy += y * w; sw += w;
            for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < W * H && !seen[k] && px[4 * k] >= 60) { seen[k] = 1; stack.push(k); }
          }
          const cx = sx / sw + 0.5, cy = sy / sw + 0.5; // readPixels rows run bottom up
          blobs.push([(cx - W / 2) / (W / 2), (cy - H / 2) / (H / 2)]);
        }
        out.push({ T, blobs });
      }
      renderer.dispose(); g.dispose();
      return out;
    }, { W, H, STARTS, times: [2, 6, 12] });
    const rates = STARTS.map(() => []);
    for (const { T, blobs } of runs) {
      assert.equal(blobs.length, STARTS.length, JSON.stringify(blobs));
      STARTS.forEach(([r, a], i) => {
        const b = blobs.find(([x, y]) => Math.abs(Math.hypot(x, y) - r) < 0.03);
        assert.ok(b, `the star at ${r} kept its radius at ${T}s: ${JSON.stringify(blobs)}`);
        let turned = Math.atan2(b[1], b[0]) - a; turned = Math.atan2(Math.sin(turned), Math.cos(turned));
        rates[i].push(-turned / T); // Countercurrent: negative twist
      });
    }
    STARTS.forEach(([r], i) => {
      for (const w of rates[i]) assert.ok(Math.abs(w - twistRate(r)) < 0.003, `r ${r}: drawn ${w} rad/s, law ${twistRate(r)}`);
      assert.ok(Math.max(...rates[i]) - Math.min(...rates[i]) < 0.003, `r ${r} keeps one rate over time: ${rates[i]}`);
    });
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(mean(rates[0]) < mean(rates[1]) && mean(rates[1]) < mean(rates[2]), JSON.stringify(rates));
    assert.ok(mean(rates[2]) > 2 * mean(rates[0]), JSON.stringify(rates)); // 0.85 vs 0.2: the law gives 2.2 times
    assert.ok(ROTATION.centre < ROTATION.edge);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(r => server.server.close(r)); }
});
