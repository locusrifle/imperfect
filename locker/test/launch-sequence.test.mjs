import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { demoAddress, isDemoReady, waitForMedia, primeVideo, playVideo, fadeDuration, preloadDue } from '../../website/media.mjs';
import { config } from '../../website/launch-config.mjs';
import { BURST, PEAK, bubbleMotion, createPlayer } from '../../website/bootup.mjs';
import { WORD, SHINE, wordmarkAt, placeWordmark } from '../../website/wordmark.mjs';
import { twistAt, TWIST, distanceFor } from '../../website/sky.mjs';
import { revealAt, contactBurst, pickSource, WHOLE } from '../../website/reveal.mjs';
import { createBlackHole, DEFAULTS as HOLE } from '../../website/blackhole/blackhole.mjs';
import { createBlackHole as holeBefore } from './fixtures/blackhole-before-ring-near.mjs';
import { soundMotion, kickAt as soundKick, HITS as SOUND_HITS, HITS2 } from '../../website/bubble-sound.mjs';
import { bubblePath } from '../../website/bubble.mjs';
import { bubblePath as pathBefore } from './fixtures/bubble-before-sound.mjs';
import * as revealBefore from './fixtures/reveal-before-sound.mjs';
import { warpTable, filmRect, ASPECT } from '../../website/film.mjs';
import { GOAT, MASS, goatTimes, goatAt, opticalWordmark, placeGoat } from '../../website/intro/goat.mjs';
import { workbenchOf } from '../../website/lock.mjs';
import { INTRO, STEPS } from '../../website/mac/desktop.mjs';
const read = path => readFile(new URL('../../website/' + path, import.meta.url), 'utf8');
// Check responsibilities, not line breaks or the exact prose of comments between functions.
function functionSource(text, name) {
  const match = text.match(new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, 'm'));
  assert.ok(match, `${name} exists`);
  const rest = text.slice(match.index);
  const end = rest.indexOf(`\n${match[1]}}\n`);
  assert.ok(end >= 0, `${name} has a body`);
  return rest.slice(0, end + match[1].length + 2);
}
function assertBefore(text, first, second, message) {
  const a = text.indexOf(first), b = text.indexOf(second);
  assert.ok(a >= 0 && b >= 0 && a < b, message);
}
// Read the measured M4A movie duration without requiring ffprobe in the test environment.
function m4aDurationMs(bytes) {
  function atom(type, from = 0, to = bytes.length) {
    for (let at = from; at + 8 <= to;) {
      const size = bytes.readUInt32BE(at);
      assert.ok(size >= 8 && at + size <= to, 'valid M4A atom');
      if (bytes.toString('ascii', at + 4, at + 8) === type) return { from: at + 8, to: at + size };
      at += size;
    }
    assert.fail(`M4A contains ${type}`);
  }
  const moov = atom('moov'), mvhd = atom('mvhd', moov.from, moov.to), at = mvhd.from;
  const version = bytes[at];
  assert.ok(version === 0 || version === 1, 'supported movie header');
  const scale = bytes.readUInt32BE(at + (version === 1 ? 20 : 12));
  const ticks = version === 1 ? Number(bytes.readBigUInt64BE(at + 24)) : bytes.readUInt32BE(at + 16);
  assert.ok(scale > 0 && ticks > 0, 'a measured, nonempty voice');
  return ticks / scale * 1000;
}

class Video extends EventTarget {
  readyState = 0; volume = 1; muted = false; currentTime = 10; paused = true; error = null;
  calls = [];
  play() { this.calls.push('play'); this.paused = false; return Promise.resolve(); }
  pause() { this.calls.push('pause'); this.paused = true; }
}

test('same contact, burst, shine, hold/fade and reverse sky as the lock', () => {
  assert.equal(BURST, 5.367); assert.ok(PEAK > BURST);
  assert.deepEqual(SHINE, { start: 6.01, end: 6.493 });
  assert.ok(Math.abs(WORD.gone - 8.61) < 1e-9);
  assert.equal(wordmarkAt(BURST - .001).on, false);
  assert.equal(wordmarkAt(SHINE.start).formed, 1);
  assert.equal(wordmarkAt(8.01).opacity, 1);
  assert.equal(wordmarkAt(WORD.gone).on, false);
  assert.equal(wordmarkAt(BURST, { still: true }).shine, null);
  assert.equal(TWIST, 'reverse');
  assert.equal(twistAt(20, { touched: 10 }), -(10 - BURST));
  assert.equal(twistAt(20, { touched: 10, still: true }), 0);
  for (const tau of [0, .35, 2, 5, BURST, BURST + .8]) {
    const b = revealAt(tau, { at: [195, 400], width: 390, height: 844 });
    assert.ok(Number.isFinite(b.R)); assert.equal(b.pop, tau >= BURST);
  }
  assert.equal(bubbleMotion(BURST + .8).done, true);
});
test('wordmark stays centred on desktop and portrait', () => {
  for (const [w, h] of [[1920,1080],[390,844],[844,390]]) {
    const [x,y,mw,mh] = placeWordmark(w,h);
    assert.equal(x + mw / 2, w / 2); assert.equal(y + mh / 2, h / 2);
  }
});
test('shared boot has no lock login or bridge; calls shared renderers', async () => {
  const text = await read('boot/sequence.mjs');
  assert.doesNotMatch(text, /window\.lock|window\.webkit|S\.typed|S\.yes|function drawBox|function showDots/);
  for (const call of ['revealAt(tau,', 'contactBurst({', 'wordmarkAt(tau,', 'twistAt(now,', "tell('complete')"]) assert.ok(text.includes(call));
  assert.match(text, /if \(tau < WORD\.gone\) return/);
});
test('static page keeps PWA/icon additions, has no old marketing/cards or fake app', async () => {
  const text = await read('index.html');
  for (const file of ['favicon.ico', 'favicon.svg', 'manifest.webmanifest', 'apple-touch-icon.png']) {
    assert.ok(text.includes('/' + file)); await access(new URL('../../website/' + file, import.meta.url));
  }
  assert.match(text, /<iframe id="computer"/);
  assert.match(text, /<video id="film"[^>]*playsinline/);
  assert.match(text, /<h1 id="launchHeading" class="sr-only">imperfect: launch film and live computer<\/h1>/);
  assert.match(text, /<a class="keyboard-skip" id="skip" href="#computer">Skip to the computer<\/a>/);
  // The lock instead of the power button: one password field, its arrow, nothing else.
  assert.match(text, /<form id="lock" aria-label="Locked" autocomplete="off" novalidate hidden>/);
  assert.match(text, /<input id="password" name="password" type="password" aria-label="Password" autocomplete="current-password"[^>]*enterkeyhint="go"/);
  assert.match(text, /<button id="unlock" type="submit" aria-label="Unlock">/);
  assert.equal(text.match(/<form\b/g).length, 1, 'one form: the lock');
  assert.equal(text.match(/<input\b/g).length, 1, 'one field: the password');
  const pictures = text.match(/<img\b[^>]*>/g), dock = /^<img src="mac\/icons\/[\w-]+\.webp" alt="">$/;
  const pointer = '<img class="mac-cursor" src="mac/cursor.png" alt="" aria-hidden="true">';
  assert.deepEqual(pictures.filter(img => !dock.test(img) && img !== pointer), ['<img class="goat" id="goat" alt="" aria-hidden="true" decoding="async" hidden>'], 'one picture of its own: the goat after the word');
  assert.ok(pictures.filter(img => dock.test(img)).length >= 8, 'and the Mac the film ends on: its Dock\'s icons and its pointer, nothing else (mac/desktop.mjs)');
  assert.equal(pictures.filter(img => img === pointer).length, 1, 'one pointer');
  assert.doesNotMatch(text, /id="power"|Power on/, 'no power button');
  assert.doesNotMatch(text, /noah\.imperfect\.computer|\/door\/ticket/, 'no computer\'s address in the page: the locker gives it after the unlock');
  assert.doesNotMatch(text, /launchControls|id="own"|id="mute"|id="pause"|id="replay"/, 'no controls bar');
  assert.doesNotMatch(text, /AUD 40|AUD 400|offer-grid|painting-pair|hero-copy|srcdoc=|checkout\.stripe\.com/);
});
test('a boot framing change is versioned through every public module edge', async () => {
  const html = await read('index.html');
  const entry = html.match(/src="launch\.mjs\?v=([^"&]+)"/);
  assert.ok(entry, 'the HTML revalidates and selects a fresh launch entry');
  // The film and boot can have different revision keys; every changed edge still needs its own fresh URL.
  for (const [file, versionedImport] of [
    ['launch.mjs', /import\('\.\/intro\/intro\.mjs\?v=[^']+'\)/],
    ['intro/intro.mjs', /from '\.\.\/boot\/sequence\.mjs\?v=[^']+'/],
    ['boot/sequence.mjs', /from '\.\.\/opener\/framing\.mjs\?v=[^']+'/],
  ]) {
    assert.match(await read(file), versionedImport, `${file} must select the fresh boot dependency, not a cached unversioned module`);
  }
});
test('safe configurable real-app URL; no keys in URL or script/data protocols', () => {
  assert.equal(demoAddress('https://noah.imperfect.computer').origin, 'https://noah.imperfect.computer');
  assert.equal(demoAddress('http://localhost:4321').hostname, 'localhost');
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://a:b@example.test', 'http://example.test']) assert.throws(() => demoAddress(value));
});
test('production requires the exact real-product readiness handshake and origin', () => {
  assert.equal('demoUrl' in config, false, 'no computer in the page: the locker answers the unlock with it');
  assert.equal(config.demoReadyType, 'imperfect:demo-ready');
});
test('the locker\'s answer opens Noah\'s computer only with a plain https (or loopback) address', () => {
  const url = 'https://noah.imperfect.computer/door/ticket?t=a.b';
  assert.deepEqual(workbenchOf({ ok: true, workbench: { id: 'noah', url } }), { id: 'noah', url });
  assert.equal(workbenchOf({ ok: true, workbench: { id: 'x', url: 'http://localhost:4321/' } }).url, 'http://localhost:4321/');
  for (const answer of [null, {}, { ok: false }, { ok: true }, { ok: 'yes', workbench: { id: 'x', url } }, { ok: true, workbench: { id: 1, url } },
    ...['javascript:alert(1)', 'data:text/html,x', 'http://example.test', 'https://a:b@example.test', 'not a url'].map(bad => ({ ok: true, workbench: { id: 'x', url: bad } }))]) assert.equal(workbenchOf(answer), null);
});
test('ready handshake must match both source and exact origin/type', () => {
  const frame = { contentWindow: {} }, url = new URL('https://noah.imperfect.computer');
  const event = { source: frame.contentWindow, origin: url.origin, data: { type: 'imperfect:demo-ready' } };
  assert.equal(isDemoReady(event, frame, url, 'imperfect:demo-ready'), true);
  for (const patch of [{ source: {} }, { source: null }, { origin: 'https://evil.test' },
    { origin: 'https://sub.noah.imperfect.computer' }, { origin: 'https://noah.imperfect.computer:444' },
    { origin: 'http://noah.imperfect.computer' }, { origin: 'null' }, { data: { type: 'load' } }, { data: null }]) {
    assert.equal(isDemoReady({ ...event, ...patch }, frame, url, 'imperfect:demo-ready'), false);
  }
  assert.equal(isDemoReady(event, frame, url, null), false);
});
test('waitForMedia handles cached frame and fresh frame', async () => {
  const v = new Video(); v.readyState = 2; await waitForMedia(v);
  v.readyState = 0; const ready = waitForMedia(v); v.readyState = 2; v.dispatchEvent(new Event('loadeddata')); await ready;
});
test('waitForMedia error, timeout, cancellation never strand transitions', async () => {
  const v = new Video(); const p = waitForMedia(v); v.dispatchEvent(new Event('error')); await assert.rejects(p, /could not load/);
  await assert.rejects(waitForMedia(v, { timeoutMs: 1 }), /too long/);
  const abort = new AbortController(); const cancelled = waitForMedia(v, { signal: abort.signal }); abort.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(waitForMedia(v, { signal: abort.signal }), { name: 'AbortError' });
});
test('initial gesture primes same element MUTED, parks at zero, restores audio state', async () => {
  const v = new Video(); const primed = primeVideo(v);
  assert.equal(v.muted, true); assert.equal(v.volume, 1); assert.deepEqual(v.calls, ['play']);
  await primed;
  assert.deepEqual(v.calls, ['play','pause']); assert.equal(v.currentTime, 0); assert.equal(v.muted, false);
  v.muted = true; await primeVideo(v); assert.equal(v.muted, true, 'already muted stays muted');
});
test('stale primer cannot pause or rewind actual film after skip/replay', async () => {
  const v = new Video(); let resolve;
  v.play = () => new Promise(ok => { resolve = ok; });
  let current = true; const p = primeVideo(v, { isCurrent: () => current }); current = false;
  v.muted = false; v.volume = 1; v.currentTime = 4; resolve(); await p;
  assert.deepEqual(v.calls, []); assert.equal(v.currentTime, 4); assert.equal(v.volume, 1); assert.equal(v.muted, false);
});
test('blocked primer and play report rejection; playback is time-bounded and cancellable', async () => {
  const v = new Video(); v.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
  await assert.rejects(primeVideo(v), { name: 'NotAllowedError' }); assert.equal(v.volume, 1); assert.equal(v.muted, false);
  await assert.rejects(playVideo(v), { name: 'NotAllowedError' });
  v.play = () => new Promise(() => {});
  await assert.rejects(playVideo(v, { timeoutMs: 1 }), /did not start/);
  const abort = new AbortController(); const p = playVideo(v, { signal: abort.signal }); abort.abort();
  await assert.rejects(p, { name: 'AbortError' });
});
test('mute gain does not change contact/envelope clock; failed audio still advances silently', async () => {
  let audio, gain, now = 0, starts = 0;
  class Context {
    constructor() { audio = this; this.state = 'running'; this.currentTime = 40; this.destination = {}; }
    createGain() { return gain = { gain: { value: 1 }, connect() {} }; }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return Promise.resolve(); }
    createBufferSource() { return { connect() {}, stop() {}, start() { starts++; } }; }
  }
  const sound = createPlayer({ Context, clock: () => now, fetcher: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }) });
  await sound.ready; await sound.prime(); assert.equal(starts, 0);
  sound.setMuted(true); sound.start(); audio.currentTime += 2;
  assert.equal(gain.gain.value, 0); assert.equal(sound.elapsed(), 2); assert.equal(sound.audible, false);
  sound.setMuted(false); assert.equal(gain.gain.value, 1); assert.equal(sound.elapsed(), 2); assert.equal(sound.audible, true);
  const silent = createPlayer({ Context: null, clock: () => now }); await silent.ready; silent.start(); now = BURST;
  assert.equal(silent.elapsed(), BURST); assert.equal(silent.audible, false);
});
test('reduced motion removes inter-screen fades', () => {
  assert.equal(fadeDuration(true, 650), 0); assert.equal(fadeDuration(false, 650), 650);
});

// ---- Film-to-product handoff: hidden preload during the film, crossfade only when verified.
const ranges = list => ({ length: list.length, start: i => list[i][0], end: i => list[i][1] });
const playingAt = (currentTime, list, patch = {}) => ({ paused: false, ended: false, readyState: 4, currentTime, duration: 129.742, buffered: ranges(list), ...patch });
test('preload waits for ~10 s of actual playback and a buffer cushion, never during startup, pause or starvation', () => {
  const opts = { afterS: 10, aheadS: 15 };
  assert.equal(preloadDue(playingAt(0, [[0, 129.742]]), opts), false, 'not at startup, even fully buffered');
  assert.equal(preloadDue(playingAt(9.99, [[0, 129.742]]), opts), false);
  assert.equal(preloadDue(playingAt(10, [[0, 129.742]]), opts), true);
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { paused: true }), opts), false, 'paused (button, hidden tab) never counts');
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { ended: true }), opts), false);
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { readyState: 2 }), opts), false, 'starving film keeps the network');
  assert.equal(preloadDue(playingAt(12, [[0, 18]]), opts), false, 'only 6 s buffered ahead');
  assert.equal(preloadDue(playingAt(12, [[0, 27]]), opts), true, '15 s buffered ahead');
  assert.equal(preloadDue(playingAt(12, [[0, 5], [11.8, 40]]), opts), true, 'the range holding the playhead counts');
  assert.equal(preloadDue(playingAt(12, [[0, 11], [20, 129.742]]), opts), false, 'a hole at the playhead does not');
  assert.equal(preloadDue(playingAt(120, [[0, 129.6]]), opts), true, 'buffered through the end of a short remainder');
  assert.equal(preloadDue(playingAt(12, [[0, 40]], { duration: NaN }), opts), true, 'unknown duration uses the cushion');
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { buffered: undefined }), opts), false);
});
test('launch config: v8 film, 10 s preload, 1.2 s handoff that reduced motion makes instant', () => {
  assert.match(config.videoUrl, /\/media\/v8-lets-begin\.mp4(\?v=[0-9a-f]{8}(?:-restored)?)?$/);
  assert.match(config.cuesUrl, /\/media\/v8-cues\.json(\?v=[0-9a-f]{8})?$/);
  assert.equal(config.unlockMs, 600); assert.equal('powerMs' in config, false); assert.equal(config.scrollHint, true); assert.equal(config.hintAfterMs, 4000);
  assert.equal(fadeDuration(true, config.unlockMs), 0);
  assert.equal(config.preloadAfterS, 10); assert.equal(config.preloadAheadS, 15);
  assert.equal(config.handoffMs, 1200); assert.equal(config.fadeMs, 650); assert.equal(config.demoTimeoutMs, 15000);
  assert.equal(fadeDuration(true, config.handoffMs), 0); assert.equal(fadeDuration(false, config.handoffMs), 1200);
});
test('film lifts to the Mac build; only its ending can reveal the exact-handshake live frame', async () => {
  const text = await read('launch.mjs');
  const show = functionSource(text, 'showMac');
  assert.match(text, /createMac\(\{[^}]*onfinish:\s*finishMac/);
  assert.match(text, /video\.addEventListener\('ended',\s*\(\)\s*=>\s*\{[^}]*phase === 'film'[^}]*showMac\(\)/);
  assertBefore(show, 'await mac.reveal()', 'mac.play()', 'the blind lifts before the build starts');
  assert.match(show, /visible\(filmScreen,\s*false\)/);
  assert.doesNotMatch(show, /visible\(demoScreen,\s*true\)|revealLive\(/, 'film end is not product readiness');
  const finish = functionSource(text, 'finishMac'), reveal = functionSource(text, 'revealLive');
  assert.match(finish, /ending\s*=\s*true/);
  assert.doesNotMatch(finish, /grow|delay|fade/);
  assertBefore(finish, 'mac.finish()', 'endingReady = true', 'the voice ends before interactivity');
  const present = functionSource(text, 'presentBuild');
  assert.match(present, /!demoVerified \|\| !mac\.state\(\)\.built\.includes\('s-live'\)/);
  assert.match(present, /demoScreen\.inert = !endingReady/);
  assert.match(present, /visible\(demoScreen,\s*true\)/);
  assert.match(present, /mac\.present\(true\)/);
  assert.match(reveal, /if\s*\(\s*!endingReady\s*\|\|\s*!demoVerified\s*\)\s*return/);
  assert.match(reveal, /presentBuild\(\)/);
  assert.match(reveal, /mac\.live\(true\)/);
  assert.equal([...text.matchAll(/visible\(demoScreen,\s*true\)/g)].length, 1, 'one guarded path reveals the product');
  assert.equal([...text.matchAll(/demoVerified\s*=\s*true/g)].length, 1, 'only the exact handshake listener verifies');
  assert.match(text, /if\s*\(!demo\s*\|\|\s*!isDemoReady\(event,\s*frame,\s*demo,\s*config\.demoReadyType\)\)\s*return;\s*demoVerified\s*=\s*true/);
  const request = functionSource(text, 'requestDemo'), preload = functionSource(text, 'preloadDemo');
  assert.match(preload, /phase !== 'film'\s*\|\|\s*document\.hidden\s*\|\|\s*stallTimer !== null/);
  assert.match(preload, /preloadDue\(video,/);
  assert.match(preload, /requestDemo\(\)/);
  assert.match(request, /await remembered\(\)/, 'refresh the short-lived ticket just before frame navigation');
  assert.match(request, /bench\?\.id !== workbench\.id/, 'refresh cannot switch to another computer');
  assert.match(request, /visible\(demoScreen,\s*false\)/);
  assert.match(request, /frame\.src\s*=\s*demo\.href/);
  assert.doesNotMatch(preload + request, /visible\(demoScreen,\s*true\)|demoVerified\s*=\s*true|revealLive\(/, 'preload can never reveal');
  assert.match(text, /if\s*\(\+\+frameLoads > 1\)\s*\{\s*demoVerified\s*=\s*false;\s*visible\(demoScreen,\s*false\)/, 'a new document must earn its own handshake');
});
test('unreachable computers stay hidden behind a quiet static preview and an explicit retry', async () => {
  const text = await read('launch.mjs'), mac = await read('mac/desktop.mjs'), html = await read('index.html');
  const finish = functionSource(text, 'finishMac');
  assert.match(finish, /if\s*\(demoVerified\)\s*revealLive\(\);\s*else\s*\{\s*mac\.offline\(\)/);
  assert.doesNotMatch(finish, /fallbackPrompt|setPhase\('demo-error'\)|location\.|frame\.src/, 'an unavailable live app must not replace the static window with an error page');
  assert.match(text, /frame\.addEventListener\('error',[\s\S]*?demoVerified\s*=\s*false;\s*visible\(demoScreen,\s*false\)/);
  assert.match(text, /\$\('macRetry'\)\.addEventListener\('click',\s*\(\)\s*=>\s*requestDemo\(\)\)/);
  assert.match(html, /class="mac-offline"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /The preview is still here\./);
  assert.match(html, /id="macRetry"[^>]*>Try again<\/button>/);
  assert.match(mac, /function offline\(\)\s*\{[^}]*\.hidden\s*=\s*false/);
  assert.doesNotMatch(functionSource(mac, 'setLive'), /\.remove\(|\.src\s*=/, 'the static preview remains available after a live navigation fails');
});
test('a plain-window line 0 and nine build steps all have M4A voices and enough measured reading time', async () => {
  assert.equal(STEPS.length, 9);
  assert.deepEqual(STEPS.map(s => s.build), ['s-harness', 's-files', 's-browser', 's-messages', 's-memory', 's-make', 's-undo', 's-everywhere', 's-live']);
  assert.deepEqual(STEPS.map(s => s.apps), [['claude', 'chatgpt'], ['finder'], ['safari'], ['kinso'], ['notes'], ['imovie'], ['time-machine'], [], []]);
  for (const [i, step] of [INTRO, ...STEPS].entries()) {
    assert.equal(step.voice, `mac/sounds/line-${i}.m4a`);
    const measured = m4aDurationMs(await readFile(new URL('../../website/' + step.voice, import.meta.url)));
    assert.ok(Number.isFinite(step.durationMs) && step.durationMs + .01 >= measured, `line ${i}: ${step.durationMs} ms holds its measured ${measured} ms voice`);
  }
  const mac = await read('mac/desktop.mjs');
  const play = functionSource(mac, 'play');
  assertBefore(play, 'await sound(INTRO.voice, INTRO.durationMs)', 'STEPS.entries()', 'line 0 finishes over the plain window, before step 1');
  assert.match(play, /sound\(s\.voice,\s*s\.durationMs\)/);
  const waitedVoice = play.match(/await\s+(?:spoken\b|Promise\.all\(\[[^\]]*\bspoken\b[^\]]*\]\))/);
  assert.ok(waitedVoice && play.indexOf('await onfinish') > waitedVoice.index, 'the final spoken line finishes before the real app takes over');
  assert.match(functionSource(mac, 'sound'), /Promise\.all\(\[finished,\s*delay\(durationMs\)\]\)/, 'voice completion and measured duration both hold the step');
  const html = await read('index.html');
  for (const name of STEPS.flatMap(s => s.apps)) assert.ok(html.includes(`data-app="${name}"`), `the Dock contains ${name}`);
});
test('the same native-sized window hosts the live app; apps drop into it, with no grow or crossfade', async () => {
  const css = await read('mac/desktop.css'), sequence = await read('sequence.css');
  assert.doesNotMatch(css, /data-grown|transition: (?:left|opacity 1\.2s)|\.mac\[data-live="true"\]/);
  assert.match(css, /\.mac-window \.demo\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*transition:\s*none/);
  assert.match(css, /\.mac-window \.demo iframe\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*transform:\s*none;[^}]*pointer-events:\s*auto/);
  assert.match(css, /data-hosted="true"[^}]*visibility: hidden/);
  assert.doesNotMatch(css, /\.mac-dock\s*\{[^}]*opacity:\s*0/);
  const mac = await read('mac/desktop.mjs'), drop = functionSource(mac, 'intoWindow');
  assert.doesNotMatch(mac, /toTrash|trashed|mac-remove|function grow/);
  assert.match(drop, /frame\.getBoundingClientRect\(\)/);
  assert.match(drop, /screen\.dispatchEvent\(new CustomEvent\('imperfect:drop'/);
  assert.match(drop, /scale: '\.12', opacity: 0/);
  assert.match(functionSource(mac, 'move'), /if \(reduced.matches\)/);
  assert.match(sequence, /@media \(prefers-reduced-motion: reduce\) \{ :root \{ --fade: 0ms; --handoff: 0ms; --unlock: 0ms; \}/);
});

// ---- The film over the galaxy, its hyperdrive, power and scroll, the black hole in the bubble.
test('the packed film\'s 4:3 picture is contained and centred in any (safe) area', () => {
  for (const area of [{ left: 0, top: 0, width: 1024, height: 640 }, { left: 0, top: 0, width: 390, height: 844 }, { left: 47, top: 0, width: 750, height: 369 }, { left: 0, top: 0, width: 250, height: 390 }]) {
    const r = filmRect(area);
    assert.ok(Math.abs(r.width / r.height - ASPECT) < 1e-9);
    assert.ok(r.width <= area.width + 1e-9 && r.height <= area.height + 1e-9);
    assert.ok(Math.abs(r.width - area.width) < 1e-9 || Math.abs(r.height - area.height) < 1e-9, 'meets two edges');
    assert.ok(Math.abs(r.x + r.width / 2 - (area.left + area.width / 2)) < 1e-9 && Math.abs(r.y + r.height / 2 - (area.top + area.height / 2)) < 1e-9, 'centred');
  }
});
test('hyperdrive: distance is the integrated cue speed; rest outside the cues, flying at 90 s, exactly home after', async () => {
  const cues = JSON.parse(await read('media/v8-cues.json'));
  const table = warpTable(cues);
  for (const t of [0, 30, 81.6, 114.8, 120, 129.7, 400]) assert.deepEqual(table.at(t), { distance: 0, speed: 0 }, `rest at ${t} s`);
  const at90 = table.at(90), beat = b => 7.233 + b * 0.428543;
  assert.ok(at90.speed >= 1 && at90.speed <= 1.7, `full hyperdrive, pulsing: ${at90.speed}`); assert.ok(at90.distance > 0 && at90.distance < 1);
  assert.ok(table.at(105).speed >= 1.25 && table.at(105).speed <= 1.25 * 1.7, 'the spaceship drop');
  assert.ok(table.speed(beat(190) - 0.003) < 1.05 && table.speed(beat(190) + 0.002) > 1.6, 'a kick on the beat that dies away before the next');
  assert.equal(table.at(98.5).speed, 0.05, 'the held breath between them is slow, not stopped');
  // Noah, 15 Oct: accelerate BEFORE the hit, reaching full speed on "malleable" / "it's time".
  for (const [start, end, slow, full] of [[173.67, 176, 0, 1], [213.67, 216, 0.05, 1.25]]) {
    const from = +beat(start).toFixed(3), to = +beat(end).toFixed(3);
    assert.ok(Math.abs(to - from - 1) < 0.003, 'one-second ramp into the beat');
    assert.ok(cues.warp.some(([t, v]) => t === from && v === slow), 'ramp begins at the slow speed');
    assert.equal(table.speed(from), slow);
    assert.ok(table.speed((from + to) / 2) > slow, 'already accelerating before the hit');
    assert.equal(table.speed(to), full * 1.7, 'full hyperdrive with its kick ON the beat');
  }
  let last = 0;
  for (let t = 0; t <= 130; t += 0.05) { const d = table.distance(t); assert.ok(d >= last - 1e-12, 'never flies backwards'); last = d; }
  let raw = 0;
  for (let t = 0; t < 130; t += 0.001) raw += table.speed(t + 0.0005) * 0.6 * 0.001;
  const total = table.distance(120);
  assert.ok(Math.abs(total - Math.round(total)) < 1e-9 && total > 10, 'a whole number of depths, so the sky comes home as it was');
  assert.ok(Math.abs(total - raw) / raw < 0.03, `the film's own pace: ${total} depths vs ${raw.toFixed(2)}`);
  for (const bad of [null, {}, { warp: 'x' }, { warp: [[1, 'x']] }]) assert.deepEqual(warpTable(bad).at(90), { distance: 0, speed: 0 });
});
test('the sky\'s hyperdrive is opt-in: stars.mjs changes nothing unless a speed is given', async () => {
  const stars = await read('stars.mjs');
  assert.match(stars, /tick\(t, pixelRatio, \{ twinkle = true, opacity = 1, flow = 0, twist = 0, rotation = null, avoid = null \} = \{\}\) \{/, 'tick() is as it was');
  assert.match(stars, /warp\(distance = 0, speed = 0\) \{/);
  const scene = await read('scene.mjs');
  assert.match(scene, /stars\.tick\(starTime, renderer\.getPixelRatio\(\), \{ twinkle: motion, opacity: starOpacity, flow, twist: starTwist, rotation: starRotation \}\);\n      stars\.warp\(starWarp, starWarpSpeed\);/, 'the shared sky\'s tick call is untouched (the lock\'s own test pins it)');
  assert.match(stars, /uWarpSpeed: \{ value: 0 \}/);
  const vertex = stars.slice(stars.indexOf('void main()'), stars.indexOf('gl_PointSize'));
  assert.match(vertex, /if \(uWarpSpeed > 0\.0\)/, 'every hyperdrive change sits behind the speed');
  assert.match(stars, /uLens: \{ value: new THREE\.Vector4\(\) \}, uLensScale: \{ value: 0 \}/, 'no lens by default');
  assert.match(vertex, /if \(uLensScale > 0\.0\) \{\n    vec2 o = [^\n]+\n    o = uLens\.zw \+ \(o - uLens\.xy\) \* uLensScale;\n    gl_Position\.xy = [^\n]+\n  \}/, 'every lens change sits behind its scale');
  assert.match(stars, /lens\(from = null, to = null, scale = 1\) \{/);
  const intro = await read('boot/sequence.mjs'), launch = await read('launch.mjs');
  assert.match(launch, /if \(!warp \|\| reduced\.matches \|\| !FILMING\.includes\(phase\)\) return null;/, 'never with reduced motion, only during the film');
  assert.match(intro, /const w = !still && warpOf \? warpOf\(\) : null;/);
});
test('the opener waits for scroll, then the lock gesture primes the film and build voices before asking the locker', async () => {
  const launch = await read('launch.mjs'), intro = await read('boot/sequence.mjs'), lock = await read('lock.mjs');
  // lock.mjs calls onsubmit inside the submit event (Enter, the keyboard's Go, the arrow).
  assert.match(lock, /form\.addEventListener\('submit', event => \{\n    event\.preventDefault\(\);[\s\S]*?\n    onsubmit\(input\.value\);/);
  const press = launch.slice(launch.indexOf('const lock = createLock('), launch.indexOf('function opened('));
  assert.match(press, /onsubmit:\s*password =>\s*\{\s*if \(phase !== 'ready'\) return;\s*gesture\(\);\s*setPhase\('unlocking'\);/);
  assertBefore(press, 'gesture()', 'unlock(password)', 'the gesture before the locker is asked');
  assert.match(press, /if \(!bench\)\s*\{\s*setPhase\('ready'\);\s*lock\.wrong\(\);/, 'a wrong password: the field says so, nothing else');
  assert.match(press, /opened\(bench\);\s*lock\.open\(\);\s*leaveLock\(\);\s*skipped\s*\?\s*openComputer\(\)\s*:\s*showFilm\(\)/, 'a correct password opens the lock and leads to the film, not another opener');
  const gesture = functionSource(launch, 'gesture');
  assert.match(gesture, /intro\?\.prime\(\);/); assert.match(gesture, /primeVideo\(video,\s*\{\s*isCurrent:/);
  assert.match(gesture, /mac\.prime\(\)/, 'the build voices share the password activation');
  const start = functionSource(launch, 'startOpener'), showLock = functionSource(launch, 'showLock');
  assert.match(start, /intro\.start\(\{\s*auto:\s*false\s*\}\)/);
  assert.match(showLock, /if\s*\(!openerDone\s*\|\|\s*!lockChecked/, 'neither credentials nor a remembered unlock skip the word/goat opener');
  const completed = launch.slice(launch.indexOf("addEventListener('imperfect:intro'"), launch.indexOf('const FILMING'));
  assert.match(completed, /type === 'complete'[\s\S]*openerDone\s*=\s*true;[\s\S]*showLock\(\)/, 'the completed opener reveals the lock');
  assert.match(intro, /prime\(\) \{ sound\.prime\(\); \},/, 'the boot sound\'s AudioContext resumed');
  assert.match(launch, /intro\.start\(\{ auto: false \}\)/);
  assert.match(intro, /start\(\{ auto = true \} = \{\}\) \{ if \(S\.started \|\| suspended\) return; S\.started = true; sound\.prime\(\); loadGoat\(\); if \(auto\) approach\(\); else wake\(\); \}/);
  assert.match(intro, /sound\.start\(t\); soundAt = t;/, 'the boot sound starts at the touch');
  assert.match(intro, /quiet\(\) \{ quieted = true; sound\.setMuted\(true\);/, 'and stops where the film begins');
  assert.match(launch, /if \(type === 'complete' && \['intro', 'contact'\]\.includes\(phase\)\)/);
  assert.doesNotMatch(launch + lock, /\.noah\.imperfect\.computer|door\/ticket|scrypt|=== password|password ===/, 'no workbench and no password check in the page: the locker has them');
});
test('scrolling and swiping go both ways until the touch, as the lock\'s do; from the touch they stay together', async () => {
  const intro = await read('boot/sequence.mjs');
  const move = intro.slice(intro.indexOf('function move(px)'), intro.indexOf('\n}\n', intro.indexOf('function move(px)')));
  assert.match(move, /S\.scrolled = clamp\(S\.scrolled \+ px \* 5 \/ innerHeight, 0, TOUCH - 1\);/, 'back as far as apart, forward as far as the touch, in screens (a resize keeps the place)');
  assert.doesNotMatch(intro, /oneWay/);
  assert.match(intro, /bindLockScroll\(\{ active: \(\) => S\.started && S\.phase === 'scene' && !S\.auto/, 'only before the touch');
});
test('after the word, the J06 goat at the same optical middle: a clean cut in, held, a fade out; then the lock', async () => {
  const T = goatTimes(), still = goatTimes({ still: true });
  assert.equal(T.from, WORD.gone, 'it starts as the word has gone');
  assert.ok(Math.abs(T.whole - T.from - GOAT.in) < 1e-9 && Math.abs(T.out - T.whole - 1.5) < 1e-9 && Math.abs(T.gone - T.out - GOAT.out) < 1e-9);
  assert.ok(Math.abs(T.gone - WORD.gone - 3.3) < 1e-9, 'the goat holds the opener for another 3.3 s before the lock');
  assert.ok(Math.abs(still.gone - WORD.gone - 2.1) < 1e-9, 'reduced motion: a short plain fade each way');
  assert.equal(goatAt(WORD.gone - .01).on, false); assert.equal(goatAt(T.gone).on, false);
  assert.deepEqual(goatAt((T.whole + T.out) / 2), { on: true, opacity: GOAT.peak, scale: 1, blur: 0 });
  for (const tau of [T.from, T.from + GOAT.in / 2, T.out])
    assert.deepEqual(goatAt(tau), { on: true, opacity: GOAT.peak, scale: 1, blur: 0 }, `${tau}: cut in whole, no fade in`);
  const fading = [T.out + GOAT.out / 4, T.out + GOAT.out / 2, T.gone - 1e-3].map(tau => goatAt(tau).opacity);
  assert.ok(fading[0] < GOAT.peak && fading[1] < fading[0] && fading[2] < fading[1] && fading[2] < 0.01, `then a calm fade out: ${fading}`);
  assert.deepEqual(goatAt(still.from + GOAT.still / 2, { still: true }), { on: true, opacity: GOAT.peak, scale: 1, blur: 0 }, 'reduced motion the same');
  const intro = await read('boot/sequence.mjs');
  assert.match(intro, /if \(tau < WORD\.gone\) return;\n\s*rv\.goat \?\?= goatReady;\n\s*if \(rv\.goat && tau < goatTimes\(\{ still: reduced\.matches \|\| rv\.fade \}\)\.gone\) return;/, 'opener completion waits for the goat (if its picture came)');
  assert.doesNotMatch(intro + await read('launch.mjs'), /129\.7/, 'nothing depends on the film\'s length');
  // The lightest web version of the J06 mark: one webp, trimmed to its ink, 640 px tall.
  const webp = await readFile(new URL('../../website/intro/goat-j06.webp', import.meta.url));
  assert.equal(webp.toString('latin1', 0, 4) + webp.toString('latin1', 8, 16), 'RIFFWEBPVP8X');
  assert.deepEqual([webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1], GOAT.size);
  assert.ok(webp.length < 60_000, `${webp.length} bytes`);
});
test('the word and the goat stand on their ink\'s mass, not their box: the word 2.7 % of its ink right of where it was', async () => {
  for (const [w, h] of [[1920, 1080], [1024, 640], [390, 844], [844, 390]]) {
    const box = placeWordmark(w, h), [x, y, mw, mh] = opticalWordmark(box);
    assert.ok(Math.abs(x + mw / 2 + MASS.wordmark[0] * mw - w / 2) < 1e-9, 'the word\'s mass on the centre line');
    assert.ok(Math.abs((x - box[0]) / mw - 0.02658) < 1e-9 && y === box[1] && mw === box[2] && mh === box[3], 'moved right only');
    const [gx, gy, gw, gh] = placeGoat(w, h, [x, y, mw, mh]);
    assert.ok(Math.abs(gx + gw / 2 + MASS.goat[0] * gw - w / 2) < 1e-9 && Math.abs(gy + gh / 2 + MASS.goat[1] * gh - h / 2) < 1e-9, 'the goat\'s mass at the middle');
    assert.ok(Math.abs(gh - GOAT.height * mh) < 1e-9 && Math.abs(gw / gh - GOAT.size[0] / GOAT.size[1]) < 1e-9);
  }
  const wordmark = await read('wordmark.mjs');
  assert.doesNotMatch(wordmark, /goat|MASS|optical/i, 'wordmark.mjs (shared with the OS lock) is as it was');
});
// a plain field for the black hole: n stars spread over the screen in the z = 0 plane, the camera straight above it
const plainField = (width, height, n = 4000) => {
  const position = new Float32Array(n * 3), size = new Float32Array(n).fill(2), alpha = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) { position[i * 3] = (i * 7919 % width); position[i * 3 + 1] = -(i * 104729 % height); }
  return { stars: { geometry: { attributes: { position: { array: position, count: n }, size: { array: size }, alpha: { array: alpha } } } },
    camera: { position: { x: width / 2, y: -height / 2, z: 1000 } } };
};
const SCREENS = [[1024, 640, [512, 400]], [390, 844, [195, 520]], [844, 390, [430, 210]], [1920, 1080, [960, 620]]];
test('the black hole runs whole in the bubble from the touch: its ring stays inside the bubble, the burst is on BURST', async () => {
  const intro = await read('boot/sequence.mjs');
  const [, grow, fit] = intro.match(/const GROW = ([\d.]+), HOLE_FIT = ([\d.]+);/).map(Number);
  const [, zoom] = intro.match(/const LOOK = [\d.]+, ZOOM = ([\d.]+);/).map(Number);
  assert.match(intro, /contactBurst\(\{[^}]*whole: true, radius: HOLE_FIT \* bubble,\s*source: sourceFor\(innerWidth, innerHeight\), zoom: ZOOM \}\)/);
  assert.match(intro, /const b = revealAt\(tau, \{ at: rv\.at, width: innerWidth, height: innerHeight, scale: view\.s, grow: GROW, motion: soundMotion \}\);/, 'the bubble the ring must fit: the sound\'s');
  for (const [width, height, at] of SCREENS) {
    const { stars, camera } = plainField(width, height), source = [width * 0.7, height * 0.35];
    const small = revealAt(0, { at, width, height, grow }).small;
    const burst = contactBurst({ stars, camera, at, width, height, whole: true, radius: fit * small, source, zoom });
    assert.equal(burst.phase, 'ring');
    let tightest = Infinity;
    for (let tau = 0.6; tau < BURST - 0.02; tau += 0.01) {
      const info = burst.update(tau), R = revealAt(tau, { at, width, height, grow, motion: soundMotion }).R;
      // the ring is drawn through the bubble's lens, at its scale
      if (info.ringRadius > 0) tightest = Math.min(tightest, R / (info.ringRadius * burst.lens.scale * 1.025)); // the ring's own 2.5% jitter
    }
    assert.ok(tightest >= 1, `${width}x${height}: the ring stays inside the bubble's edge (${tightest.toFixed(3)})`);
    assert.equal(burst.update(BURST - 0.02).phase, 'shrink', 'the point flickers up to the beat');
    assert.equal(burst.update(BURST + 0.001).phase, 'explode', 'and bursts on it');
  }
});
test('the bubble looks onto a part of the sky as rich as the open galaxy, not the quiet middle it opens in (pickSource)', async () => {
  const { createStars } = await import('../../website/stars.mjs');
  const intro = await read('boot/sequence.mjs');
  const [, grow] = intro.match(/const GROW = ([\d.]+), HOLE_FIT/).map(Number);
  const [, LOOK, ZOOM] = intro.match(/const LOOK = ([\d.]+), ZOOM = ([\d.]+);/).map(Number);
  assert.ok(ZOOM > 0 && ZOOM < 1, 'the bubble shows more of it, smaller');
  for (const [width, height, at] of SCREENS) {
    const stars = createStars({ width, height }), D = distanceFor(height);
    stars.place(width, height, D);
    const kinds = stars.geometry.attributes.kind.array, { position, alpha } = stars.base;
    const look = LOOK * revealAt(0, { at, width, height, grow }).small / ZOOM, field = { positions: position, kinds, alphas: alpha, D, width, height, look };
    const t0 = performance.now(), pick = pickSource(field), ms = performance.now() - t0;
    assert.deepEqual(pickSource(field), pick, 'the same screen, the same place');
    assert.ok(ms < 80, `${width}x${height}: quick enough to work out ahead of the touch (${ms.toFixed(1)} ms)`);
    // measured independently: every star where it shows on the screen
    const n = position.length / 3, sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = 1 - position[i * 3 + 2] / D;
      sx[i] = width / 2 + (position[i * 3] - width / 2) / k; sy[i] = height / 2 + (-position[i * 3 + 1] - height / 2) / k;
    }
    const dust = ([x, y]) => { let sum = 0; for (let i = 0; i < n; i++) if (kinds[i] === 0 && Math.hypot(sx[i] - x, sy[i] - y) <= look) sum += alpha[i]; return sum; };
    const bursts = ([x, y]) => { let c = 0; for (let i = 0; i < n; i++) { const d = Math.hypot(sx[i] - x, sy[i] - y); if (kinds[i] === 1 && d > 0.25 * look && d < 0.75 * look) c++; } return c; };
    const sky = [];
    for (let y = look; y <= height - look; y += look / 2) for (let x = look; x <= width - look; x += look / 2) sky.push(dust([x, y]));
    sky.sort((p, q) => p - q);
    const median = sky[sky.length >> 1], here = dust(pick);
    assert.ok(pick[0] - look >= 0 && pick[0] + look <= width && pick[1] - look >= 0 && pick[1] + look <= height, `${width}x${height}: the window is on the screen (${pick})`);
    assert.ok(here >= median, `${width}x${height}: as rich as the open sky (${here.toFixed(1)} vs median ${median.toFixed(1)})`);
    const middle = dust([width / 2, height / 2]);
    assert.ok(here >= 2 * middle, `${width}x${height}: richer than the screen's quiet middle (${here.toFixed(1)} vs ${middle.toFixed(1)})`);
    assert.ok(bursts(pick) >= 1, `${width}x${height}: a four-point star in it, beside where the ring forms`);
  }
});
test('before BURST the bubble\'s lens looks onto the source and the ring forms from the stars round it; from BURST it is the lock\'s own burst at the touch, star for star', () => {
  for (const [width, height, at] of SCREENS) {
    const source = [width * 0.7, height * 0.35], zoom = 0.4, radius = 0.05 * Math.min(width, height);
    const site = plainField(width, height), lock = plainField(width, height), plain = plainField(width, height);
    const n = site.stars.geometry.attributes.position.count, home = site.stars.geometry.attributes.position.array.slice();
    const s = contactBurst({ ...site, at, width, height, whole: true, radius, source, zoom });
    const l = contactBurst({ ...lock, at, width, height });
    assert.equal(l.lens, null, 'the lock has no lens'); assert.equal(l.whole, false);
    assert.equal(contactBurst({ ...plain, at, width, height, whole: true, radius }).lens, null, 'nor the whole hole without a source');
    assert.deepEqual(s.source, source);
    // the ring: every star that has moved by the end of the ring's flight is one of the 4 x ring-count nearest the source
    const M = Math.max(36, Math.min(96, Math.round(n * 0.024)));
    const near = Array.from({ length: n }, (_, i) => Math.hypot(home[i * 3] - source[0], -home[i * 3 + 1] - source[1])).sort((p, q) => p - q)[4 * M - 1];
    const ringEnd = HOLE.ring * BURST / WHOLE.reduce((sum, name) => sum + HOLE[name], 0);
    s.update(ringEnd - 0.02);
    const pos = site.stars.geometry.attributes.position.array, moved = [];
    for (let i = 0; i < n; i++) if (pos[i * 3] !== home[i * 3] || pos[i * 3 + 1] !== home[i * 3 + 1]) moved.push(Math.hypot(home[i * 3] - source[0], -home[i * 3 + 1] - source[1]));
    assert.ok(moved.length > M / 2 && moved.length <= M, `${width}x${height}: the ring's stars are flying in (${moved.length} of ${M})`);
    assert.ok(Math.max(...moved) <= near + 1e-3, `${width}x${height}: from round the source (${Math.max(...moved).toFixed(1)} <= ${near.toFixed(1)})`);
    for (const tau of [0.05, 0.3, 1, 2, 3, 4, 5, BURST - 0.01]) {
      const info = s.update(tau);
      assert.deepEqual(s.lens, { from: source, to: at, scale: zoom }, `${width}x${height}: lens at ${tau}`);
      assert.ok(Math.abs(info.center.x - source[0]) < 1e-9 && Math.abs(info.center.y + source[1]) < 1e-9, 'the hole sits at the source');
    }
    for (const tau of [BURST + 0.05, BURST + 0.4, BURST + 1, BURST + 2.5]) {
      s.update(tau); l.update(tau);
      assert.equal(s.lens, null, `${width}x${height}: no lens once it bursts (${tau})`);
      assert.equal(s.phase, l.phase);
      for (const name of ['position', 'size', 'alpha']) assert.deepEqual(site.stars.geometry.attributes[name].array, lock.stars.geometry.attributes[name].array, `${width}x${height}: ${name} at ${tau} as the lock's`);
    }
    assert.ok(s.done && l.done);
  }
});
test('ringNear is opt-in: by default the black hole is the lock\'s, star for star, every phase', () => {
  const field = (n, seed) => {
    let t = seed; const r = () => ((t = Math.imul(t ^ (t >>> 15), 1 | t) + 0x6d2b79f5 >>> 0) / 4294967296);
    const positions = new Float32Array(n * 3), sizes = new Float32Array(n), alphas = new Float32Array(n);
    for (let i = 0; i < n; i++) { positions[i * 3] = r() * 1200; positions[i * 3 + 1] = -r() * 800; positions[i * 3 + 2] = (r() - 0.5) * 600; sizes[i] = 1 + 3 * r(); alphas[i] = r(); }
    return { positions, sizes, alphas };
  };
  const cases = [{}, { start: 'explode' }, { unwind: false, eye: { x: 600, y: -400, z: 1400 } }, { reducedMotion: true }, { ringCount: 40, seed: 3, ring: 0.9, consume: 1.4 }, { ringNear: 0 }];
  for (const options of cases) {
    const a = field(3000, 11), b = field(3000, 11);
    const before = holeBefore({ ...a, center: { x: 610, y: -390, z: 0 }, radius: 70, ...options });
    const after = createBlackHole({ ...b, center: { x: 610, y: -390, z: 0 }, radius: 70, ...options });
    assert.equal(after.duration, before.duration); assert.equal(after.ringCount, before.ringCount);
    for (let t = 0; t < before.duration + 0.3; t += 1 / 30) {
      const p = before.update(1 / 30), q = after.update(1 / 30);
      assert.deepEqual({ ...q, center: { ...q.center } }, { ...p, center: { ...p.center } }, `${JSON.stringify(options)} at ${t.toFixed(2)}`);
      assert.deepEqual(b.positions, a.positions); assert.deepEqual(b.sizes, a.sizes); assert.deepEqual(b.alphas, a.alphas);
    }
  }
});test('reveal motion stays unchanged apart from the opaque silver rim, and kept-sky imports remain served', async () => {
  const views = [{ at: [512, 320], width: 1024, height: 640 }, { at: [195, 400], width: 390, height: 844, scale: 0.4 }, { at: [960, 620], width: 1920, height: 1080 }];
  let n = 0;
  for (const view of views) for (let tau = 0; tau < 6.4; tau += 0.0137) {
    const now = revealAt(tau, view), then = revealBefore.revealAt(tau, view);
    assert.deepEqual(now, { ...then, rim: 1 }, `only rim opacity changes at ${tau.toFixed(4)}`);
    const path = pathBefore(...view.at, Math.max(0.01, then.R), then.wt, then.wob);
    assert.equal(bubblePath(...view.at, Math.max(0.01, now.R), now.wt, now.wob), path, `bubblePath at ${tau.toFixed(4)}`);
    assert.equal(bubblePath(...view.at, Math.max(0.01, now.R), now.wt, now.wob, now), path, 'the lock\'s own motion has no ripples or grain');
    n++;
  }
  assert.ok(n > 1000);
  for (const [width, height, at] of SCREENS) {
    const a = plainField(width, height), b = plainField(width, height);
    const now = contactBurst({ ...a, at, width, height }), then = revealBefore.contactBurst({ ...b, at, width, height });
    for (const tau of [BURST, BURST + 0.1, BURST + 0.7, BURST + 2.1]) {
      assert.equal(now.update(tau).phase, then.update(tau).phase);
      for (const name of ['position', 'size', 'alpha']) assert.deepEqual(a.stars.geometry.attributes[name].array, b.stars.geometry.attributes[name].array, `the lock's burst: ${name} at ${tau}`);
    }
  }
  // imperfect OS serves only these website files (system/server.mjs WEBSITE_SKY): they must not reach for the new ones
  const sky = ['sky.mjs', 'stars.mjs', 'bootup.mjs', 'bootup-envelope.mjs', 'vendor/three.module.js', 'vendor/three.core.js'];
  for (const file of sky.filter(f => !f.startsWith('vendor/'))) {
    for (const [, path] of (await read(file)).matchAll(/from '\.\/([^']+)'/g)) assert.ok(sky.includes(path), `${file} imports ${path}, which the OS does not serve`);
  }
  const bootup = await read('bootup.mjs');
  assert.doesNotMatch(bootup, /bootup-sound|bubble-sound|HITS2/, 'bootup.mjs keeps the lock\'s mapping and imports nothing new');
});
test('the website\'s bubble follows the sound (opt-in): it peaks on the 12 hits, stays 0.46-1.11 of its size, shines, and opens by 6.167 s', async () => {
  assert.deepEqual(SOUND_HITS, HITS2.filter(([t, , kind]) => t <= BURST && kind < 2).map(([t]) => t));
  assert.equal(SOUND_HITS.length, 12);
  for (const h of SOUND_HITS) {
    let top = -1, when = 0;
    for (let t = h - 0.03; t <= h + 0.03; t += 0.0005) { const k = soundKick(t); if (k > top) { top = k; when = t; } }
    assert.ok(Math.abs(when - h) <= 0.001, `the leap peaks on the hit at ${h} s (${((when - h) * 1000).toFixed(1)} ms)`);
    assert.ok(soundMotion(h).radius >= 1.2 * soundMotion(h - 0.02).radius, `and it shows: ${h} s`);
    assert.ok(soundMotion(h + 0.05).ripples.length > 0, `a ripple runs round the rim after ${h} s`);
  }
  let lo = Infinity, hi = -Infinity, last = -1;
  for (let t = SOUND_HITS[0]; t <= BURST; t += 0.001) { const r = soundMotion(t).radius; lo = Math.min(lo, r); hi = Math.max(hi, r); }
  assert.ok(lo >= 0.45 && hi <= 1.12, `between the first hit and the burst: ${lo.toFixed(3)}..${hi.toFixed(3)}`);
  for (let t = 0; t < BURST + 1; t += 0.001) {
    const m = soundMotion(t, 0.8);
    assert.ok(m.shine >= 0 && m.shine <= 1 && m.kick >= 0 && m.kick <= 1);
    if (t <= BURST) assert.equal(m.ex, 0); else assert.ok(m.ex >= last - 1e-12, 'the opening never closes');
    last = m.ex;
  }
  assert.equal(soundMotion(BURST + 0.8 - 1e-9).done, false); assert.equal(soundMotion(BURST + 0.8).done, true); assert.equal(soundMotion(BURST + 0.8).ex, 1);
  assert.deepEqual(soundMotion(BURST + 0.8).ripples, []);
  // through revealAt: the sound's radius and touch glow; the silver rim stays opaque
  const view = { at: [512, 320], width: 1024, height: 640, grow: 1.5 };
  for (const tau of [0.4, 1.19, 3, 4.33, 5.2]) {
    const b = revealAt(tau, { ...view, motion: soundMotion }), m = soundMotion(tau, 0.8), plain = revealAt(tau, view);
    assert.ok(Math.abs(b.R - b.small * m.radius) < 1e-9 && b.shine === m.shine);
    assert.ok(Math.abs(b.glow - plain.glow * (0.8 + 0.2 * m.shine)) < 1e-12);
    assert.equal(b.rim, 1);
  }
  const intro = await read('boot/sequence.mjs');
  assert.match(intro, /import \{ soundMotion \} from '\.\.\/bubble-sound\.mjs';/);
  assert.match(intro, /revealAt\(tau, \{[^}]*motion: soundMotion \}\)/, 'the launch page draws the sound\'s bubble');
  assert.match(intro, /bubblePath\([^;]*, b\.wt, b\.wob, b\);/, 'and passes its ripples and grain to the rim');
  // (The world page, which drew the lock's own bubble, is gone; the lock's is checked as it was above.)
});
