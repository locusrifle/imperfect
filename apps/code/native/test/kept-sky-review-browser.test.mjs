import test from 'node:test';
import assert from 'node:assert/strict';
import {harnessFixture} from './fixtures/harness-page.mjs';

const fixture = () => harnessFixture({site:true, viewport:{width:1024,height:640}, messages:[{role:'assistant',content:'Ready.'}]});
async function mount(p) {
  await p.evaluate(async () => {
    const {mountArrival} = await import('/js/arrival.js');
    window.now = 1760083300;
    window.arrival = mountArrival({onLock: fn => { window.tellLock = fn; fn({epoch: now-40, touched:now-30}); }}, {
      clock: () => window.now,
      load: async () => {
        const {mountKeptSky} = await import('/js/kept-sky.js');
        return {mountKeptSky: (canvas, times, options) => mountKeptSky(canvas, times, {...options, restAfter:60})};
      },
    });
  });
  await p.waitForFunction(() => arrival.kept);
}
const count = p => p.evaluate(() => window.draws);
async function countDraws(p) {
  await p.evaluate(() => {
    const gl = document.querySelector('canvas.kept-sky').getContext('webgl2'), draw = gl.drawArrays;
    window.draws = 0;
    gl.drawArrays = function(...args) { draws++; return draw.apply(this,args); };
  });
}

test('a hidden or long-unfocused sky rests; focus catches up, and disposal leaves no loop', async () => {
  const f = await fixture(), p = f.page;
  try {
    await mount(p); await countDraws(p);
    await p.evaluate(() => { tellLock(null); now += 3; });
    await p.waitForFunction(() => draws > 0, null, { timeout: 60000 });
    assert.ok(await count(p) > 0);
    await p.evaluate(() => { window.nativeFocused = true; window.imperfectDesk = {isFocused: () => nativeFocused}; dispatchEvent(new Event('blur')); });
    await p.waitForTimeout(150);
    let watched = await count(p);
    await p.waitForFunction(before => draws > before, watched, { timeout: 60000 });
    assert.ok(await count(p) > watched, 'focusing a guest browser must not stop the visible sky');
    await p.evaluate(() => { nativeFocused = false; dispatchEvent(new Event('blur')); });
    await p.waitForTimeout(150);
    let before = await count(p); await p.waitForTimeout(150);
    assert.equal(await count(p), before);
    const restingAngle = await p.evaluate(() => arrival.kept.sky.stars.material.uniforms.uTwist.value);
    await p.evaluate(() => { now += 10; dispatchEvent(new Event('focus')); });
    await p.waitForFunction(before => draws > before, before, { timeout: 60000 });
    assert.ok(await count(p) > before);
    const twist = await p.evaluate(async () => { const {twistAt} = await import('/website/sky.mjs'); return [arrival.kept.sky.stars.material.uniforms.uTwist.value, twistAt(now, {touched:1760083270, gone:1760083300})]; });
    assert.equal(twist[0], twist[1]);
    assert.ok(Math.abs(twist[0] - restingAngle + 10) < 1e-6, 'resume is the uninterrupted wall-clock angle, not a restarted or slower turn');
    const resumedRate = await p.evaluate(() => { const a = arrival.kept.sky.stars.material.uniforms.uTwist.value; now += 1; arrival.kept.frame(); return arrival.kept.sky.stars.material.uniforms.uTwist.value - a; });
    assert.equal(resumedRate, -1);
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true, value:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(100);
    before = await count(p); await p.waitForTimeout(150); assert.equal(await count(p), before);
    await p.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForFunction(before => draws > before, before, { timeout: 60000 });
    assert.ok(await count(p) > before);
    await p.evaluate(() => arrival.kept.dispose());
    before = await count(p);
    await p.evaluate(() => { dispatchEvent(new Event('resize')); dispatchEvent(new Event('focus')); });
    await p.waitForTimeout(150); assert.equal(await count(p), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('reduced motion keeps the identical frame even when time advances and a redraw is needed, and the unlock takes the sky at once', async () => {
  const f = await fixture(), p = f.page;
  try {
    await p.emulateMedia({reducedMotion:'reduce'}); await mount(p);
    const read = () => p.evaluate(() => { arrival.kept.frame(); return document.querySelector('canvas.kept-sky').toDataURL(); });
    const before = await read();
    await p.evaluate(() => { now += 27; dispatchEvent(new Event('resize')); });
    assert.equal(await read(), before);
    assert.equal(await p.evaluate(() => arrival.kept.sky.stars.material.uniforms.uTime.value), 0);
    await p.evaluate(() => tellLock(null));
    assert.equal(await p.evaluate(() => !!document.querySelector('canvas.kept-sky') || document.documentElement.classList.contains('kept-sky')), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('hidden drafts cannot bend the lock sky, and GPU context loss restores the plain app look without exposing locked UI', async () => {
  const f = await fixture(), p = f.page;
  try {
    await p.fill('#entry-input', 'a draft kept through the lock');
    await mount(p);
    const state = () => p.evaluate(() => { arrival.kept.frame(); return arrival.kept.sky.stars.material.uniforms.uAvoidCount.value; });
    assert.equal(await state(), 0);
    await p.evaluate(() => tellLock(null));
    assert.ok(await state() > 0);
    await p.evaluate(() => {
      tellLock({epoch: now-40, touched:now-30});
      document.querySelector('canvas.kept-sky').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    });
    await p.waitForFunction(() => !document.querySelector('canvas.kept-sky'));
    assert.equal(await p.evaluate(() => document.documentElement.classList.contains('kept-sky')), false);
    assert.equal(await p.evaluate(() => document.documentElement.classList.contains('locked-away')), true);
    await p.evaluate(() => tellLock(null));
    assert.equal(await p.evaluate(() => document.documentElement.classList.contains('locked-away')), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
