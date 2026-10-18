import test from 'node:test';
import assert from 'node:assert/strict';
import { twistAt, skyTime, pixelRatioFor, TOUCH, TWIST } from '../../../../website/sky.mjs';

const touched = 1205.456, from = touched + TOUCH.pop;

test('Countercurrent starts at birth, in the negative direction; no touch or reduced motion stays still', () => {
  assert.equal(TWIST, 'reverse');
  for (const now of [touched - 5, touched, from]) assert.equal(twistAt(now, { touched }), 0);
  for (const times of [{}, { touched, still: true }, { touched: NaN }]) assert.equal(twistAt(from + 10, times), 0);
  for (const s of [0.01, 0.5, 2, 30, 600]) assert.ok(Math.abs(twistAt(from + s, { touched }) + s) < 1e-12);
});

test('constant negative twist rate before and after unlock; no speed change at gone', () => {
  for (const gone of [from - 2, from + 0.3, from + 4, from + 120]) {
    const at = s => twistAt(gone + s, { touched, gone });
    for (const s of [-0.2, 0, 0.1, 1.6, 2, 40]) {
      if (gone + s <= from) continue;
      const dt = 0.001;
      assert.ok(Math.abs((at(s + dt) - at(s)) / dt + 1) < 1e-8);
      assert.equal(at(s), twistAt(gone + s, { touched }));
    }
    if (gone > from) assert.ok(Math.abs((at(0) - at(-0.001)) - (at(0.001) - at(0))) < 1e-10);
  }
});

test('pure wall-clock motion: dropped frames, sleeps, theme and repeated evaluations cannot change a frame', () => {
  const now = from + 8, direct = twistAt(now, { touched });
  for (let k = 0; k < 50; k++) twistAt(from + k * 100, { touched });
  assert.equal(twistAt(now, { touched, gone: now - 2 }), direct);
  assert.equal(skyTime(1760083300.25, 1760083200.0004), skyTime(1760083300.25, 1760083200.000));
  assert.equal(pixelRatioFor(1472, 920, 2), 2);
  assert.ok(pixelRatioFor(3840, 2160, 2) < 2);
});
