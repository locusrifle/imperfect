import test from 'node:test';
import assert from 'node:assert/strict';
import {harnessFixture} from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

// imperfect OS's screen lock (arrival.js, kept-sky.js): while it holds, only the lock's own sky shows, the whole
// window; as it goes, everything fades in over it, opacity only, with the sky live beneath, and then the sky fades
// to the window's plain ground: the galaxy is the lock's, not the app's. With no word of a lock, nothing changes. With
// motion unwelcome, the UI is simply there and the sky gone. Nothing about the same lock heard again, a theme or a
// new size starts the sky over.
const NOW = 1760083300;
const LOCK = {epoch: NOW - 40, touched: NOW - 30};
const black = async () => themeCss(await testTheme('black'));
const look = p => p.evaluate(() => ({
 classes: document.documentElement.className,
 sky: document.querySelectorAll('canvas.kept-sky').length,
 ui: [...document.body.children].filter(e => !e.classList.contains('kept-sky') && e.localName !== 'script' && getComputedStyle(e).display !== 'none').map(e => +getComputedStyle(e).opacity),
}));
// mount with a lock heard and the clock at `now`; tellLock(state) from then on
const mount = async (p, {lock = LOCK, now = NOW} = {}) => {
 await p.evaluate(async ({lock, now}) => {
 const {mountArrival} = await import('/js/arrival.js');
 globalThis.now = now;
 let hear; globalThis.tellLock = state => hear(state);
 globalThis.arrival = mountArrival({onLock: fn => { hear = fn; fn(lock); }}, {clock: () => globalThis.now});
 // the sky as drawn now, above the composer (whose words and cursor move the stars by them)
 globalThis.drawn = () => { arrival.kept.frame(); const gl = document.querySelector('canvas.kept-sky'), c = document.createElement('canvas'); c.width = gl.width; c.height = Math.round(gl.height * 0.6); c.getContext('2d').drawImage(gl, 0, 0); return c.toDataURL(); };
 }, {lock, now});
 await p.waitForFunction(() => arrival.kept || !document.querySelector('canvas.kept-sky'), null, { timeout: 60000 });
};

for (const way of ['fade', 'reduced motion']) test(`${way}: the UI waits off the lock's sky while locked, comes in over the live sky, and the sky goes`, async () => {
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, themeCSS: await black(), messages:[{role:'assistant',content:'Ready.'}]});
 const p = f.page;
 try {
  if (way === 'reduced motion') await p.emulateMedia({reducedMotion: 'reduce'});
  let s = await look(p);
  assert.equal(s.sky, 0); assert.ok(s.ui.every(o => o === 1), JSON.stringify(s));
  await mount(p);
  s = await look(p);
  assert.equal(s.sky, 1); assert.match(s.classes, /locked-away/); assert.match(s.classes, /kept-sky/);
  assert.ok(s.ui.length && s.ui.every(o => o === 0), JSON.stringify(s));
  // the sky draws: points of light on the theme's ground
  const lit = await p.evaluate(async () => {
   const img = new Image(); img.src = drawn(); await img.decode();
   const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
   const d = x.getImageData(0, 0, img.width, img.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 60) n++; return n;
  });
  assert.ok(lit > 300, String(lit));
  // the same lock again starts nothing over: the same canvas, the same frame; back at its painting (no touch)
  // the sky rests untwisted until the next touch, which it then follows
  await p.evaluate(() => { globalThis.before = [drawn(), document.querySelector('canvas.kept-sky')]; });
  await p.evaluate(lock => tellLock(lock), LOCK);
  assert.equal(await p.evaluate(() => drawn() === before[0] && document.querySelector('canvas.kept-sky') === before[1]), true);
  await p.evaluate(lock => tellLock({epoch: lock.epoch, touched: null}), LOCK);
  assert.deepEqual(await p.evaluate(() => [drawn() === before[0], arrival.kept.sky.stars.material.uniforms.uTwist.value]), [way === 'reduced motion', 0]);
  await p.evaluate(lock => tellLock(lock), LOCK);
  assert.equal(await p.evaluate(() => drawn() === before[0] && document.querySelector('canvas.kept-sky') === before[1]), true);
  // while the lock's stars twist it draws once a frame, never more (unless motion is unwelcome: then not at all)
  const pace = await p.evaluate(() => new Promise(done => {
   const c = document.querySelector('canvas.kept-sky').getContext('webgl2'), draw = c.drawArrays; let draws = 0, frames = 0;
   c.drawArrays = function(...a) { draws++; return draw.apply(this, a); };
   const f = () => {
    if (++frames < 12) requestAnimationFrame(f);
    else { c.drawArrays = draw; done({draws, frames}); }
   };
   requestAnimationFrame(f);
  }));
  if (way === 'reduced motion') assert.equal(pace.draws, 0, JSON.stringify(pace));
  else assert.ok(pace.draws > 0 && pace.draws <= pace.frames + 1, JSON.stringify(pace));
  await p.evaluate(() => {
   globalThis.fades = [];
   const animate = Element.prototype.animate;
   Element.prototype.animate = function(frames, options) { const a = animate.call(this, frames, options); if (frames[0]?.opacity === 0) { a.pause(); a.currentTime = 0; fades.push({el: this.id || this.className, frames, options, a}); } return a; };
   globalThis.twistAtGone = arrival.kept.sky.stars.material.uniforms.uTwist.value;
   tellLock(null);
   arrival.kept?.frame();
   globalThis.twistAfterGone = arrival.kept?.sky.stars.material.uniforms.uTwist.value;
  });
  s = await look(p);
  assert.doesNotMatch(s.classes, /locked-away/);
  if (way === 'reduced motion') {
   // motion unwelcome: the UI simply there, the sky simply gone
   assert.equal(s.sky, 0); assert.doesNotMatch(s.classes, /kept-sky/);
   assert.deepEqual(await p.evaluate(() => fades.map(b => b.el)), []); assert.ok(s.ui.every(o => o === 1));
   assert.deepEqual(f.errors, []);
   return;
  }
  assert.match(s.classes, /kept-sky/); assert.equal(s.sky, 1);
  assert.equal(await p.evaluate(() => twistAtGone), await p.evaluate(() => twistAfterGone), 'unlock changes neither the twist nor its frame');
  const rate = await p.evaluate(() => { now += 1; arrival.kept.frame(); const d = arrival.kept.sky.stars.material.uniforms.uTwist.value - twistAtGone; now -= 1; arrival.kept.frame(); return d; });
  assert.equal(rate, -1, 'same constant Countercurrent speed after unlock');
  const fades = await p.evaluate(() => fades.map(b => ({el: b.el, frames: b.frames, options: b.options})));
  assert.ok(s.ui.every(o => o === 0), JSON.stringify(s));
  assert.ok(fades.some(b => b.el === 'canvas'), JSON.stringify(fades));
  assert.ok(fades.every(b => b.el !== 'kept-sky'));
  for (const f of fades) {
   assert.deepEqual(f.frames, [{opacity:0}, {opacity:1}], 'opacity only: no clip or transform');
   assert.deepEqual(f.options, {duration:600, easing:'ease-in-out'});
  }
  await p.evaluate(() => fades.forEach(b => { b.a.currentTime = 300; }));
  assert.ok((await look(p)).ui.every(o => Math.abs(o - 0.5) < 0.001));
  await p.evaluate(() => fades.forEach(b => b.a.finish()));
  // then the sky: whole while the UI comes in, fading after it, then gone, and the window on its own ground
  const going = await p.evaluate(() => { const a = document.querySelector('canvas.kept-sky').getAnimations()[0]; return {frames: a.effect.getKeyframes().map(k => k.opacity), timing: a.effect.getTiming()}; });
  assert.deepEqual(going.frames, ['1', '0']); assert.equal(going.timing.delay, 600); assert.equal(going.timing.duration, 600);
  await p.waitForFunction(() => !document.querySelector('canvas.kept-sky') && !document.documentElement.classList.contains('kept-sky'), null, { timeout: 5000 });
  assert.equal(await p.evaluate(() => arrival.kept), null);
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});

test('a lock back before the fade has finished keeps the UI off the sky', async () => {
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, themeCSS: await black(), messages:[{role:'assistant',content:'Ready.'}]});
 try {
  await mount(f.page);
  const s = await f.page.evaluate(async lock => {
   tellLock(null);
   const finished = document.getAnimations().filter(a => a.effect?.target?.parentElement === document.body).map(a => a.finished.catch(() => {}));
   tellLock(lock);
   await Promise.all(finished);
   await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
   return {locked: document.documentElement.classList.contains('locked-away'), sky: document.querySelectorAll('canvas.kept-sky').length, turning: document.getAnimations().filter(a => a.effect?.target?.parentElement === document.body).length};
  }, LOCK);
  assert.deepEqual(s, {locked: true, sky: 1, turning: 0});
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});

test('without WebGL the lock still keeps the UI away, and the window keeps its own look', async () => {
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, themeCSS: await black(), messages:[{role:'assistant',content:'Ready.'}]});
 try {
  await f.page.evaluate(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(kind, ...rest) { return /webgl/.test(kind) ? null : get.call(this, kind, ...rest); }; });
  await mount(f.page);
  let s = await look(f.page);
  assert.equal(s.sky, 0); assert.doesNotMatch(s.classes, /kept-sky/); assert.match(s.classes, /locked-away/);
  assert.ok(s.ui.every(o => o === 0));
  await f.page.evaluate(() => tellLock(null));
  s = await look(f.page);
  assert.doesNotMatch(s.classes, /locked-away|kept-sky/);
  await f.page.waitForFunction(() => [...document.body.children]
   .filter(e => e.localName !== 'script' && getComputedStyle(e).display !== 'none')
   .every(e => +getComputedStyle(e).opacity === 1), null, { timeout: 60000 });
  assert.ok((await look(f.page)).ui.every(o => o === 1));
  assert.deepEqual(f.errors.filter(e => !/WebGL/i.test(e)), []);
 } finally { await f.close(); }
});

test('while locked a theme or a new size keeps the same sky; after the lock a reload brings none back', async () => {
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, themeCSS: await black(), messages:[{role:'assistant',content:'Ready.'}]});
 const p = f.page;
 try {
  await mount(p);
  const sky = () => p.evaluate(() => { const s = arrival.kept.sky; return {colour: s.stars.material.uniforms.uColor.value.toArray().map(v => +v.toFixed(4)), clear: '#' + s.renderer.getClearColor(new s.stars.material.uniforms.uColor.value.constructor()).getHexString(), width: s.renderer.domElement.width, first: [...s.stars.geometry.attributes.position.array.slice(0, 3)], twist: +s.stars.material.uniforms.uTwist.value.toFixed(6)}; });
  const a = await sky();
  assert.deepEqual([a.colour, a.clear], [[1, 1, 1], '#000000']);
  // the bars open to it, the panels the theme's at 80%
  const styles = await p.evaluate(() => ({ panel: getComputedStyle(document.querySelector('.entry-screen')).backgroundImage, body: getComputedStyle(document.body).backgroundColor }));
  assert.match(styles.panel, /linear-gradient\(rgba\(0, 0, 0, 0\) 72px, (color\(srgb 0 0 0 \/ 0\.8\)|rgba\(0, 0, 0, 0\.8\)) 0px\)/); assert.equal(styles.body, 'rgba(0, 0, 0, 0)');
  // a theme: its colours, the same stars and the same twist
  const cinder = themeCss(await testTheme('galaxy-cinder'));
  await p.evaluate(css => new Promise(done => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.id = 'theme-css'; link.href = 'data:text/css,' + encodeURIComponent(css); link.onload = () => requestAnimationFrame(() => done()); document.head.append(link); }), cinder);
  const b = await sky();
  assert.deepEqual(b.colour, [1, 0.9059, 0.8549]); assert.equal(b.clear, '#100c0b');
  assert.deepEqual([b.first, b.twist], [a.first, a.twist]);
  // a new size: the stars placed for it, the twist where the clock says
  await p.setViewportSize({width: 900, height: 700});
  await p.waitForFunction(() => arrival.kept.sky.renderer.domElement.width !== 1200);
  const c = await sky();
  assert.notDeepEqual(c.first, a.first); assert.equal(c.twist, a.twist);
  // the lock goes, and with it the sky; a reload after brings none back
  await p.evaluate(() => tellLock(null));
  await p.waitForFunction(() => !document.querySelector('canvas.kept-sky'), null, { timeout: 5000 });
  await p.reload();
  await mount(p, {lock: null});
  const s = await look(p);
  assert.equal(s.sky, 0); assert.doesNotMatch(s.classes, /locked-away|kept-sky/); assert.ok(s.ui.every(o => o === 1));
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});

test('framed by the website, the composer\'s words and cursor push the stars aside, and a keystroke knocks them', async () => {
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, themeCSS: await black(), messages:[{role:'assistant',content:'Ready.'}]});
 const p = f.page;
 try {
  await p.evaluate(async now => { const {mountArrival} = await import('/js/arrival.js'); globalThis.arrival = mountArrival(null, {clock: () => now, framed: () => true}); }, NOW);
  await p.waitForFunction(() => arrival.kept, null, { timeout: 60000 });
  await p.click('#entry-input');
  await p.keyboard.type('one line of words');
  const a = await p.evaluate(() => { arrival.kept.frame(); const U = arrival.kept.sky.stars.material.uniforms, m = document.querySelector('.entry-caret-mirror').getBoundingClientRect(); return {lines: arrival.kept.avoid.lines, caret: arrival.kept.avoid.caret, kicks: arrival.kept.avoid.kicks.length, count: U.uAvoidCount.value, kick: U.uKick.value[0].w, mirror: [m.left, m.top, m.right, m.bottom]}; });
  assert.equal(a.count, 1); assert.equal(a.lines.length, 1);
  const [l, t, r, b] = a.lines[0];
  assert.ok(l >= a.mirror[0] - 2 && t >= a.mirror[1] - 2 && b <= a.mirror[3] + 2 && r > l + 50, JSON.stringify(a));
  assert.ok(a.caret && a.caret[2] > 3); assert.ok(a.kicks >= 1); assert.equal(a.kick, 170);
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});

// Framed by imperfect.computer (its live product after the film): no lock, but the same sky behind the product from
// the start, as on Noah's own computer after its lock. Anywhere else unframed, nothing changes.
test('framed by the launch site: the same kept sky behind the product from the start, the UI whole over it', async () => {
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, themeCSS: await black(), messages:[{role:'assistant',content:'Ready.'}]});
 const p = f.page;
 try {
  const {framedByLaunch} = await p.evaluate(async () => {
   const {framedByLaunch} = await import('/js/arrival.js');
   const win = (origin, framed = true) => { const w = {location: {origin}}; w.parent = framed ? {} : w; return w; };
   return {framedByLaunch: [
    framedByLaunch(win('https://kinso.noah.imperfect.computer'), {referrer: 'https://imperfect.computer/'}),
    framedByLaunch(win('https://kinso.noah.imperfect.computer', false), {referrer: 'https://imperfect.computer/'}),
    framedByLaunch(win('https://kinso.noah.imperfect.computer'), {referrer: 'https://evil.example/'}),
    framedByLaunch(win('http://localhost:5100'), {referrer: 'https://imperfect.computer/'}),
   ]};
  });
  assert.deepEqual(framedByLaunch, [true, false, false, false]);
  let s = await look(p);
  assert.equal(s.sky, 0, 'unframed, no lock: nothing');
  await p.evaluate(async now => {
   const {mountArrival} = await import('/js/arrival.js');
   globalThis.arrival = mountArrival(null, {clock: () => now, framed: () => true});
  }, NOW);
  await p.waitForFunction(() => arrival.kept || !document.querySelector('canvas.kept-sky'), null, { timeout: 60000 });
  s = await look(p);
  assert.equal(s.sky, 1); assert.match(s.classes, /kept-sky/); assert.doesNotMatch(s.classes, /locked-away/);
  assert.ok(s.ui.every(o => o === 1), JSON.stringify(s));
 } finally { await f.close(); }
});
