import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve, fixture, fixtureResponse } from '../../tools/gui-preview.mjs';

async function windowFixture(t, agent = 'claude', { phone = true } = {}) {
  const { server, sockets, port } = await serve('', { empty: true, agent });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(async () => { await browser.close(); for (const socket of sockets.clients) socket.terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(phone ? { viewport: { width: 430, height: 850 }, isMobile: true, hasTouch: true } : { viewport: { width: 1200, height: 900 } });
  await page.addInitScript(() => {
    window.micPermissionPending = false;
    window.micPermissionRequests = 0;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {
      window.micPermissionRequests++;
      const stream = { getTracks: () => [{ stop() {} }] };
      return window.micPermissionPending ? new Promise(resolve => { window.allowMic = () => resolve(stream); }) : Promise.resolve(stream);
    } } });
    // Each recording says which one it is, so the words heard can say so too.
    window.recordings = 0;
    window.MediaRecorder = class { static isTypeSupported() { return true; } start() {} stop() { this.ondataavailable({ data: new Blob([`recording ${++window.recordings}`], { type: 'audio/webm' }) }); this.onstop(); } };
  });
  const owners = new Map();
  let refuseFocus = false;
  for (const owner of ['pc', 'laptop']) {
    const snap = fixture({ empty: true, agent });
    snap.instanceId = `${owner}-host-1`;
    snap.sessionId = null;
    snap.tabs[0].sessionId = null;
    owners.set(owner, { snap, socket: null });
  }
  const view = (owner, tab = 'mirror') => {
    const entry = owners.get(owner), snap = structuredClone(entry.snap);
    snap.tabs.forEach(item => { item.focused = item.id === tab; });
    snap.sessionId = snap.tabs.find(item => item.focused)?.sessionId ?? null;
    return snap;
  };
  await page.route('**/machines.json', route => route.fulfill({ json: { machines: [
    { id: 'pc', name: 'PC', self: true, reachable: true }, { id: 'laptop', name: 'Laptop', reachable: true },
  ] } }));
  await page.routeWebSocket(/\/pi$/, socket => {
    const owner = socket.url().includes('/peer/laptop/') ? 'laptop' : 'pc';
    const entry = owners.get(owner);
    entry.socket = socket;
    let tab = 'mirror';
    socket.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'prompt') prompts.push({ owner, tab, text: message.text, attachments: message.attachments ?? [] });
      let data = fixtureResponse(message);
      if (message.type === 'snapshot') data = view(owner, tab);
      if (message.type === 'tab-focus' && refuseFocus) {
        socket.send(JSON.stringify({ type: 'response', id: message.id, success: false, error: 'fixture focus failed' }));
        return;
      }
      if (message.type === 'tab-focus') {
        tab = message.tabId;
        data = { ...view(owner, tab).tabs.find(item => item.id === tab), snapshot: view(owner, tab) };
      }
      socket.send(JSON.stringify({ type: 'response', id: message.id, success: true, data }));
    });
    socket.send(JSON.stringify({ type: 'snapshot', data: view(owner) }));
  });
  const prompts = [], uploads = [], heard = [];
  // An upload's reference names what was uploaded; the words heard name it
  // back, so each stand-in's words can be told apart.
  await page.route('**/upload', route => {
    const bytes = route.request().postDataBuffer()?.toString();
    uploads.push({ url: route.request().url(), headers: route.request().headers(), bytes });
    return route.fulfill({ json: { path: '/fixture/plan.txt', size: 4, reference: { name: `saved ${bytes}`, sessionId: null } } });
  });
  const refusing = new Set(), holding = new Map();
  await page.route('**/transcribe', async route => {
    const body = route.request().postDataJSON(), name = body.audio.name.replace(/^saved /, '');
    heard.push({ url: route.request().url(), name, tab: body.tab, instanceId: body.instanceId });
    await holding.get(name)?.promise;
    if (refusing.has(name)) return route.fulfill({ status: 503, json: { error: 'the PC, which hears the mic, cannot be reached right now' } });
    await route.fulfill({ json: { text: `words of ${name}`, seconds: 1 } });
  });
  await page.goto(`http://127.0.0.1:${port}/?face=code`);
  await page.waitForSelector('[data-owner="pc"][data-tab-id="mirror"]');
  const mic = page.locator('.entry-voice[data-state]');
  const wait = state => page.waitForFunction(state => document.querySelector('.entry-voice[data-state]')?.dataset.state === state, state);
  const select = async (owner, tab) => {
    await page.locator(`[data-owner="${owner}"][data-tab-id="${tab}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#entry-output').classList.contains('entry-switching'));
    // tab focus is acknowledged before the transition callback settles.
    await page.waitForTimeout(100);
  };
  const push = (owner, tab = 'mirror') => owners.get(owner).socket.send(JSON.stringify({ type: 'snapshot', data: view(owner, tab) }));
  const bar = page.locator('#entry-input');
  // Record one: press, and press again.
  const record = async () => { await mic.click(); await wait('recording'); await mic.click(); await wait('idle'); };
  const chips = () => page.locator('.entry-pending-chip').allTextContents();
  const send = async () => { await bar.focus(); await page.keyboard.press('Enter'); };
  return { page, mic, bar, record, chips, send, prompts, uploads, heard, wait, select, push, owners,
    refuseFocus: value => { refuseFocus = value; },
    refuse: (name, value = true) => { if (value) refusing.add(name); else refusing.delete(name); },
    hold: name => { const held = Promise.withResolvers(); holding.set(name, held); return () => { holding.delete(name); held.resolve(); }; } };
}

// The mic's second press puts the recording in the bar as "audio 1", at the
// cursor, the way a picture stands in as "image 1". Nothing is sent until the
// message is; then each recording's words, heard on the PC meanwhile, take
// the place of its stand-in.
for (const agent of ['claude', 'pi']) test(`a ${agent} recording stands in the bar as "audio 1" at the cursor, is heard at once, and nothing is sent until the message is`, async t => {
  const { page, bar, record, chips, prompts, uploads, heard, hold } = await windowFixture(t, agent, { phone: false });
  await bar.fill('turn off  please');
  await bar.evaluate(input => input.setSelectionRange(9, 9));
  const release = hold('recording 1');
  await record();
  assert.equal(await bar.inputValue(), 'turn off audio 1  please');
  await page.waitForFunction(() => document.querySelector('.entry-pending-chip')?.textContent === '(audio 1)hearing…');
  release();
  await page.waitForFunction(() => document.querySelector('.entry-pending-chip')?.textContent === '(audio 1)');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bytes, 'recording 1');
  assert.equal(uploads[0].headers['x-instance-id'], 'pc-host-1');
  assert.deepEqual(heard.map(item => item.name), ['recording 1'], 'heard as soon as it stopped');
  assert.equal(heard[0].tab, 'mirror');
  assert.equal(prompts.length, 0, 'stopping does not send');
  await page.locator('#entry-input').press('End');
  await page.keyboard.type(' and then');
  await record();
  assert.equal(await bar.inputValue(), 'turn off audio 1  please and then audio 2 ');
  assert.equal(prompts.length, 0);
});

test('sending puts each recording\'s words in place of its stand-in, as one message beside a picture', async t => {
  const { page, bar, record, send, prompts, heard } = await windowFixture(t, 'claude', { phone: false });
  await bar.fill('first ');
  await record();
  await page.keyboard.type('then ');
  await page.locator('#entry-files').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('a picture') });
  await page.keyboard.type('and ');
  await record();
  assert.equal(await bar.inputValue(), 'first audio 1 then image 1 and audio 2 ');
  await page.waitForFunction(() => [...document.querySelectorAll('.entry-pending-chip')].every(chip => !/hearing|%/.test(chip.textContent)));
  await send();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, 'first words of recording 1 then image 1 and words of recording 2');
  assert.deepEqual(prompts[0].attachments.map(item => item.kind), ['image'], 'only the picture goes as a file; the recordings went as words');
  assert.equal(heard.length, 2, 'each recording heard once');
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
});

test('a recording still being heard is waited for when the message is sent', async t => {
  const { page, bar, record, send, prompts, hold } = await windowFixture(t, 'claude', { phone: false });
  const release = hold('recording 1');
  await record();
  await send();
  await page.waitForTimeout(150);
  assert.equal(prompts.length, 0, 'not sent before its words');
  assert.equal(await bar.inputValue(), 'audio 1 ');
  release();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.deepEqual(prompts.map(item => item.text), ['words of recording 1']);
});

test('deleting the words "audio 1" drops that recording, and the numbers are the bar\'s own', async t => {
  const { page, bar, record, chips, send, prompts } = await windowFixture(t, 'claude', { phone: false });
  await record();
  await record();
  assert.equal(await bar.inputValue(), 'audio 1 audio 2 ');
  // Backspace into the first stand-in takes it, and its recording, whole.
  await bar.evaluate(input => input.setSelectionRange(8, 8));
  await page.keyboard.press('Backspace');
  assert.equal(await bar.inputValue(), 'audio 2 ');
  assert.deepEqual((await chips()).map(text => text.replace(/hearing…$/, '')), ['(audio 2)']);
  await bar.evaluate(input => input.setSelectionRange(0, 0));
  await record();
  assert.equal(await bar.inputValue(), 'audio 1 audio 2 ', 'the free number is used again');
  // Cutting a stand-in out with a selection drops it too.
  await bar.evaluate(input => { input.setSelectionRange(8, 16); });
  await page.keyboard.press('Delete');
  assert.equal(await bar.inputValue(), 'audio 1 ');
  assert.equal(await page.locator('.entry-pending-chip').count(), 1);
  await send();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.deepEqual(prompts.map(item => item.text), ['words of recording 3']);
});

test('a recording that cannot be heard keeps the whole bar, says which one, and sending again tries it again', async t => {
  const { page, bar, record, chips, send, prompts, heard, refuse } = await windowFixture(t, 'claude', { phone: false });
  refuse('recording 2');
  await bar.fill('before ');
  await record();
  await page.keyboard.type('middle ');
  await record();
  await page.waitForFunction(() => /not heard/.test(document.querySelector('.entry-pending-chip:last-child')?.textContent));
  await send();
  await page.waitForFunction(() => /audio 2 could not be heard/.test(document.querySelector('#entry-flash')?.textContent));
  assert.match(await page.locator('#entry-flash').textContent(), /cannot be reached right now.*nothing was sent/);
  assert.equal(prompts.length, 0);
  assert.equal(await bar.inputValue(), 'before audio 1 middle audio 2 ', 'everything stays in the bar');
  assert.deepEqual(await chips(), ['(audio 1)', '×', '(audio 2)not heard · retry']);
  assert.equal(await bar.evaluate(input => input.readOnly), false, 'and can be edited again');
  refuse('recording 2', false);
  await send();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.deepEqual(prompts.map(item => item.text), ['before words of recording 1 middle words of recording 2']);
  assert.equal(heard.filter(item => item.name === 'recording 1').length, 1, 'a heard recording is not heard again');
  assert.equal(heard.filter(item => item.name === 'recording 2').length, 3, 'heard when it stopped, on the failed send, and on the next');
});

test('a recording belongs to the draft it was started in, and stays there across switching sessions and computers', async t => {
  const { page, bar, mic, wait, select, send, prompts, uploads } = await windowFixture(t, 'claude', { phone: false });
  await bar.fill('for the mirror tab');
  await mic.click(); await wait('recording');
  await select('laptop', 'mirror');
  await bar.fill('laptop draft');
  await mic.click(); await wait('idle');
  assert.equal(await bar.inputValue(), 'laptop draft', 'it did not land in the draft in view');
  assert.doesNotMatch(uploads[0].url, /\/peer\/laptop\//, 'uploaded to the computer it was recorded for');
  await select('pc', 'mirror');
  assert.equal(await bar.inputValue(), 'for the mirror tab audio 1 ');
  await page.waitForFunction(() => document.querySelector('.entry-pending-chip')?.textContent === '(audio 1)');
  await select('pc', 'other');
  await select('pc', 'mirror');
  assert.equal(await bar.inputValue(), 'for the mirror tab audio 1 ', 'kept across a switch, like the rest of the draft');
  assert.equal(await page.locator('.entry-pending-chip').count(), 1);
  await send();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.deepEqual(prompts.map(({ owner, text }) => ({ owner, text })), [{ owner: 'pc', text: 'for the mirror tab words of recording 1' }]);
});

test('an audio file attached with + stands in the same way, and is heard on send', async t => {
  const { page, bar, send, prompts, select, uploads } = await windowFixture(t, 'claude', { phone: false });
  await select('laptop', 'mirror');
  await bar.fill('notes from ');
  await page.locator('#entry-files').setInputFiles({ name: 'meeting.wav', mimeType: 'audio/wav', buffer: Buffer.from('the meeting') });
  assert.equal(await bar.inputValue(), 'notes from audio 1 ');
  assert.match(uploads[0].url, /\/peer\/laptop\/upload$/);
  await send();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.deepEqual(prompts.map(({ owner, text }) => ({ owner, text })), [{ owner: 'laptop', text: 'notes from words of the meeting' }]);
});

test('Esc while recording, or while the microphone is being allowed, lets it go and puts nothing in the bar', async t => {
  const { page, bar, mic, wait, uploads } = await windowFixture(t, 'claude', { phone: false });
  await mic.click(); await wait('recording');
  await page.keyboard.press('Escape'); await wait('idle');
  await page.evaluate(() => { window.micPermissionPending = true; });
  await mic.click(); await wait('opening');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.micPermissionPending = false; window.allowMic(); });
  await wait('idle');
  assert.equal(await bar.inputValue(), '');
  assert.equal(uploads.length, 0);
});

// The same on the phone: the mic's taps, then the soft keyboard's Enter.
test('on the phone a recording stands in the same way and its words are sent in place', async t => {
  const { page, bar, mic, wait, prompts } = await windowFixture(t);
  await bar.fill('remind me ');
  await mic.click(); await wait('recording');
  await mic.click(); await wait('idle');
  assert.match(await bar.inputValue(), /audio 1/);
  assert.equal(prompts.length, 0);
  await page.waitForFunction(() => document.querySelector('.entry-pending-chip')?.textContent === '(audio 1)');
  await bar.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /words of recording 1/);
  assert.doesNotMatch(prompts[0].text, /audio 1/);
});

for (const kind of ['photo', 'file']) for (const owner of ['pc', 'laptop']) test(`background ${owner} fresh-tab ${kind} draft follows its first SID (${owner === 'pc' ? 'upload pending, same-owner navigation' : 'upload ready, cross-owner navigation'})`, async t => {
  const { page, owners, push, select } = await windowFixture(t);
  if (owner !== 'pc') await select(owner, 'mirror');
  let release;
  if (owner === 'pc') await page.route('**/upload', async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { reference: { name: 'captured-original', sessionId: null }, size: 4 } });
  });
  await page.locator('#entry-input').fill('original prefix');
  await page.locator('#entry-files').setInputFiles({ name: kind === 'photo' ? 'photo.png' : 'plan.txt',
    mimeType: kind === 'photo' ? 'image/png' : 'text/plain', buffer: Buffer.from('body') });
  await page.locator(owner === 'pc' ? '.entry-pending-chip.is-uploading' : '.entry-pending-chip:not(.is-uploading)').waitFor();
  const prefix = await page.locator('#entry-input').inputValue();
  await select('pc', owner === 'pc' ? 'other' : 'mirror');
  await page.locator('#entry-input').fill('unrelated draft');
  owners.get(owner).snap.tabs[0].sessionId = 'created-elsewhere';
  push(owner, owner === 'pc' ? 'other' : 'mirror');
  await page.waitForTimeout(100);
  if (release) { release(); await page.waitForTimeout(100); }
  assert.equal(await page.locator('#entry-input').inputValue(), 'unrelated draft');
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  await select(owner, 'mirror');
  assert.equal(await page.locator('#entry-input').inputValue(), prefix);
  assert.equal(await page.locator('.entry-pending-chip:not(.is-uploading)').count(), 1, 'original attachment remains in the upgraded draft');
});

for (const kind of ['photo', 'file']) for (const owner of ['pc', 'laptop']) test(`background ${owner} ${kind} draft cannot migrate into a replacement host's colliding tab/SID`, async t => {
  const { page, owners, push, select } = await windowFixture(t);
  if (owner !== 'pc') await select(owner, 'mirror');
  await page.locator('#entry-input').fill('original private draft');
  await page.locator('#entry-files').setInputFiles({ name: kind === 'photo' ? 'photo.png' : 'plan.txt',
    mimeType: kind === 'photo' ? 'image/png' : 'text/plain', buffer: Buffer.from('body') });
  await page.locator('.entry-pending-chip:not(.is-uploading)').waitFor();
  const original = await page.locator('#entry-input').inputValue();
  await select('pc', owner === 'pc' ? 'other' : 'mirror');
  await page.locator('#entry-input').fill('unrelated draft');
  owners.get(owner).snap.instanceId = `${owner}-replacement`;
  owners.get(owner).snap.tabs[0].sessionId = 'replacement-session';
  push(owner, owner === 'pc' ? 'other' : 'mirror');
  await page.waitForTimeout(100);
  // The host replacement may also replace the null-session foreground tab.
  await select(owner, 'mirror');
  assert.equal(await page.locator('#entry-input').inputValue(), '');
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  await page.locator('#entry-input').fill('replacement draft');
  // Returning only the mock owner to its old lifetime shows the quarantined
  // draft still exists. Nothing was deleted or rebound to the new owner.
  owners.get(owner).snap.instanceId = `${owner}-host-1`;
  owners.get(owner).snap.tabs[0].sessionId = null;
  push(owner);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#entry-input').inputValue(), original);
  assert.equal(await page.locator('.entry-pending-chip').count(), 1);
});
