import test from 'node:test';
import assert from 'node:assert/strict';
import { demoParentOrigin, notifyDemoReady } from '../public/js/demo-ready.js';

const NOAH = 'https://noah.imperfect.computer';
const SITE = 'https://imperfect.computer';
function fixture({ origin = NOAH, referrer = SITE, standalone = false, controls = true } = {}) {
  const messages = [], frames = [];
  const parent = { postMessage: (...args) => messages.push(args) };
  const win = { location: { origin }, parent, requestAnimationFrame: cb => frames.push(cb) };
  if (standalone) win.parent = win;
  const doc = { referrer, getElementById: () => controls ? {} : null };
  return { win, doc, messages, frames };
}
async function tick() { await Promise.resolve(); }
async function paint(f) {
  await tick();
  assert.equal(f.frames.length, 1);
  f.frames.shift()();
  assert.equal(f.frames.length, 1);
  f.frames.shift()();
  await tick();
}

test('only the actual noah demo and exact store origins are permitted', () => {
  assert.equal(demoParentOrigin(NOAH, `${SITE}/?preview=1`), SITE);
  assert.equal(demoParentOrigin(NOAH, 'https://www.imperfect.computer/'), 'https://www.imperfect.computer');
  for (const origin of ['https://desktop.imperfect.computer', 'http://noah.imperfect.computer', 'https://noah.imperfect.computer.evil.test',
    'http://north.noah.imperfect.computer', 'https://a.b.noah.imperfect.computer', 'https://-x.noah.imperfect.computer', 'https://north.noah.imperfect.computer:8443', 'https://evilnoah.imperfect.computer']) {
    assert.equal(demoParentOrigin(origin, SITE), null, origin);
  }
  // the launch page's workbenches, each its own imperfect one level under the demo's name
  assert.equal(demoParentOrigin('https://north.noah.imperfect.computer', `${SITE}/`), SITE);
  assert.equal(demoParentOrigin('https://north-2.noah.imperfect.computer', 'https://evil.test/'), null, 'still only for the site');
  for (const referrer of ['', 'not a url', 'http://imperfect.computer/', 'https://imperfect.computer.evil.test/', 'https://evil.test/?https://imperfect.computer']) {
    assert.equal(demoParentOrigin(NOAH, referrer), null);
  }
});

test('no message before connected snapshot and two paint frames', async () => {
  const f = fixture(); let connected;
  const result = notifyDemoReady(new Promise(done => { connected = done; }), f);
  await tick();
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.frames, []);
  connected();
  await tick();
  assert.deepEqual(f.messages, []);
  await paint(f);
  assert.equal(await result, true);
  assert.deepEqual(f.messages, [[{ type: 'imperfect:demo-ready' }, SITE]]);
  assert.deepEqual(Object.keys(f.messages[0][0]), ['type']);
});

test('does not announce a broken product or rejected connection', async () => {
  const failed = fixture();
  assert.equal(await notifyDemoReady(Promise.reject(new Error('offline')), failed), false);
  assert.deepEqual(failed.messages, []);
  const missing = fixture({ controls: false });
  const result = notifyDemoReady(Promise.resolve(), missing);
  await paint(missing);
  assert.equal(await result, false);
  assert.deepEqual(missing.messages, []);
});

test('private, top-level, unknown-parent and unavailable connection do nothing', async () => {
  for (const options of [{ origin: 'https://desktop.imperfect.computer' }, { standalone: true }, { referrer: 'https://elsewhere.test' }]) {
    const f = fixture(options);
    assert.equal(await notifyDemoReady(Promise.resolve(), f), false);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.frames, []);
  }
  assert.equal(await notifyDemoReady(undefined, fixture()), false);
  assert.equal(await notifyDemoReady(Promise.resolve(), { win: null, doc: null }), false);
});
