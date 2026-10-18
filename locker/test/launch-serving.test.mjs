import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { createLockerServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { config as launch } from '../../website/launch-config.mjs';

const SITE = fileURLToPath(new URL('../../website/', import.meta.url));
const website = path => readFile(new URL('../../website/' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The configured launch film (v8 "let's begin."). Pin its SHA-256 here once the cut is final.
const FILM = relative(SITE, fileURLToPath(launch.videoUrl));

test('launch ships the configured fast-start film (moov before mdat) at a same-origin media path', async () => {
  assert.equal(FILM, 'media/v8-lets-begin.mp4');
  const film = await website(FILM);
  assert.ok(film.length > 0);
  const atoms = [];
  for (let offset = 0; offset < film.length;) {
    let size = film.readUInt32BE(offset);
    const type = film.toString('ascii', offset + 4, offset + 8);
    if (size === 1) size = Number(film.readBigUInt64BE(offset + 8));
    if (size === 0) size = film.length - offset;
    assert.ok(size >= 8 && offset + size <= film.length);
    atoms.push(type); offset += size;
  }
  assert.ok(atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'));
});

test('both adapters import the same boot and its one scroll implementation, without copy-equality', async () => {
  const lock = await readFile(new URL('../../desktop/lock/lock.mjs', import.meta.url), 'utf8');
  const site = (await website('intro/intro.mjs')).toString();
  assert.match(lock, /from '\.\.\/\.\.\/website\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  assert.match(site, /from '\.\.\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  const sequence = (await website('boot/sequence.mjs')).toString();
  assert.match(sequence, /from '\.\/scroll\.mjs(?:\?v=[^']+)?'/);
  assert.match(sequence, /centred: true/);
  assert.doesNotMatch(site + sequence, /window\.lock|messageHandlers|S\.typed/);
  const siteScroll = await import('../../website/boot/scroll.mjs');
  const run = (module, events) => {
    const target = new EventTarget(), moved = [];
    let now = 0;
    const momentum = module.createMomentum();
    module.bindLockScroll({ active: () => true, height: () => 800, move: px => moved.push(px), momentum, clock: () => now, target });
    for (const [type, at, detail] of events) {
      now = at;
      if (type === 'step') { moved.push(momentum.step(now, 1 / 60)); continue; }
      const event = new Event(type, { cancelable: true });
      Object.assign(event, detail);
      target.dispatchEvent(event);
    }
    return moved.map(px => +px.toFixed(6));
  };
  const finger = y => ({ touches: [{ identifier: 1, clientY: y }] });
  const events = [
    ['wheel', 0, { deltaY: 40, deltaX: 0, deltaMode: 0 }], ['wheel', .016, { deltaY: 36, deltaX: 0, deltaMode: 0 }], ['step', .3],
    ['wheel', 1, { deltaY: -50, deltaX: 0, deltaMode: 0 }], ['wheel', 1.02, { deltaY: -3, deltaX: 0, deltaMode: 1 }], ['step', 1.3], ['step', 1.32],
    ['wheel', 2, { deltaY: 5, deltaX: 30, deltaMode: 0 }],
    ['touchstart', 3, finger(600)], ['touchmove', 3.02, finger(560)], ['touchmove', 3.04, finger(590)], ['touchmove', 3.06, finger(520)], ['touchend', 3.08, { touches: [] }], ['step', 3.3],
    ['touchstart', 4, finger(300)], ['touchmove', 4.02, finger(340)], ['touchmove', 4.04, finger(400)], ['touchend', 4.06, { touches: [] }], ['step', 4.3],
  ];
  assert.ok(run(siteScroll, events).some(px => px < 0), 'shared scroll includes moving apart');
  assert.deepEqual(run(siteScroll, [['wheel', 0, { deltaY: -40, deltaX: 0, deltaMode: 0 }], ['wheel', 1, { deltaY: 40, deltaX: 0, deltaMode: 0 }]]), [-16, 16], 'a wheel up moves them apart, down together, 0.4x a finger (a desk was too quick)');
  assert.deepEqual(run(siteScroll, [['touchstart', 0, finger(600)], ['touchmove', .02, finger(550)], ['touchmove', .04, finger(500)]]), [50, 50], 'a finger moving up brings them together');
  const down = run(siteScroll, [['touchstart', 0, finger(300)], ['touchmove', .02, finger(350)], ['touchmove', .04, finger(420)], ['touchend', .06, { touches: [] }], ['step', .3]]);
  assert.deepEqual(down.slice(0, 2), [-50, -70], 'a finger moving down moves them apart'); assert.ok(down[2] < 0, 'and coasts on, the same feel');
});

test('existing static locker serves launch modules and exact MP4 byte ranges with configured narrow CSP', async t => {
  // Ephemeral test fixture only, not a dev preview server; no billing/provider/network integration.
  const store = openStore();
  const app = await createLockerServer({ store, mail:{ configured:false, async send() { throw new Error('No mail in static tests'); } },
    config:{ secure:false, hosts:'launch.test', demoOrigin:'https://noah.imperfect.computer' }, websiteDir:SITE, port:0,
    log:{ info() {}, warn() {}, error() {} } });
  const address = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname:'127.0.0.1', port:address.port, path, headers:{ host:'launch.test', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const front = await get('/');
  assert.equal(front.status, 200); assert.deepEqual(front.body, await website('index.html'));
  assert.match(front.headers['content-security-policy'], /frame-src 'self' https:\/\/noah\.imperfect\.computer;/);
  assert.doesNotMatch(front.headers['content-security-policy'], /unsafe-inline|\*/);
  assert.equal(front.headers['referrer-policy'], 'same-origin');
  assert.match(front.body.toString(), /referrerpolicy="strict-origin-when-cross-origin"/);
  for (const path of ['/launch.mjs','/launch-config.mjs','/media.mjs','/intro/intro.mjs','/boot/sequence.mjs','/boot/scroll.mjs','/mac/desktop.mjs','/mac/shell.mjs','/mac/phone.mjs','/shop.mjs']) {
    const response = await get(path); assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  }
  const phoneVoice = await get('/mac/sounds/line-phone.m4a');
  assert.equal(phoneVoice.status, 200); assert.equal(phoneVoice.headers['content-type'], 'audio/mp4');
  assert.deepEqual(phoneVoice.body, await website('mac/sounds/line-phone.m4a'));
  const voices = await get('/mac/sounds/voice.json');
  assert.equal(voices.status, 200);
  assert.ok(JSON.parse(voices.body).lines.some(line => line.voice === 'mac/sounds/line-phone.m4a' && line.text === "And it's on your phone."));
  const film = await website(FILM);
  const full = await get('/' + FILM);
  assert.equal(full.status, 200); assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes'); assert.equal(sha(full.body), sha(film));
  const mid = Math.floor(film.length / 2);
  for (const [range, start, end] of [['bytes=0-99',0,99], [`bytes=${mid}-${mid + 99}`,mid,mid + 99], ['bytes=-64',film.length-64,film.length-1]]) {
    const response = await get('/' + FILM, { range });
    assert.equal(response.status, 206); assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${film.length}`);
    assert.deepEqual(response.body, film.subarray(start,end+1));
  }
  const invalid = await get('/' + FILM, { range:`bytes=${film.length}-` });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers['content-range'], `bytes */${film.length}`);
  assert.equal((await get('/host.html')).status, 200);
  const shopHTML = await readFile(new URL('../public/store/shop.html', import.meta.url));
  for (const path of ['/shop', '/shop?os=mac', '/shop?os=linux', '/shop?os=windows', '/shop?os=mobile']) {
    const page = await get(path);
    assert.equal(page.status, 200, `${path}: the Shop is a real standalone page`);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.deepEqual(page.body, shopHTML);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'(?: [^;]+)?;/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|\*/);
    assert.doesNotMatch(page.body.toString(), /<iframe\b|mac\/|<script\b[^>]*>\s*[^<\s]/i);
  }
  for (const [path, type] of [['/shop.js', 'text/javascript; charset=utf-8'], ['/shop.css', 'text/css; charset=utf-8'], ['/shop-platform.mjs', 'text/javascript; charset=utf-8'], ['/shop-thanks.js', 'text/javascript; charset=utf-8']]) {
    const asset = await get(path);
    assert.equal(asset.status, 200, path);
    assert.equal(asset.headers['content-type'], type, `${path}: executable under nosniff and strict CSP`);
    assert.deepEqual(asset.body, await readFile(new URL('../public/store' + path, import.meta.url)));
  }
  for (const path of ['/buy', '/buy.html', '/rent.html']) {
    const moved = await get(path);
    assert.equal(moved.status, 302); assert.equal(moved.headers.location, '/');
  }
  for (const path of ['/world.html', '/galaxy.mjs', '/media/v4-launch.mp4', '/mac/app.html', '/mac/browser-page.webp', '/mac/shop.mjs', '/mac/shop.css']) assert.equal((await get(path)).status, 404, `${path}: gone`);
  // The lock's door: with no lock file every password is refused, the same as a wrong one.
  const unlock = await get('/unlock'); assert.equal(unlock.status, 401); assert.deepEqual(JSON.parse(unlock.body), { ok:false });
});
