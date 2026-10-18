import test from 'node:test';
import assert from 'node:assert/strict';
import {harnessFixture} from './fixtures/harness-page.mjs';

// A new theme and a session (session-origin tests) still use turn.js's slanted band.
// Lock arrival alone uses an opacity fade; it must not change these turns.
test('a new theme turns in the shared diagonal over the whole window, and simply changes without view transitions', async () => {
 let css = 'body{--fixture:1}';
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, messages:[{role:'assistant',content:'Ready.'}],
  handleRequest: async (req, res, path) => { if (path !== '/theme.css') return false; res.setHeader('Content-Type', 'text/css'); res.end(css); return true; }});
 const p = f.page;
 try {
  await p.evaluate(async () => {
   const {OPEN, OPENING} = await import('/js/turn.js');
   const reference = document.body.animate(OPEN, OPENING);
   globalThis.diagonal = reference.effect.getKeyframes().map(k => k.clipPath); reference.cancel();
   globalThis.turns = [];
   const animate = Element.prototype.animate;
   Element.prototype.animate = function(frames, options) { const a = animate.call(this, frames, options); if (frames === OPEN) { a.pause(); turns.push(a); } return a; };
   dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'one'}}));
  });
  css = 'body{--fixture:2}';
  await p.evaluate(() => dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'two'}})));
  await p.waitForFunction(() => turns.length === 1);
  const t = await p.evaluate(() => ({frames: turns[0].effect.getKeyframes().map(k => k.clipPath), diagonal, pseudo: turns[0].effect.pseudoElement, timing: turns[0].effect.getTiming(), turning: document.documentElement.classList.contains('turn')}));
  assert.deepEqual(t.frames, t.diagonal);
  assert.equal(t.pseudo, '::view-transition-new(root)');
  assert.equal(t.timing.duration, 420); assert.equal(t.timing.easing, 'cubic-bezier(0.65, 0, 0.35, 1)');
  assert.equal(t.turning, true);
  // the old look holds still beneath: nothing else animates in the transition
  const others = await p.evaluate(() => document.getAnimations().filter(a => a.effect?.pseudoElement && !turns.includes(a)).length);
  assert.equal(others, 0);
  await p.evaluate(() => turns[0].finish());
  await p.waitForFunction(() => !document.documentElement.classList.contains('turn'));
  assert.equal(await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--fixture').trim()), '2');
  css = 'body{--fixture:3}';
  await p.evaluate(() => { document.startViewTransition = undefined; dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'three'}})); });
  await p.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--fixture').trim() === '3');
  assert.equal(await p.evaluate(() => turns.length), 1);
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});

// Over the kept sky (arrival.js) the panels let the sky through: the sky turns with nothing, live beneath the
// band all through it, and the old look is drawn only outside the band, never under the new.
test('over the kept sky a new theme turns in the band with the sky live beneath it, the old look only outside it', async () => {
 let css = ':root{--theme-raised:#000000;--theme-bright:#ffffff}';
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, messages:[{role:'assistant',content:'Ready.'}],
  handleRequest: async (req, res, path) => { if (path !== '/theme.css') return false; res.setHeader('Content-Type', 'text/css'); res.end(css); return true; }});
 const p = f.page;
 try {
  await p.evaluate(async () => {
   const {mountArrival} = await import('/js/arrival.js');
   globalThis.now = 1760083300;
   let hear;
   globalThis.arrival = mountArrival({onLock: fn => { hear = fn; fn({epoch: now - 40, touched: now - 30}); }}, {clock: () => globalThis.now});
   await new Promise(r => { const t = setInterval(() => { if (document.documentElement.classList.contains('kept-sky')) { clearInterval(t); r(); } }, 20); });
   hear(null);
   await new Promise(r => setTimeout(r, 600));
   globalThis.turns = [];
   const animate = Element.prototype.animate;
   Element.prototype.animate = function(frames, options) { const a = animate.call(this, frames, options); if (options?.pseudoElement) { a.pause(); a.currentTime = 210; turns.push(a); } return a; };
   dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'one'}}));
  });
  css = ':root{--theme-raised:#100c0b;--theme-bright:#ffe7da}';
  await p.evaluate(() => dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'two'}})));
  await p.waitForFunction(() => turns.length === 2);
  const t = await p.evaluate(() => ({
   pseudo: turns.map(a => a.effect.pseudoElement),
   old: turns[1].effect.getKeyframes().map(k => k.clipPath),
   names: [getComputedStyle(document.documentElement).viewTransitionName, getComputedStyle(document.getElementById('canvas')).viewTransitionName, getComputedStyle(document.querySelector('canvas.kept-sky')).viewTransitionName],
  }));
  // the window's UI turns, the sky beneath it is never captured
  assert.deepEqual(t.pseudo, ['::view-transition-new(kept-ui)', '::view-transition-old(kept-ui)']);
  assert.deepEqual(t.names, ['none', 'kept-ui', 'none']);
  assert.deepEqual(t.old, ['path(evenodd, "M -10 -10 H 1210 V 810 H -10 Z M 672 0 L 672 0 L 528 800 L 528 800 Z")', 'path(evenodd, "M -10 -10 H 1210 V 810 H -10 Z M -4 0 L 1348 0 L 1204 800 L -148 800 Z")']);
  // halfway through, the sky moves on under both the old look and the new: it is live, not a still
  const corner = {x: 20, y: 300, width: 300, height: 200};
  if (process.env.TURN_SHOT) await p.screenshot({path: process.env.TURN_SHOT});
  const a = await p.screenshot({clip: corner});
  await p.evaluate(() => { globalThis.now += 3; });
  await p.waitForTimeout(150);
  const b = await p.screenshot({clip: corner});
  assert.notDeepEqual(a, b);
  await p.evaluate(() => turns.forEach(x => x.finish()));
  await p.waitForFunction(() => !document.documentElement.classList.contains('turn'));
  assert.deepEqual(await p.evaluate(() => arrival.kept.sky.stars.material.uniforms.uColor.value.toArray().map(v => +v.toFixed(4))), [1, 0.9059, 0.8549]);
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});
