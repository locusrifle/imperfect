import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL('../../../../' + path, import.meta.url), 'utf8');
const src = read('desktop/lock/lock.mjs'), sequence = read('website/boot/sequence.mjs');
const html = read('desktop/lock/index.html');
test('both hosts import one boot, with centred touch, sound ripples, full hole and clean-cut marks', () => {
  assert.match(src, /import \{ createSequence \} from '\.\.\/\.\.\/website\/boot\/sequence\.mjs'/);
  assert.match(read('website/intro/intro.mjs'), /import \{ createSequence \} from '\.\.\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  assert.match(sequence, /frameOf\(vw, vh, box, \{ centred: true \}\)/);
  assert.match(sequence, /motion: soundMotion/);
  assert.match(sequence, /whole: true, radius: HOLE_FIT/);
  assert.match(sequence, /formed: 1, opacity: 1 - out, blur: 0, scale: 1/);
  assert.match(sequence, /goatTimes/);
  assert.match(sequence, /pixels: SKY_PIXELS/); // the one galaxy setting, shared with the kept sky (sky.mjs)
  assert.match(sequence, /BOOT_ROTATION as SPIN/);
  assert.equal((html.match(/<canvas\b/g)||[]).length, 3);
  for (const id of ['glow','rimPath','goat']) assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /feGaussianBlur/);
  assert.equal((html.match(/class="field"/g)||[]).length, 1);
});
test('the lock galaxy contains stars alone, with no painted pieces or cut-out requests', () => {
  const sky = read('website/scene.mjs');
  assert.match(sky, /instances: \[\]/);
  assert.doesNotMatch(sky, /TextureLoader|PlaneGeometry|fetch\(|manifest|cutouts/);
});
test('the world remains a count-only native keeper presentation, never a password input', () => {
  assert.doesNotMatch(html, /<(?:input|textarea)\b|contenteditable/i);
  assert.doesNotMatch(src + sequence, /addEventListener\(['"](?:keydown|keypress|keyup)['"]/);
  assert.match(src, /key\(count = S\.typed \+ 1\)/);
  assert.match(src, /tell\('idle'\)/); assert.match(src, /tell\('done'\)/);
  assert.match(src, /if \(S\.yes &&/);
  assert.match(src, /messageHandlers\?\.imperfect/);
});
