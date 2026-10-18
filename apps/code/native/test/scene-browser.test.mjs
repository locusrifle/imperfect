import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';

// Any page of the website, for its modules' address (the optional world page that held this check is gone).
const PAGE = new URL('../../../../website/host.html', import.meta.url).href;
const launch = () => launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });

test('the shared sky: stars alone, kept through a resize, drawn with the uniforms it is given', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE);
    const sky = await page.evaluate(async () => {
      const { createScene } = await import('./scene.mjs');
      const { pixelRatioFor, distanceFor } = await import('./sky.mjs');
      const canvas = document.createElement('canvas');
      const s = await createScene(canvas);
      await s.resize(1024, 640, 3);
      const original = Array.from(s.stars.geometry.attributes.position.array);
      s.enter(0, 0); s.settle(0); s.leave(1); s.reset(); s.setFade(0);
      await s.resize(390, 844, 3, { stars: false });
      const held = original.every((v, i) => v === s.stars.geometry.attributes.position.array[i]);
      s.frame(9, 844, { x: 0, y: 0 }, { motion: false, starOpacity: 0.4, flow: 2, starTime: 17, starTwist: -3 });
      const U = s.stars.material.uniforms;
      const result = { held, onlyStars: s.scene.children.length === 1 && s.scene.children[0] === s.stars.points,
        pieces: s.instances.length, arrival: s.arrival(0), distance: s.D === distanceFor(844),
        ratio: s.renderer.getPixelRatio() === pixelRatioFor(390, 844, 3), projection: s.project(195, 1266),
        uniforms: [U.uTime.value, U.uOpacity.value, U.uFlow.value, U.uTwist.value, U.uTwinkle.value] };
      s.stars.geometry.dispose(); s.stars.material.dispose(); s.renderer.dispose();
      return result;
    });
    assert.ok(sky.held && sky.onlyStars && sky.distance && sky.ratio, JSON.stringify(sky));
    assert.equal(sky.pieces, 0); assert.equal(sky.arrival, 0);
    assert.ok(Math.abs(sky.projection[0] - 195) < 1e-6 && Math.abs(sky.projection[1] - 422) < 1e-6, JSON.stringify(sky.projection));
    assert.deepEqual(sky.uniforms, [17, 0.4, 2, -3, 0]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
