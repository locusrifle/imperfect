import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MOST_PROMPT_CHARS, createTranscriber, decodeAudio, namesPrompt, resolveFFmpeg, wav } from '../../../system/transcribe.mjs';
import { normalizeConfig } from '../../../system/machine.mjs';

const transcriberWithReference = options => createTranscriber({ openAudio: async prompt => Readable.from([Buffer.from(prompt.audio, 'base64')]), ...options });
const audioRequest = (base, audio) => ({ method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ audio: Buffer.from(audio).toString('base64') }) });

async function serve(transcribe) {
  const server = createServer(async (req, res) => { if (!await transcribe(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(418).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

// A second of 16 kHz mono silence as a WAV, for ffmpeg to read. Where ffmpeg
// is not, a stand-in hands over the same second of samples.
const second = () => wav(Buffer.alloc(16000 * 2));
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const decoding = ffmpeg ? {} : { decodeAudio: async () => Buffer.alloc(16000 * 2) };

async function listen(t, handle) {
  const server = createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

// whisper-server, as far as imperfect talks to it: POST /inference, a
// multipart form with the WAV in `file` and the names in `prompt`, answered
// with { text }. This one says how much audio it was handed.
async function fakeWhisper(t, { fail = null } = {}) {
  const asked = [];
  const port = await listen(t, async (req, res) => {
    const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Readable.toWeb(req), duplex: 'half' }).formData();
    const audio = Buffer.from(await form.get('file').arrayBuffer());
    asked.push({ path: req.url, prompt: form.get('prompt'), format: form.get('response_format'), riff: audio.subarray(0, 4).toString(), bytes: audio.length });
    res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: fail } : { text: ` heard ${audio.length - 44} bytes\n` }));
  });
  return { port, asked };
}

async function vocabulary(t, text) {
  const dir = await mkdtemp(join(tmpdir(), 'vocabulary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'vocabulary.txt');
  if (text !== null) await writeFile(file, text);
  return file;
}

async function executable(dir) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'ffmpeg');
  await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return file;
}

test('ffmpeg lookup honours configuration and PATH before stable Nix profiles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pathBin = join(root, 'path'), profileBin = join(root, 'profile');
  const inPath = await executable(pathBin), inProfile = await executable(profileBin);
  const lookup = { env: { PATH: pathBin }, profileBins: [profileBin] };
  assert.equal(resolveFFmpeg(lookup), inPath);
  assert.equal(resolveFFmpeg({ ...lookup, env: { PATH: pathBin, IMPERFECT_FFMPEG: inProfile } }), inProfile);
  assert.equal(resolveFFmpeg({ ...lookup, env: { PATH: join(root, 'missing') } }), inProfile, 'a stripped service PATH still finds the profile');
  await chmod(inPath, 0o600);
  assert.equal(resolveFFmpeg(lookup), inProfile, 'a non-executable PATH entry is skipped');
  await rm(inPath);
  await mkdir(inPath);
  assert.equal(resolveFFmpeg(lookup), inProfile, 'a directory is not an executable');
  assert.throws(() => resolveFFmpeg({ ...lookup, env: { PATH: pathBin, IMPERFECT_FFMPEG: join(root, 'missing') } }), error => error.status === 503 && /IMPERFECT_FFMPEG/.test(error.message), 'bad explicit config is not silently ignored');
  assert.throws(() => resolveFFmpeg({ ...lookup, env: { IMPERFECT_FFMPEG: 'ffmpeg' } }), /absolute path/);
});

test('ffmpeg is rediscovered after installation and in a user Nix profile', async t => {
  const home = await mkdtemp(join(tmpdir(), 'voice-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  const lookup = { env: { PATH: bin }, profileBins: [] };
  assert.throws(() => resolveFFmpeg(lookup), error => error.status === 503 && /install ffmpeg/.test(error.message));
  const installed = await executable(bin);
  assert.equal(resolveFFmpeg(lookup), installed, 'the next retry sees the installation');
  const profile = await executable(join(home, '.nix-profile/bin'));
  assert.equal(resolveFFmpeg({ home, env: { PATH: join(home, 'missing') } }), profile);
  const modernProfile = await executable(join(home, '.local/state/nix/profile/bin'));
  await chmod(profile, 0o600);
  assert.equal(resolveFFmpeg({ home, env: { PATH: join(home, 'missing') } }), modernProfile);
});

test('a missing or unlaunchable decoder is a service error, never words', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-decoder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await executable(root);
  for (const code of ['ENOENT', 'EACCES', 'ENOEXEC']) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    await assert.rejects(decodeAudio('recording', { env: { IMPERFECT_FFMPEG: command }, spawnImpl: (path, args) => {
      assert.equal(path, command);
      assert.ok(args.includes('recording'));
      setImmediate(() => { child.emit('error', Object.assign(new Error(`spawn ffmpeg ${code}`), { code })); child.emit('close', -2); });
      return child;
    } }), error => error.status === 503 && /ffmpeg could not start/.test(error.message));
  }
  const asked = [];
  const transcribe = transcriberWithReference({ fetch: async () => { asked.push(1); throw new Error('Whisper was asked'); }, decodeAudio: file => decodeAudio(file, { env: { PATH: join(root, 'missing') }, profileBins: [] }) });
  const { base, close } = await serve(transcribe);
  try {
    const res = await fetch(`${base}/transcribe`, audioRequest(base, second()));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /ffmpeg is not available/);
    assert.equal(asked.length, 0, 'nothing was handed to Whisper');
  } finally { await close(); }
});

test('the Nix system decoder works even with a stripped service PATH', async t => {
  const bin = '/run/current-system/sw/bin';
  if (!existsSync(join(bin, 'ffmpeg'))) return t.skip('no Nix system ffmpeg');
  const root = await mkdtemp(join(tmpdir(), 'voice-nix-decode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'audio');
  await writeFile(file, second());
  const pcm = await decodeAudio(file, { env: { PATH: join(root, 'missing') }, profileBins: [bin] });
  assert.equal(pcm.length, 32000);
  assert.ok(pcm.every(byte => byte === 0));
});

test('the names prompt is the vocabulary\'s lines, in order, as many as fit under Whisper\'s limit', () => {
  assert.equal(namesPrompt('Vaita\n\n  Omarchy  \nLocus\n'), 'Vaita, Omarchy, Locus');
  assert.equal(namesPrompt(''), '');
  const prompt = namesPrompt(Array.from({ length: 400 }, (_, i) => `Name${i}`).join('\n'));
  assert.ok(prompt.length <= MOST_PROMPT_CHARS && prompt.length > MOST_PROMPT_CHARS - 12, prompt.length);
  assert.ok(prompt.startsWith('Name0, Name1'), 'the first lines are kept');
});

test('on the PC an upload goes to Whisper as 16 kHz WAV with the names, read on each request', async t => {
  const whisper = await fakeWhisper(t);
  const file = await vocabulary(t, 'Vaita\nOmarchy\n');
  const transcribe = transcriberWithReference({ whisper: whisper.port, vocabulary: file, ...decoding });
  assert.deepEqual(await transcribe.hear(Readable.from([second()])), { text: 'heard 32000 bytes', seconds: 1 });
  assert.deepEqual(whisper.asked, [{ path: '/inference', prompt: 'Vaita, Omarchy', format: 'json', riff: 'RIFF', bytes: 32044 }]);
  await writeFile(file, 'Locus\n');
  const { base, close } = await serve(transcribe);
  t.after(close);
  const res = await fetch(`${base}/transcribe`, audioRequest(base, second()));
  assert.deepEqual(await res.json(), { text: 'heard 32000 bytes', seconds: 1 });
  assert.equal(whisper.asked[1].prompt, 'Locus', 'a changed list is used at once');
  assert.equal((await fetch(`${base}/elsewhere`)).status, 418, 'other paths are not answered');
  assert.equal((await fetch(`${base}/transcribe`, { method: 'POST', body: '{}' })).status, 403, 'the exact origin is required');
});

test('without a vocabulary no prompt is sent, and silence is not sent at all', async t => {
  const whisper = await fakeWhisper(t);
  const transcribe = createTranscriber({ whisper: whisper.port, vocabulary: await vocabulary(t, null), ...decoding });
  await transcribe.hear(Readable.from([second()]));
  assert.equal(whisper.asked[0].prompt, null);
  const empty = createTranscriber({ whisper: whisper.port, decodeAudio: async () => Buffer.alloc(0) });
  assert.deepEqual(await empty.hear(Readable.from([Buffer.from('x')])), { text: '', seconds: 0 });
  assert.equal(whisper.asked.length, 1);
});

test('without Whisper running it says so with 503, and Whisper\'s own failure is passed on', async t => {
  // Nothing listens on port 1.
  const { base, close } = await serve(transcriberWithReference({ whisper: 1, vocabulary: await vocabulary(t, null), ...decoding }));
  t.after(close);
  const res = await fetch(`${base}/transcribe`, audioRequest(base, second()));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /Whisper is not running on this computer.*imperfect-whisper\.service/);
  const broken = await fakeWhisper(t, { fail: 'failed to read audio' });
  const other = await serve(transcriberWithReference({ whisper: broken.port, ...decoding }));
  t.after(other.close);
  const res2 = await fetch(`${other.base}/transcribe`, audioRequest(other.base, second()));
  assert.equal(res2.status, 502);
  assert.match((await res2.json()).error, /Whisper could not hear it: failed to read audio/);
});

test('audio that is not audio is refused as unreadable', { skip: !ffmpeg && 'ffmpeg is not on this computer' }, async t => {
  const whisper = await fakeWhisper(t);
  const { base, close } = await serve(transcriberWithReference({ whisper: whisper.port }));
  t.after(close);
  const junk = await fetch(`${base}/transcribe`, audioRequest(base, 'not audio at all'));
  assert.equal(junk.status, 422);
  assert.match((await junk.json()).error, /could not read that audio/);
  assert.equal(whisper.asked.length, 0);
});

// The laptop and the PC: two transcribers, the laptop's told the PC is its
// authority. The laptop's own Whisper port is never asked.
test('another computer sends the recording to the PC\'s /hear, with its exact origin, and gets the words back', async t => {
  const whisper = await fakeWhisper(t);
  const pcSeen = [];
  const pcTranscribe = createTranscriber({ whisper: whisper.port, vocabulary: await vocabulary(t, 'Vaita'), ...decoding });
  const pcPort = await listen(t, async (req, res) => { pcSeen.push({ origin: req.headers.origin, path: req.url }); if (!await pcTranscribe(req, res, req.url)) res.writeHead(418).end(); });
  const pc = `http://127.0.0.1:${pcPort}`;
  const laptop = transcriberWithReference({ whisper: 1, authority: async () => ({ url: pc, name: 'desktop' }), decodeAudio: () => assert.fail('the laptop does not decode') });
  assert.deepEqual(await laptop.hear(Readable.from([second()])), { text: 'heard 32000 bytes', seconds: 1 });
  assert.deepEqual(pcSeen, [{ origin: pc, path: '/hear' }]);
  assert.equal(whisper.asked[0].prompt, 'Vaita', 'the PC\'s vocabulary is used');
  // A window's /transcribe on the laptop (a recording held in its bar) goes the same way.
  const { base, close } = await serve(laptop);
  t.after(close);
  const res = await fetch(`${base}/transcribe`, audioRequest(base, second()));
  assert.deepEqual(await res.json(), { text: 'heard 32000 bytes', seconds: 1 });
  // The laptop never hears for anyone else, so /hear cannot loop.
  const refused = await fetch(`${base}/hear`, { method: 'POST', headers: { origin: base }, body: second() });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /this computer does not hear recordings; desktop does/);
  assert.equal((await fetch(`${pc}/hear`, { method: 'POST', body: second() })).status, 403, 'the exact origin is required');
});

test('when the PC cannot be reached the laptop says so, and the PC\'s refusal comes back in its words', async t => {
  const away = createTranscriber({ authority: async () => ({ url: '', name: 'desktop' }) });
  await assert.rejects(away.hear(Readable.from([second()])), error => error.status === 502 && /desktop, which hears the mic, cannot be reached right now/.test(error.message));
  const gone = createTranscriber({ authority: async () => ({ url: 'https://desktop.tail.ts.net', name: 'desktop' }), fetch: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(gone.hear(Readable.from([second()])), error => error.status === 502 && /cannot be reached right now \(ECONNREFUSED\)/.test(error.message));
  const pcPort = await listen(t, (req, res) => { req.resume(); req.on('end', () => res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Whisper is not running on this computer' }))); });
  const refused = createTranscriber({ authority: async () => ({ url: `http://127.0.0.1:${pcPort}`, name: 'desktop' }) });
  await assert.rejects(refused.hear(Readable.from([second()])), error => error.status === 502 && error.message === 'desktop: Whisper is not running on this computer');
});

test('the Whisper port is in machine.json, 5069 unless it says otherwise', () => {
  assert.deepEqual(normalizeConfig().whisper, { port: 5069 });
  assert.deepEqual(normalizeConfig({ whisper: { port: 6000 } }).whisper, { port: 6000 });
  assert.throws(() => normalizeConfig({ whisper: { port: 0 } }), /invalid port/);
});
