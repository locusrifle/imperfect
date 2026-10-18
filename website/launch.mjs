import { config } from './launch-config.mjs?v=09347c5c';
import { demoAddress, isDemoReady, waitForMedia, primeVideo, playVideo, firstVideoFrame, fadeDuration, preloadDue } from './media.mjs';
import { createFilmLayer, warpTable } from './film.mjs';
import { createLock, remembered, unlock } from './lock.mjs';
import { createMac } from './mac/desktop.mjs?v=clone-3';
import { initShell, getShellWindow, setTrash } from './mac/shell.mjs?v=clone-3';
import { initShop } from './shop.mjs?v=clone-3';
import { createPhone } from './mac/phone.mjs?v=clone-3';
const $ = id => document.getElementById(id);
const video = $('film'), frame = $('computer'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
const introScreen = $('introScreen'), filmScreen = $('filmScreen'), demoScreen = $('demoScreen');
const lockScreen = $('lockScreen'), hint = $('hint'), announce = $('announce');
const layer = createFilmLayer({ video, canvas: $('filmCanvas'), screen: filmScreen, area: $('filmArea') });
// Measurable behind the opener, still transparent and inert.
$('macScreen').hidden = false;
initShell({ stage: $('macScreen'), appWindow: document.querySelector('.mac-window'), frame, dock: document.querySelector('.mac-dock') });
initShop({ open: openShop, restore: () => getShellWindow('imperfect')?.restore() });
const phone = createPhone({ stage: $('macScreen'), appWindow: document.querySelector('.mac-window'), device: document.querySelector('.mac-phone'), frame: $('phoneComputer'), reduced });
const mac = createMac({ screen: $('macScreen'), curtain: $('curtain'), reduced, onstage: assemble, onfinish: finishMac, ontrash: setTrash, onphone: phone.exhibit });
video.src = config.videoUrl;
let phase = 'loading', intro = null, introReady = false, openerDone = false, lockChecked = false;
let workbench = null, demo = null, unlocked = false, primed = false, skipped = false;
let generation = 0, pendingMedia = null, stallTimer = null, hintTimer = null, warp = null, skyLive = false;
let demoLoaded = false, demoVerified = false, frameLoads = 0, frameAsk = 0, demoPreloadAt = null, ending = false, endingReady = false;
let lastMediaTime = 0, pausedByVisibility = false;
const ASSEMBLY = ['bare', 'claude', 'codex', 'files', 'browser', 'done'];
let desiredStep = reduced.matches ? 'done' : 'bare', paintedStep = null;
const assemblyHistory = [], assemblyWaiters = new Set();
function waitForAssembly(step, ms = config.demoTimeoutMs) {
  if (demoVerified && ASSEMBLY.indexOf(paintedStep) >= ASSEMBLY.indexOf(step)) return Promise.resolve(true);
  return new Promise(resolve => {
    const waiter = { step, resolve: ok => { clearTimeout(waiter.timer); assemblyWaiters.delete(waiter); resolve(ok); } };
    waiter.timer = setTimeout(() => waiter.resolve(false), ms); assemblyWaiters.add(waiter);
  });
}
function sendAssembly() {
  if (!demoVerified || !demo) return;
  assemblyHistory.push({ step: desiredStep, sentAt: performance.now(), paintedAt: null });
  frame.contentWindow.postMessage({ type: 'imperfect:assemble', step: desiredStep }, demo.origin);
}
function assemble(step) {
  if (!ASSEMBLY.includes(step) || ASSEMBLY.indexOf(step) < ASSEMBLY.indexOf(desiredStep)) return Promise.resolve(false);
  desiredStep = step;
  if (paintedStep !== step) sendAssembly();
  return waitForAssembly(step);
}
async function openShop(url) {
  if (!demoVerified || paintedStep !== 'done') {
    say('The Shop will open when your computer is ready.');
    if (!await waitForAssembly('done')) { say('Your computer is not available yet. Try again, then open Shop.'); return false; }
  }
  if (!demoVerified || !demo || paintedStep !== 'done') return false;
  frame.contentWindow.postMessage({ type: 'imperfect:open', url }, demo.origin);
  say('Opening Shop in your computer’s browser.');
  return true;
}
fetch(config.cuesUrl).then(r => r.ok ? r.json() : null).then(cues => { warp = cues ? warpTable(cues) : null; }).catch(() => {});
function setPhase(next) {
  phase = next; document.body.dataset.phase = next;
  dispatchEvent(new CustomEvent('imperfect:sequence', { detail: { phase } }));
}
function say(text = '') { announce.textContent = text; }
function visible(el, on) {
  el.dataset.visible = String(on); el.setAttribute('aria-hidden', String(!on)); el.inert = !on;
}
function prompt(text = '', play = false) {
  $('status').textContent = text; $('prompt').hidden = !text;
  $('action').hidden = !play; $('action').textContent = 'Play film';
  $('retry').hidden = play || !text; $('fallback').hidden = true;
  say(text);
}
function gesture() {
  intro?.prime(); mac.prime();
  if (primed) return;
  primed = true;
  const id = generation;
  primeVideo(video, { isCurrent: () => id === generation && !['film', 'mac', 'demo'].includes(phase) }).catch(() => { primed = false; });
}
// The opener comes first. Its first press unlocks sound; scrolling alone does not fake an activation.
for (const type of ['pointerdown', 'keydown', 'touchend']) addEventListener(type, event => {
  if (event.isTrusted && ['intro', 'contact'].includes(phase)) gesture();
}, { capture: true, passive: true });
function hideHint() { clearTimeout(hintTimer); hint.dataset.on = 'false'; }
function showHint() { if (phase === 'intro' && !intro?.state().moved) hint.dataset.on = 'true'; }
function startOpener() {
  if (!introReady || phase !== 'loading') return;
  intro.start({ auto: false });
  setPhase('intro'); say('Scroll, swipe up, or press an arrow key to bring them together.');
  if (config.scrollHint) hintTimer = setTimeout(showHint, config.hintAfterMs);
}
function showLock() {
  if (!openerDone || !lockChecked || !['loading', 'intro', 'contact'].includes(phase)) return;
  if (unlocked) { leaveLock(); skipped ? openComputer() : showFilm(); return; }
  setPhase('ready'); intro?.lockSky(true); lockScreen.hidden = false; lockScreen.dataset.on = 'true';
  lockScreen.dataset.sky = 'on'; lock.show({ focus: matchMedia('(pointer: fine)').matches }); say('Enter the password.');
}
function leaveLock() {
  const ms = fadeDuration(reduced.matches, config.unlockMs);
  // The opener has already become the galaxy: keep it under the trailer, never fade back to the painting.
  lock.leave(); lockScreen.dataset.on = 'false';
  setTimeout(() => { lockScreen.hidden = true; }, ms);
}
const lock = createLock({ screen: lockScreen, form: $('lock'), field: $('field'), input: $('password'), dots: $('dots'), reduced, onsubmit: password => {
  if (phase !== 'ready') return;
  gesture(); setPhase('unlocking'); lock.checking(); say('Checking…');
  unlock(password).then(bench => {
    if (phase !== 'unlocking') return;
    if (!bench) { setPhase('ready'); lock.wrong(); say('Wrong password.'); return; }
    opened(bench); lock.open(); leaveLock(); skipped ? openComputer() : showFilm();
  });
} });
function opened(bench) {
  workbench = bench; unlocked = true; demo = demoAddress(bench.url, location.href);
}
remembered().then(bench => { lockChecked = true; if (bench) opened(bench); showLock(); });
document.addEventListener('keydown', event => {
  if (phase !== 'intro' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Spacebar', 'Enter'].includes(event.key)) return;
  if (event.target.closest?.('a, button, input, textarea, select')) return;
  event.preventDefault(); intro?.approach();
});
addEventListener('imperfect:intro', event => {
  const type = event.detail.type;
  if (type === 'move') hideHint();
  if (type === 'touch' && phase === 'intro') { hideHint(); setPhase('contact'); }
  if (type === 'complete' && ['intro', 'contact'].includes(phase)) {
    openerDone = true; skyLive = intro?.state().sky === 'webgl'; showLock();
  }
});
const FILMING = ['film-loading', 'film', 'film-paused', 'film-blocked', 'film-error'];
function warpNow() {
  if (!warp || reduced.matches || !FILMING.includes(phase)) return null;
  return warp.at(video.currentTime);
}
function galaxy(on) {
  if (on && intro && skyLive && layer.mode === 'webgl') { introScreen.hidden = false; intro.sky(true); }
  else { intro?.sky(false); introScreen.hidden = true; }
}
function clearStall() { clearTimeout(stallTimer); stallTimer = null; }
async function showFilm({ fromStart = true } = {}) {
  const id = ++generation; pendingMedia?.abort(); clearStall(); hideHint();
  pendingMedia = new AbortController(); intro?.quiet(); galaxy(skyLive);
  setPhase('film-loading'); prompt(); say('Loading the film…');
  try {
    await waitForMedia(video, { timeoutMs: config.mediaTimeoutMs, signal: pendingMedia.signal });
    if (id !== generation) return;
    video.volume = 1; video.muted = false; if (fromStart) video.currentTime = 0;
    await playVideo(video, { timeoutMs: config.mediaTimeoutMs, signal: pendingMedia.signal });
    await firstVideoFrame(video);
    if (id !== generation) return;
    layer.start(); setPhase('film'); prompt(); visible(filmScreen, true); mac.prepare();
    if (layer.mode !== 'webgl') galaxy(false);
  } catch (error) {
    if (id !== generation || error.name === 'AbortError') return;
    video.pause(); setPhase(error.name === 'NotAllowedError' ? 'film-blocked' : 'film-error');
    prompt(error.name === 'NotAllowedError' ? 'Tap to play with sound.' : 'The film is unavailable. Retry.', error.name === 'NotAllowedError');
  }
}
layer.onplain = () => { if (phase === 'film') galaxy(false); };
function watchStall() {
  if (phase !== 'film' || stallTimer !== null) return;
  stallTimer = setTimeout(() => { video.pause(); setPhase('film-error'); prompt('The film stopped loading. Retry.'); clearStall(); }, config.mediaTimeoutMs);
}
async function showMac() {
  ++generation; clearStall(); hideHint(); setPhase('mac'); prompt(); say('A Mac, with your own app being built on it.');
  if (!frame.getAttribute('src')) await requestDemo();
  const ready = await waitForAssembly('bare');
  await mac.reveal(); visible(filmScreen, false); galaxy(false); layer.stop();
  if (ready) mac.play();
  else { await mac.complete(); await finishMac(); }
}
// Refresh the one-minute ticket immediately before navigating. An unverified
// document is never displayed; there is no static imitation to swap in or out.
async function requestDemo() {
  const ask = ++frameAsk;
  demoVerified = demoLoaded = false; paintedStep = null; frameLoads = 0; mac.live(false); mac.present(false);
  visible(demoScreen, false);
  const bench = await remembered();
  if (ask !== frameAsk || !workbench) return;
  if (bench?.id !== workbench.id) { if (ending) mac.offline(); return; }
  workbench = bench; demo = demoAddress(bench.url, location.href);
  visible(demoScreen, false); demoScreen.hidden = false; frame.src = demo.href;
}
function preloadDemo() {
  if (phase !== 'film' || document.hidden || stallTimer !== null || demoPreloadAt !== null) return;
  if (!preloadDue(video, { afterS: config.preloadAfterS, aheadS: config.preloadAheadS })) return;
  demoPreloadAt = video.currentTime; requestDemo();
}
async function finishMac() {
  ending = true;
  // Slow builds may outlive the ticket; its authenticated document, not the original ticket, confirms readiness.
  if (!frame.getAttribute('src')) await requestDemo();
  mac.finish();
  endingReady = true;
  if (demoVerified && paintedStep === 'done') revealLive();
  else { mac.offline(); say('Your computer is not available yet. Try again.'); }
}
// From bare through done, this is the same real document at the same size.
// The build only adds the product's own capabilities; done enables interaction.
function presentBuild() {
  if (!demoVerified || !paintedStep) return;
  visible(demoScreen, true);
  demoScreen.inert = !endingReady;
  demoScreen.setAttribute('aria-hidden', String(!endingReady));
  mac.present(true);
}
function revealLive() {
  if (!endingReady || !demoVerified || paintedStep !== 'done') return;
  presentBuild(); mac.live(true); setPhase('demo'); say('The computer is ready.');
}
frame.addEventListener('load', () => {
  if (!frame.getAttribute('src')) return;
  if (++frameLoads > 1) { demoVerified = false; paintedStep = null; visible(demoScreen, false); mac.present(false); mac.live(false); if (ending) mac.offline(); }
  demoLoaded = true;
});
frame.addEventListener('error', () => {
  demoVerified = false; paintedStep = null; visible(demoScreen, false); mac.present(false); mac.live(false); if (ending) mac.offline();
});
addEventListener('message', event => {
  if (!demo || event.source !== frame.contentWindow || event.origin !== demo.origin) return;
  if (isDemoReady(event, frame, demo, config.demoReadyType)) {
    demoVerified = true; sendAssembly();
    if (!skipped && !reduced.matches) phone.prepare(demo.origin);
    return;
  }
  if (!demoVerified || event.data?.type !== 'imperfect:assembled') return;
  const step = event.data.step;
  if (!ASSEMBLY.includes(step) || ASSEMBLY.indexOf(step) > ASSEMBLY.indexOf(desiredStep) || ASSEMBLY.indexOf(step) < ASSEMBLY.indexOf(paintedStep)) return;
  paintedStep = step;
  const record = assemblyHistory.findLast(row => row.step === step && row.paintedAt === null);
  if (record) record.paintedAt = performance.now();
  for (const waiter of [...assemblyWaiters]) if (ASSEMBLY.indexOf(step) >= ASSEMBLY.indexOf(waiter.step)) waiter.resolve(true);
  presentBuild(); if (ending) revealLive();
});
// Mounting a cross-origin page must not steal the lock's keyboard focus.
let lastFocus = null;
document.addEventListener('focusin', event => { if (event.target !== frame) lastFocus = event.target; });
addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement !== frame || !demoScreen.inert) return;
  if (lastFocus?.isConnected && lastFocus.getClientRects().length) lastFocus.focus({ preventScroll: true }); else frame.blur();
}));
async function openComputer() {
  intro?.quiet(); intro?.suspend(); video.pause(); layer.stop();
  setPhase('mac');
  desiredStep = 'done';
  if (!frame.getAttribute('src')) await requestDemo();
  await mac.complete(); await waitForAssembly('done');
  await mac.reveal(); visible(filmScreen, false); galaxy(false);
  await finishMac();
}
$('skip').addEventListener('click', event => {
  event.preventDefault(); skipped = true;
  if (phase === 'demo') { frame.focus({ preventScroll: true }); return; }
  if (!unlocked) {
    openerDone = true; intro?.quiet(); hideHint(); showLock();
    if (phase === 'ready') $('password').focus({ preventScroll: true });
  } else openComputer();
});
$('action').addEventListener('click', () => showFilm({ fromStart: video.currentTime === 0 }));
$('retry').addEventListener('click', () => { video.load(); showFilm(); });
$('macRetry').addEventListener('click', () => requestDemo());
video.addEventListener('ended', () => { if (phase === 'film') showMac(); });
video.addEventListener('error', () => { if (!FILMING.includes(phase)) return; clearStall(); setPhase('film-error'); prompt('The film stopped loading. Retry.'); });
video.addEventListener('waiting', watchStall); video.addEventListener('stalled', watchStall);
video.addEventListener('playing', clearStall);
video.addEventListener('timeupdate', () => { if (phase !== 'film') return; if (video.currentTime > lastMediaTime) clearStall(); lastMediaTime = video.currentTime; preloadDemo(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['film', 'film-loading'].includes(phase)) {
    pausedByVisibility = true; ++generation; pendingMedia?.abort(); clearStall(); video.pause(); setPhase('film-paused');
  } else if (!document.hidden && pausedByVisibility) { pausedByVisibility = false; showFilm({ fromStart: false }); }
});
function gaveUp() {
  if (introReady) return;
  openerDone = true; showLock();
}
const introTimer = setTimeout(gaveUp, config.mediaTimeoutMs);
import('./intro/intro.mjs?v=mac-2').then(async module => {
  intro = module.intro; intro.warp(warpNow); await module.ready;
  clearTimeout(introTimer); introReady = true;
  if (openerDone) { intro.lockSky(true); return; }
  startOpener();
}).catch(() => { clearTimeout(introTimer); gaveUp(); });
window.__launch = () => ({ phase, generation, videoTime: video.currentTime, videoPaused: video.paused, demoLoaded, demoVerified, demoPreloadAt,
  skyLive, film: layer.state(), lock: { shown: !lockScreen.hidden && !$('lock').hidden, state: lock.state, unlocked, workbench: workbench?.id ?? null, sky: lockScreen.dataset.sky === 'on' },
  hint: hint.dataset.on === 'true', intro: intro?.state(), mac: mac.state(), phone: phone.state(), assembly: { desired: desiredStep, painted: paintedStep, history: assemblyHistory.map(row => ({ ...row })) } });
window.__filmProbe = points => layer.probe(points);
function fadeTimes() { for (const [name, ms] of [['--fade', config.fadeMs], ['--handoff', config.handoffMs], ['--unlock', config.unlockMs]]) document.documentElement.style.setProperty(name, `${fadeDuration(reduced.matches, ms)}ms`); }
fadeTimes(); reduced.addEventListener('change', fadeTimes);
