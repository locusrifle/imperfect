import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer, pageSnapshot, WEBSITE_SKY } from '../../../../system/server.mjs';

const runtime = () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/tmp', messages: [] }), command: async () => ({}), close: async () => {} });

test('the window links its files by build, and those are kept for a year; the files themselves, as the server started with them, are the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-assets-'));
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: runtime() });
  try {
    const addr = await app.listen();
    const base = `http://127.0.0.1:${addr.port}`;
    const { build, files } = await pageSnapshot(new URL('../public', import.meta.url).pathname, new URL('../../../../website', import.meta.url).pathname);
    assert.match(build, /^[a-f0-9]{12}$/);
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const html = await page.text();
    assert.match(html, new RegExp(`<script type="module" src="/b/${build}/js/site.js"></script>`));
    assert.match(html, new RegExp(`href="/b/${build}/css/imperfect.css"`));
    assert.doesNotMatch(html, /"\/(js|css)\//, 'nothing the page links is left unversioned');
    const versioned = await fetch(`${base}/b/${build}/js/site.js`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(versioned.headers.get('content-type'), /^text\/javascript/);
    const plain = await fetch(`${base}/js/site.js`);
    assert.equal(plain.headers.get('cache-control'), 'no-cache');
    assert.equal(await plain.text(), await versioned.text());
    assert.equal((await fetch(`${base}/b/${build}/../js/site.js`)).status, 404);
    assert.equal((await fetch(`${base}/b/${build}/js/nope.js`)).status, 404);
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/js/pages.js`)).arrayBuffer()), files.get('/js/pages.js'), 'served from what it read when it started');
    // The website's sky (what imperfect OS's lock leaves behind the window), by build too; nothing else of the
    // website, or of anything beside it
    assert.deepEqual(WEBSITE_SKY, ['sky.mjs', 'stars.mjs', 'bootup.mjs', 'bootup-envelope.mjs', 'vendor/three.module.js', 'vendor/three.core.js']);
    for (const name of WEBSITE_SKY) {
      const sky = await fetch(`${base}/b/${build}/website/${name}`);
      assert.equal(sky.status, 200, name);
      assert.match(sky.headers.get('content-type'), /^text\/javascript/);
      assert.deepEqual(Buffer.from(await sky.arrayBuffer()), files.get(`/website/${name}`));
    }
    for (const name of ['scene.mjs', 'index.html', 'opener/opener.mjs', 'reveal.mjs', 'assets/sound/bootup.webm', 'assets/sound/bootup.m4a', 'assets/cutouts/manifest.json', '../system/server.mjs', '%2e%2e/package.json', 'vendor/THREE-LICENSE']) {
      assert.equal((await fetch(`${base}/website/${name}`)).status, 404, name);
      assert.equal((await fetch(`${base}/b/${build}/website/${name}`)).status, 404, name);
    }
    // Raw HTTP paths avoid fetch's normalisation hiding traversal attempts from the server.
    const raw = path => new Promise((done, fail) => get(base, {path}, res => { res.resume(); res.on('end', () => done(res.statusCode)); }).on('error', fail));
    for (const path of ['/website/../package.json', '/website/%2e%2e%2fpackage.json', '/website/%252e%252e/package.json', '/website/vendor/../../package.json', '/website/sky.mjs/extra', '/website/%00sky.mjs', '/home/vaita/AGENTS.md', '/website/scene.mjs?file=sky.mjs']) {
      assert.ok([400, 404].includes(await raw(path)), path);
      assert.ok([400, 404].includes(await raw(`/b/${build}${path}`)), path);
    }
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/website/sky.mjs?file=../../package.json`)).arrayBuffer()), files.get('/website/sky.mjs'), 'a query changes no asset path');
    // What the stylesheets and modules name is relative, so it inherits the build.
    for (const name of ['guey', 'entry-terminal', 'imperfect']) assert.doesNotMatch(await (await fetch(`${base}/css/${name}.css`)).text(), /url\(["']?\//);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('the shared sky files cannot redirect through symlinks into home or the rest of the repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-sky-links-'));
  const publicDir = join(root, 'public'), website = join(root, 'website');
  try {
    await mkdir(publicDir); await mkdir(join(website, 'vendor'), {recursive: true});
    for (const name of WEBSITE_SKY) await writeFile(join(website, name), 'export {};');
    await writeFile(join(root, 'private'), 'private fixture, not an asset');
    await symlink(join(root, 'private'), join(website, 'not-allowed.mjs'));
    const snap = await pageSnapshot(publicDir, website);
    assert.deepEqual([...snap.files.keys()], WEBSITE_SKY.map(name => `/website/${name}`));
    await rm(join(website, 'sky.mjs'));
    await symlink(join(root, 'private'), join(website, 'sky.mjs'));
    await assert.rejects(pageSnapshot(publicDir, website), /symlink/);
    await rm(join(website, 'sky.mjs')); await writeFile(join(website, 'sky.mjs'), 'export {};');
    await rm(join(website, 'vendor'), {recursive: true});
    await mkdir(join(root, 'outside'));
    for (const name of ['three.module.js', 'three.core.js']) await writeFile(join(root, 'outside', name), 'private fixture');
    await symlink(join(root, 'outside'), join(website, 'vendor'));
    await assert.rejects(pageSnapshot(publicDir, website), /symlink/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a picture in the conversation reaches the window as an address, kept for good; the model keeps the bytes', async () => {
  const { default: WebSocket } = await import('ws');
  const root = await mkdtemp(join(tmpdir(), 'imperfect-media-'));
  const bytes = Buffer.from('not really a png');
  const picture = { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
  const prompt = { role: 'user', content: [{ type: 'text', text: 'look' }, picture] };
  const plain = { role: 'assistant', content: [{ type: 'text', text: 'seen' }] };
  const fake = { ...runtime(), snapshot: () => ({ sessionId: 's', cwd: '/tmp', messages: [prompt, plain] }) };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: fake });
  try {
    const addr = await app.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    const first = JSON.parse(await new Promise(resolve => ws.once('message', raw => resolve(String(raw)))));
    const [shown, same] = first.data.messages;
    assert.equal(shown.content[1].data, undefined);
    assert.equal(shown.content[1].mimeType, 'image/png');
    assert.match(shown.content[1].url, /^\/media\/[a-f0-9]{64}$/);
    assert.deepEqual(same, plain);
    assert.equal(picture.data, bytes.toString('base64'), 'the runtime still holds the bytes');
    const got = await fetch(`http://127.0.0.1:${addr.port}${shown.content[1].url}`);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'not really a png');
    assert.equal((await fetch(`http://127.0.0.1:${addr.port}/media/${'0'.repeat(64)}`)).status, 404);
    ws.close();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
