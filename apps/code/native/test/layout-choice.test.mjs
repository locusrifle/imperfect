import test from 'node:test';
import assert from 'node:assert/strict';
import { initialLayout, LAYOUTS } from '../public/js/layout-choice.js';

test('browser reloads saved before browser focus default to focus, not their automatic old layout', () => {
  for (const old of [null, 'scrolling', 'dwindle', 'focus', 'invalid']) assert.equal(initialLayout(null, old), 'focus');
});
test('only an explicit new choice overrides browser focus; native saved layouts are retained', () => {
  for (const choice of LAYOUTS) {
    assert.equal(initialLayout(choice, 'focus'), choice);
    assert.equal(initialLayout(null, choice, true), choice);
  }
  assert.equal(initialLayout('invalid', 'scrolling'), 'focus');
  assert.equal(initialLayout('dwindle', 'scrolling', true), 'dwindle');
});
