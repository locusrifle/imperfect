import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createXBox, oauthHeader, runXPost } from '../x.mjs';
import { createExtensionUI } from '../extension-ui.mjs';
import { TOOLS } from '../tools.mjs';

const KEYS = { api_key: 'key', api_secret: 'secret', access_token: 'token', access_secret: 'token-secret' };

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'x-post-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'x'), JSON.stringify(KEYS), { mode: 0o600 });
  return dir;
}

// X, as far as x_post talks to it: who the keys are, the upload in its
// steps, the video still processing once, then the post.
function fakeX() {
  const asked = [];
  let statusChecks = 0;
  const send = async (url, init) => {
    const body = init.body instanceof FormData ? { segment_index: init.body.get('segment_index'), bytes: (await init.body.get('media').arrayBuffer()).byteLength } : init.body ? JSON.parse(init.body) : null;
    asked.push({ method: init.method, url, authorization: init.headers.authorization, body });
    const reply = data => new Response(JSON.stringify({ data }), { status: 200 });
    if (url.endsWith('/2/users/me')) return reply({ id: '1', username: 'noah' });
    if (url.endsWith('/media/upload/initialize')) return reply({ id: `m${asked.filter(a => a.url.endsWith('/initialize')).length}`, expires_after_secs: 86400 });
    if (url.includes('/append')) return reply({ expires_at: 1 });
    if (url.endsWith('/finalize')) return reply({ id: 'm', processing_info: asked.findLast(a => a.url.endsWith('/initialize')).body.media_category === 'tweet_image' ? undefined : { state: 'pending', check_after_secs: 1 } });
    if (url.includes('command=STATUS')) return reply({ processing_info: { state: ++statusChecks > 1 ? 'succeeded' : 'in_progress', check_after_secs: 2 } });
    if (url.endsWith('/2/tweets')) return new Response(JSON.stringify({ data: { id: '777', text: body.text } }), { status: 201 });
    return new Response('{}', { status: 404 });
  };
  return { asked, send };
}

// The window's dialogs, answered the way the person would.
function window(answer) {
  const adapter = createExtensionUI(() => {
    for (const dialog of adapter.state.dialogs) {
      if (answered.has(dialog.id)) continue;
      answered.add(dialog.id); shown.push(dialog);
      queueMicrotask(() => adapter.respond({ id: dialog.id, ...answer(dialog) }));
    }
  });
  const answered = new Set(), shown = [];
  return { ui: adapter.ui, shown };
}

test('OAuth 1.0a signs the way X documents it (the statuses/update example)', () => {
  const header = oauthHeader({
    method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    form: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    keys: { api_key: 'xvz1evFS4wEEPTGEFPHBog', api_secret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', access_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', access_secret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958,
  });
  assert.match(header, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", /);
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
  assert.match(header, /oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"/);
});

test('x_post asks first, then uploads a video in chunks, waits for X to process it, and posts it', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'demo.mp4'), Buffer.alloc(9 * 1024 * 1024, 1));
  const { asked, send } = fakeX();
  const { ui, shown } = window(() => ({ value: 'post' }));
  const waits = [];
  const answer = await runXPost({ text: 'we made a thing', media: ['demo.mp4'], reply_to: 'https://x.com/someone/status/123', cwd, ui },
    { fetch: send, keysFile: join(cwd, 'x'), pause: async ms => { waits.push(ms); } });

  assert.equal(shown.length, 1);
  assert.equal(shown[0].method, 'select');
  assert.equal(shown[0].title, 'Post this to X as @noah?');
  assert.deepEqual(shown[0].options, ["don't post", 'post']);
  assert.match(shown[0].message, /^we made a thing\n\nwith video: demo\.mp4 \(9\.0 MB\)\n\nin reply to https:\/\/x\.com\/i\/status\/123$/);

  assert.deepEqual(asked.map(a => `${a.method} ${a.url.replace('https://api.x.com', '')}`), [
    'GET /2/users/me',
    'POST /2/media/upload/initialize',
    'POST /2/media/upload/m1/append',
    'POST /2/media/upload/m1/append',
    'POST /2/media/upload/m1/append',
    'POST /2/media/upload/m1/finalize',
    'GET /2/media/upload?command=STATUS&media_id=m1',
    'GET /2/media/upload?command=STATUS&media_id=m1',
    'POST /2/tweets',
  ]);
  assert.deepEqual(asked[1].body, { media_type: 'video/mp4', total_bytes: 9 * 1024 * 1024, media_category: 'tweet_video' });
  assert.deepEqual(asked.slice(2, 5).map(a => [a.body.segment_index, a.body.bytes]), [['0', 4194304], ['1', 4194304], ['2', 1048576]]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(asked.at(-1).body, { text: 'we made a thing', media: { media_ids: ['m1'] }, reply: { in_reply_to_tweet_id: '123' } });
  for (const a of asked) assert.match(a.authorization, /^OAuth oauth_consumer_key="key", .*oauth_token="token"/);
  assert.equal(answer, 'Posted to X as @noah: https://x.com/noah/status/777');
});

test('x_post with pictures uploads each and posts them together', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'a.png'), Buffer.alloc(10));
  await writeFile(join(cwd, 'b.jpg'), Buffer.alloc(10));
  const { asked, send } = fakeX();
  const { ui } = window(() => ({ value: 'post' }));
  await runXPost({ text: 'two', media: JSON.stringify(['a.png', 'b.jpg']), cwd, ui }, { fetch: send, keysFile: join(cwd, 'x'), pause: async () => {} });
  assert.deepEqual(asked.filter(a => a.url.endsWith('/initialize')).map(a => a.body.media_type), ['image/png', 'image/jpeg']);
  assert.equal(asked.filter(a => a.url.includes('STATUS')).length, 0);
  assert.deepEqual(asked.at(-1).body, { text: 'two', media: { media_ids: ['m1', 'm2'] } });
});

for (const [said, answer] of [["don't post", { value: "don't post" }], ['escape', { cancelled: true }]]) {
  test(`x_post answered with ${said} uploads nothing and posts nothing`, async t => {
    const cwd = await folder(t);
    await writeFile(join(cwd, 'demo.mp4'), Buffer.alloc(100));
    const { asked, send } = fakeX();
    const { ui, shown } = window(() => answer);
    const reply = await runXPost({ text: 'hello', media: ['demo.mp4'], cwd, ui }, { fetch: send, keysFile: join(cwd, 'x') });
    assert.equal(shown.length, 1);
    assert.match(reply, /^Not posted/);
    assert.match(reply, /No media was uploaded and no post was published/);
    assert.doesNotMatch(reply, /Nothing was sent/);
    assert.deepEqual(asked.map(a => a.url), ['https://api.x.com/2/users/me']);
  });
}

test('x_post stopped mid-question posts nothing', async t => {
  const cwd = await folder(t);
  const { asked, send } = fakeX();
  const stop = new AbortController();
  const adapter = createExtensionUI(() => { if (adapter.state.dialogs.length) stop.abort(); });
  const reply = await runXPost({ text: 'hello', cwd, ui: adapter.ui, signal: stop.signal }, { fetch: send, keysFile: join(cwd, 'x') });
  assert.match(reply, /^Not posted/);
  assert.equal(asked.some(a => a.url.endsWith('/tweets')), false);
});

test('x_post with no window to ask in posts nothing', async t => {
  const cwd = await folder(t);
  const { asked, send } = fakeX();
  await assert.rejects(runXPost({ text: 'hello', cwd, ui: null }, { fetch: send, keysFile: join(cwd, 'x') }), /no window here to ask/);
  assert.equal(asked.length, 0);
});

test('x_post without keys says what to make and where, and asks X nothing', async t => {
  const cwd = await folder(t);
  const { asked, send } = fakeX();
  const { ui, shown } = window(() => ({ value: 'post' }));
  const missing = join(cwd, 'credentials', 'x');
  await assert.rejects(runXPost({ text: 'hello', cwd, ui }, { fetch: send, keysFile: missing }),
    error => error.message.includes('console.x.com') && error.message.includes('Read and write') && error.message.includes(missing) && error.message.includes('"access_secret"'));
  await writeFile(join(cwd, 'half'), JSON.stringify({ api_key: 'k' }));
  await assert.rejects(runXPost({ text: 'hello', cwd, ui }, { fetch: send, keysFile: join(cwd, 'half') }), /missing api_secret, access_token, access_secret/);
  assert.equal(asked.length, 0);
  assert.equal(shown.length, 0);
});

test('x_post turns down what X would, before asking', async t => {
  const cwd = await folder(t);
  for (const name of ['a.mp4', 'b.png', 'c.txt']) await writeFile(join(cwd, name), Buffer.alloc(10));
  const { asked, send } = fakeX();
  const { ui, shown } = window(() => ({ value: 'post' }));
  const run = args => runXPost({ text: 'x', cwd, ui, ...args }, { fetch: send, keysFile: join(cwd, 'x') });
  await assert.rejects(run({ media: ['a.mp4', 'b.png'] }), /one video or one GIF on its own/);
  await assert.rejects(run({ media: ['b.png', 'b.png', 'b.png', 'b.png', 'b.png'] }), /at most 4 pictures/);
  await assert.rejects(run({ media: ['c.txt'] }), /not a video/);
  await assert.rejects(run({ media: ['gone.mp4'] }), /does not exist/);
  await assert.rejects(run({ text: '  ' }), /needs the text/);
  assert.equal(asked.length, 0);
  assert.equal(shown.length, 0);
});

test('x_post passes on what X refused, with what to do about it', async t => {
  const cwd = await folder(t);
  const { ui } = window(() => ({ value: 'post' }));
  const send = async url => url.endsWith('/users/me')
    ? new Response(JSON.stringify({ data: { username: 'noah' } }))
    : new Response(JSON.stringify({ title: 'Forbidden', detail: 'Your client app is not configured with the appropriate oauth1 app permissions for this endpoint.' }), { status: 403 });
  await assert.rejects(runXPost({ text: 'hello', cwd, ui }, { fetch: send, keysFile: join(cwd, 'x') }), /Read and write.*regenerate the access token/);
});

test('both harnesses are handed x_post', () => {
  assert.ok(TOOLS.some(([tool]) => tool.name === 'x_post'));
});

test('x_post uploads the attachment held for approval even if its path changes during the dialog', async t => {
  const cwd = await folder(t);
  const file = join(cwd, 'a.png');
  await writeFile(file, 'approved');
  const { asked, send } = fakeX();
  let uploaded;
  const ui = { select: async () => { await writeFile(file, 'different'); return 'post'; } };
  await runXPost({ text: 'hello', media: ['a.png'], cwd, ui }, {
    keysFile: join(cwd, 'x'),
    fetch: async (url, init) => {
      if (url.includes('/append')) uploaded = Buffer.from(await init.body.get('media').arrayBuffer()).toString();
      return send(url, init);
    },
  });
  assert.equal(uploaded, 'approved');
  assert.equal(asked.find(a => a.url.endsWith('/initialize')).body.total_bytes, 8);
});

// The box: a computer holding the keys, answering /x/ for the others, its X
// faked. `seen` is what reached it, in order.
async function box(t, { keys = true } = {}) {
  const dir = await folder(t);
  const keysFile = keys ? join(dir, 'x') : join(dir, 'none', 'x');
  const x = fakeX();
  const seen = [];
  const handle = createXBox({ keysFile, fetch: x.send, pause: async () => {} });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://box');
    seen.push(`${req.method} ${url.pathname}`);
    if (!await handle(req, res, url.pathname, url.search)) res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, x, keysFile, where: async () => ({ url, name: 'desktop' }) };
}

test('a computer without keys posts through the box: asked in its own window, media sent only after yes', async t => {
  const pc = await box(t);
  const cwd = await mkdtemp(join(tmpdir(), 'x-laptop-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'demo.mp4'), Buffer.alloc(5 * 1024 * 1024, 2));
  let atQuestion;
  const ui = { select: async (title, options, { message }) => { atQuestion = { title, message, seen: [...pc.seen] }; return 'post'; } };
  const answer = await runXPost({ text: 'from the laptop', media: ['demo.mp4'], reply_to: '42', cwd, ui },
    { keysFile: join(cwd, 'credentials', 'x'), box: pc.where });

  assert.equal(atQuestion.title, 'Post this to X as @noah?');
  assert.match(atQuestion.message, /^from the laptop\n\nwith video: demo\.mp4 \(5\.0 MB\)/);
  assert.deepEqual(atQuestion.seen, ['POST /x/me']);
  assert.deepEqual(pc.seen, ['POST /x/me', 'POST /x/media', 'POST /x/tweet']);
  const initialize = pc.x.asked.find(a => a.url.endsWith('/initialize'));
  assert.deepEqual(initialize.body, { media_type: 'video/mp4', total_bytes: 5 * 1024 * 1024, media_category: 'tweet_video' });
  assert.deepEqual(pc.x.asked.at(-1).body, { text: 'from the laptop', media: { media_ids: ['m1'] }, reply: { in_reply_to_tweet_id: '42' } });
  for (const a of pc.x.asked) assert.match(a.authorization, /oauth_consumer_key="key"/);
  assert.equal(answer, 'Posted to X as @noah: https://x.com/noah/status/777');
});

test('declined on a computer without keys, the box hears only who the account is', async t => {
  const pc = await box(t);
  const cwd = await folder(t);
  await writeFile(join(cwd, 'a.png'), Buffer.alloc(10));
  const reply = await runXPost({ text: 'no', media: ['a.png'], cwd, ui: { select: async () => "don't post" } },
    { keysFile: join(cwd, 'missing'), box: pc.where });
  assert.match(reply, /^Not posted/);
  assert.deepEqual(pc.seen, ['POST /x/me']);
  assert.deepEqual(pc.x.asked.map(a => a.url), ['https://api.x.com/2/users/me']);
});

test('keys here are used here, without asking the box', async t => {
  const pc = await box(t);
  const cwd = await folder(t);
  const { asked, send } = fakeX();
  await runXPost({ text: 'local', cwd, ui: { select: async () => 'post' } }, { fetch: send, keysFile: join(cwd, 'x'), box: pc.where });
  assert.deepEqual(pc.seen, []);
  assert.equal(asked.at(-1).body.text, 'local');
});

test('without keys, x_post says where the box is: away, or itself without keys', async t => {
  const cwd = await folder(t);
  const ui = { select: async () => assert.fail('asked without an account') };
  await assert.rejects(runXPost({ text: 'hi', cwd, ui }, { keysFile: join(cwd, 'missing'), box: async () => ({ url: '', name: 'desktop' }) }),
    /X keys are kept on desktop, and this computer cannot reach it right now, so nothing was posted/);
  const empty = await box(t, { keys: false });
  await assert.rejects(runXPost({ text: 'hi', cwd, ui }, { keysFile: join(cwd, 'missing'), box: empty.where }),
    error => error.message.startsWith('desktop, which keeps the X keys, answered: This computer has no X keys yet')
      && error.message.includes(empty.keysFile) && error.message.includes('one box of keys'));
  assert.equal(empty.x.asked.length, 0);
  // On the box itself (or a computer on its own), the old answer: make them here.
  await assert.rejects(runXPost({ text: 'hi', cwd, ui }, { keysFile: join(cwd, 'missing'), box: async () => null }),
    error => error.message.includes(join(cwd, 'missing')) && error.message.includes('one box of keys'));
});

test('the box answers only an exact origin, and only what X would take', async t => {
  const pc = await box(t);
  const post = (path, body, headers = { origin: pc.url }) => fetch(`${pc.url}${path}`, { method: 'POST', headers, body });
  assert.equal((await post('/x/me', '{}', {})).status, 403);
  assert.equal((await fetch(`${pc.url}/x/me`, { headers: { origin: pc.url } })).status, 404);
  assert.equal((await post('/x/media?name=a.txt', 'x')).status, 400);
  // Too big is refused; the box may hang up before the rest has been sent.
  assert.ok([413, 'hung up'].includes(await post('/x/media?name=a.png', Buffer.alloc(6 * 1024 * 1024)).then(res => res.status, () => 'hung up')));
  assert.equal((await post('/x/tweet', JSON.stringify({ text: ' ' }))).status, 400);
  assert.equal((await post('/x/tweet', JSON.stringify({ text: 'x', media_ids: ['../2/tweets'] }))).status, 400);
  assert.equal((await post('/x/tweet', JSON.stringify({ text: 'x', reply: 'https://x.com' }))).status, 400);
  assert.equal(pc.x.asked.length, 0);
  const posted = await post('/x/tweet', JSON.stringify({ text: 'ok', media_ids: [], reply: null }));
  assert.deepEqual(await posted.json(), { id: '777' });
});
