// Voice into words. POST /transcribe with a reference to an uploaded audio
// or video file (a recording from the mic in imperfect's dock, or one
// attached), and the answer is its text. The decoder reads a copy from a
// temporary file, deleted after; the uploaded original is never deleted.
//
// Only the computer the others follow (the authority in machine.json, the PC
// with the GPU) hears. There ffmpeg turns whatever arrives into 16 kHz mono
// WAV, and Whisper large-v3-turbo turns that into words. Whisper is always
// loaded, in a service of its own on loopback (imperfect-whisper.service,
// from install.sh). The person's own words (names, places), one per line in
// ~/.imperfect/vocabulary.txt, are read on each request and sent as
// Whisper's prompt. Any other computer sends the audio to the authority's
// POST /hear and gets the words back, the way generate_image reaches the key
// box; /hear is guarded the same way (exact origin, and only this computer's
// tailnet name or loopback, which server.mjs checks).
//
// Long audio goes to Whisper whole. whisper-server walks it in its own
// half-minute windows, moving on where its timestamps say a segment ended,
// and that whole-clip run is what was measured on the PC (108 s in 4.2 s).
// Cutting it here as well would split the names prompt across pieces for
// nothing.

import { spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { readAttachmentJson } from '../apps/code/native/uploads.mjs';
import { resolvePrefix } from './machine.mjs';

const RATE = 16000;
const MAX_BYTES = 1024 * 1024 * 1024;
// Whisper takes at most half its 448-token text context as the prompt and
// drops the start of anything longer. At about three characters a token for
// names, 600 characters stays under it.
export const MOST_PROMPT_CHARS = 600;
// An hour's meeting takes Whisper a few minutes on the PC.
const HEARING_MS = 15 * 60_000;

export const vocabularyFile = (prefix = resolvePrefix()) => join(prefix, 'vocabulary.txt');
const fault = (status, message) => Object.assign(new Error(message), { status });

// The prompt from vocabulary.txt: its lines, in order, as many as fit.
export function namesPrompt(text) {
  let prompt = '';
  for (const line of String(text ?? '').split('\n').map(word => word.trim()).filter(Boolean)) {
    const next = prompt ? `${prompt}, ${line}` : line;
    if (next.length > MOST_PROMPT_CHARS) break;
    prompt = next;
  }
  return prompt;
}

// 16-bit mono samples as a WAV file.
export function wav(pcm, rate = RATE) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

const unavailable = message => Object.assign(new Error(message), { status: 503 });

// A service need not inherit the person's shell PATH. Honour an explicit
// executable first, then PATH, then Nix's stable profile links (not a pinned
// store path). Resolve on each recording so installing it makes retry work.
export function resolveFFmpeg({
  env = process.env, home = homedir(),
  profileBins = [join(home, '.nix-profile/bin'), join(home, '.local/state/nix/profile/bin'), join('/etc/profiles/per-user', userInfo().username, 'bin'), '/run/current-system/sw/bin'],
} = {}) {
  const executable = file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  };
  if (env.IMPERFECT_FFMPEG) {
    if (!isAbsolute(env.IMPERFECT_FFMPEG) || !executable(env.IMPERFECT_FFMPEG)) throw unavailable('IMPERFECT_FFMPEG must name an executable absolute path to ffmpeg on this computer');
    return env.IMPERFECT_FFMPEG;
  }
  for (const bin of [...(env.PATH ?? '/usr/bin:/bin').split(delimiter), ...profileBins]) {
    const file = resolve(bin, 'ffmpeg');
    if (executable(file)) return file;
  }
  throw unavailable('ffmpeg is not available to the voice service on this computer; install ffmpeg or set IMPERFECT_FFMPEG to its executable absolute path');
}

// Any audio or video file as 16 kHz mono 16-bit samples.
export function decodeAudio(file, { spawnImpl = spawn, ...lookup } = {}) {
  const command = resolveFFmpeg(lookup);
  return new Promise((resolve, reject) => {
    const ff = spawnImpl(command, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let error = '';
    ff.stdout.on('data', chunk => chunks.push(chunk));
    ff.stderr.on('data', chunk => { error += chunk; });
    ff.on('error', error => reject(['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)
      ? unavailable('ffmpeg could not start on this computer; check its executable and dependencies, or set IMPERFECT_FFMPEG to a working executable absolute path')
      : error));
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`could not read that audio: ${error.trim().split('\n').at(-1) || `ffmpeg ${code}`}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

// whisper: the port of this computer's Whisper server (machine.json).
// authority(): the computer the others follow, as authorityPeer in server.mjs
// gives it: null when this is it, { url: '' } while it cannot be reached.
// openAudio(prompt): the upload a /transcribe request names, as a stream.
// decodeAudio and fetch: ffmpeg and the network, which a test can stand in for.
export function createTranscriber({ whisper = 5069, authority = async () => null, vocabulary = vocabularyFile(), decodeAudio: decode = decodeAudio, fetch: send = fetch, openAudio } = {}) {
  // Heard here, by the Whisper server on loopback.
  async function here(audio) {
    const dir = await mkdtemp(join(tmpdir(), 'imperfect-voice-'));
    let pcm;
    try {
      const file = join(dir, 'audio');
      await pipeline(audio, createWriteStream(file));
      pcm = await decode(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const seconds = Math.round(pcm.length / 2 / RATE);
    if (!pcm.length) return { text: '', seconds };
    const form = new FormData();
    form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    const prompt = namesPrompt(await readFile(vocabulary, 'utf8').catch(() => ''));
    if (prompt) form.append('prompt', prompt);
    let res;
    try {
      res = await send(`http://127.0.0.1:${whisper}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(HEARING_MS) });
    } catch (error) {
      throw unavailable(`Whisper is not running on this computer (${error.cause?.code || error.message}); run ./install.sh, or see systemctl --user status imperfect-whisper.service`);
    }
    const answer = await res.json().catch(() => ({}));
    if (!res.ok || answer.error) throw fault(502, `Whisper could not hear it: ${answer.error || res.status}`);
    return { text: String(answer.text ?? '').replace(/\s+/g, ' ').trim(), seconds };
  }

  // Heard on the authority: the audio goes there, and the words come back.
  async function there({ url, name }, audio) {
    const who = `${name || 'the PC'}, which hears the mic,`;
    if (!url) throw fault(502, `${who} cannot be reached right now`);
    let res;
    try {
      res = await send(`${url}/hear`, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/octet-stream' }, body: audio, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(HEARING_MS) });
    } catch (error) {
      throw fault(502, `${who} cannot be reached right now (${error.cause?.code || error.message})`);
    }
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw fault(res.status === 422 || res.status === 413 ? res.status : 502, `${name || 'the PC'}: ${answer.error || res.status}`);
    return { text: String(answer.text ?? ''), seconds: Number(answer.seconds) || 0 };
  }

  // The words in some audio (a stream or bytes): { text, seconds }.
  async function hear(audio) {
    const elsewhere = await authority();
    return elsewhere ? there(elsewhere, audio) : here(audio);
  }

  // Answers POST /transcribe (an upload, from a window) and POST /hear (the
  // audio itself, from another computer); false for anything else.
  async function handle(req, res, path) {
    if (!['/transcribe', '/hear'].includes(path) || req.method !== 'POST') return false;
    const json = (status, value) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    try {
      if (path === '/hear') {
        // Never passed on again: only the authority hears.
        const elsewhere = await authority();
        if (elsewhere) throw fault(409, `this computer does not hear recordings; ${elsewhere.name || 'the PC'} does`);
        if (Number(req.headers['content-length'] || 0) > MAX_BYTES) throw fault(413, 'that recording is larger than 1 GB');
        json(200, await here(req));
        return true;
      }
      const audio = await openAudio(await readAttachmentJson(req));
      try { json(200, await hear(audio)); } finally { audio.destroy(); }
    } catch (error) {
      json(error.status || 422, { error: error.message });
    }
    return true;
  }
  return Object.assign(handle, { hear });
}
