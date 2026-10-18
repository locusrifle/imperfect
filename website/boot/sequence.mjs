// One boot picture and sound for the public website and the native lock.
// Hosts own authentication and what comes afterwards; neither keys nor passwords belong here.
import * as T from '../vendor/three.module.js';
import manifest from '../opener/assets/manifest.mjs';
import { LOCUS, VAITA } from '../opener/cast.mjs';
import { createPainting, sharpen } from '../opener/rig.mjs';
import { timeline, CONTACT } from '../opener/timeline.mjs';
import { KX, KY, FOV, clamp, smooth, pairBoxOf, frame as frameOf, lens, liftAt, cameraAt, placeWorld, offsetAt, solveApproach } from '../opener/framing.mjs?v=portrait-corners1';
import { createAir } from '../opener/air.mjs';
import { pOfPos, posOfP } from '../opener/scroll.mjs';
import { bindLockScroll, createMomentum } from './scroll.mjs?v=embedded-wheel2';
import { createScene } from '../scene.mjs';
import { bubblePath } from '../bubble.mjs';
import { twistAt, BOOT_ROTATION as SPIN, SKY_PIXELS, skyTime, inkOf, aim } from '../sky.mjs';
import { BURST, createPlayer } from '../bootup.mjs';
import { revealAt, contactBurst } from '../reveal.mjs?v=silver1';
import * as shared from '../reveal.mjs?v=silver1'; // pickSource, read off the module: a stale cached reveal.mjs without it can't break the page
import { soundMotion } from '../bubble-sound.mjs';
import { WORD, createWordmark, wordmarkAt, placeWordmark, metalSilver } from '../wordmark.mjs?v=silver2';
import { GOAT, goatAt, goatTimes, opticalWordmark, placeGoat } from '../intro/goat.mjs';

export function createSequence({
  clock = () => performance.now() / 1000, fixed = () => false, wall = () => Date.now() / 1000,
  epoch = Date.now() / 1000, bg = '#000000', ink = '#ffffff', world = 'dragon',
  profile = null, tell = () => {}, onFrame = () => {}, onMove = () => {}, keepAlive = () => false,
} = {}) {
const momentum = createMomentum();
const SOONEST = 0.8;
profile?.mark('module-ready');
const art = { locus: manifest.locus, vaita: manifest.vaitas[manifest.worlds[world].vaita] };
const pairBox = pairBoxOf(art);
// The launch page's contact frame: the touch at the very middle of the screen, where the word then comes (framing.mjs centred).
const frame = (vw, vh, box) => frameOf(vw, vh, box, { centred: true });
const file = entry => new URL('../opener/' + entry.hd, import.meta.url).href;
const EPOCH = epoch;
const BG = bg, INK = ink;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const $ = id => document.getElementById(id);
const stage = $('stage'), canvas = $('scene'), sky = $('sky');
const rim = $('rim'), rimPath = $('rimPath'), glow = $('glow'), markEl = $('wordmark'), goatEl = $('goat');
rimPath.style.stroke = metalSilver(INK);
const sound = createPlayer({ clock, fixed });
document.documentElement.style.setProperty('--sky-bg', BG);
document.documentElement.style.setProperty('--sky-ink', INK);
const FLOAT = {
  locus: { x: 6, y: 11, r: 0.8, wx: 0.53, wy: 0.83, wr: 0.47, px: 0.3, py: 1.2 },
  vaita: { x: 8, y: 14, r: 1.0, wx: 0.47, wy: 0.71, wr: 0.39, px: 2.1, py: 0.2 },
};

const TOUCH = posOfP(CONTACT);
const S = { phase: 'scene', scrolled: 0, shown: 1, auto: null, started: false };
const rv = { t0: 0, wall: null, at: [0, 0], popAt: null, fade: false, open: false, goat: null };
let galaxy = null, burst = null;
let view = null, renderer = null, scene, camera, plate, air, rigs = null, mode = 'loading', kind = null;
const plates = {};
const motion = () => !reduced.matches && mode === 'webgl';
let mark = null, markState = null, bubbleState = null, suspended = false;
// The launch page's additions: power on without the automatic approach (the visitor scrolls them together), the
// intro's sound and inputs ending where the film begins while its sky keeps turning under it, the sky put to sleep
// once the computer is revealed, and the film's hyperdrive (a function of the film's time) on the sky's stars.
let quieted = false, asleep = false, warpOf = null, moved = false, frames = 0, soundAt = null;
// The lock in front of it all (launch.mjs): the galaxy at rest behind it, turning, until the visitor is let in. And
// the goat after the word (goat.mjs): loaded once the visitor is in, shown only if it has loaded by then.
let locking = false, goatState = null, goatReady = false, marksOn = true;
// The galaxy in the bubble from the touch: the black hole's whole sequence round the contact (reveal.mjs whole).
// GROW: the bubble before the pop, x the lock's. HOLE_FIT: the ring's radius, x that bubble's size; the bubble breathes
// down to ~0.29 of it between hits (and the ring swells 1.35x), so 0.26 keeps the ring inside its edge throughout.
const GROW = 1.5, HOLE_FIT = 0.26;
// LOOK: the window the bubble is before it opens, x that bubble's size. It looks onto a part of the sky as rich as the
// open galaxy (reveal.mjs pickSource), worked out once per screen size ahead of the touch, ZOOM times its size, so a
// window that small shows enough of it to read as the galaxy.
const LOOK = 0.65, ZOOM = 0.4;
// The lock, launch and kept sky all use sky.mjs's same slower turn.
let sources = {};
function sourceFor(w, h) {
  const key = `${w}x${h}`, stars = galaxy?.stars;
  if (!stars) return null;
  if (!sources[key]) {
    const a = stars.geometry.attributes, look = LOOK * revealAt(0, { at: [w / 2, h / 2], width: w, height: h, grow: GROW }).small;
    sources = { [key]: shared.pickSource?.({ positions: stars.base.position, kinds: a.kind.array, alphas: stars.base.alpha, D: galaxy.D, width: w, height: h, look: look / ZOOM }) };
  }
  return sources[key];
}
const intro = {
  start({ auto = true } = {}) { if (S.started || suspended) return; S.started = true; sound.prime(); loadGoat(); if (auto) approach(); else wake(); },
  // Inside a gesture (the unlock, or any press after a remembered one): the boot sound's audio resumed. Plays nothing.
  prime() { sound.prime(); },
  // The galaxy behind the lock (on), or fading away from the painting over ms (off).
  lockSky(on, ms = 0) {
    if (on) { locking = true; sky.dataset.lock = 'on'; wake(); return; }
    if (!locking) return;
    locking = false; sky.dataset.lock = 'off';
    setTimeout(() => { if (sky.dataset.lock === 'off') delete sky.dataset.lock; }, ms);
    wake();
  },
  approach() { if (S.started && !quieted && !suspended) approach(); },
  nudge(screens) { if (S.started && S.phase === 'scene' && !S.auto) move(Number(screens) * innerHeight || 0); },
  marks(on) { marksOn = Boolean(on); },
  reset() {
    marksOn = true;
    sound.stop(); momentum.cancel(); burst = null; bubbleState = markState = goatState = null;
    Object.assign(S, { phase: 'scene', scrolled: 0, shown: 1, auto: null });
    Object.assign(rv, { wall: null, popAt: null, open: false, goat: null });
    mark?.draw({ opacity: 0, blur: 0, scale: 1, formed: 1 }); drawGoat(null);
    sky.style.visibility = 'hidden'; sky.style.opacity = ''; sky.style.clipPath = sky.style.webkitClipPath = '';
    stage.style.visibility = ''; rim.setAttribute('hidden', ''); glow.style.opacity = '0';
    galaxy?.reset(); galaxy?.stars?.reset(); drawnAt = drawnP = -1;
    if (mode === 'webgl') { render(clock(), 0); drawnAt = clock(); drawnP = 0; }
    wake();
  },
  setMuted(value) { sound.setMuted(value); },
  quiet() { quieted = true; sound.setMuted(true); momentum.cancel(); S.auto = null; },
  sky(on) { asleep = !on; if (on) wake(); },
  warp(fn) { warpOf = typeof fn === 'function' ? fn : null; },
  suspend() { suspended = true; sound.stop(); momentum.cancel(); },
  state() {
    const U = galaxy?.stars?.material.uniforms;
    return { phase: S.phase, tau: sound.elapsed(), bubble: bubbleState, wordmark: markState, world, mode, reduced: reduced.matches, suspended,
      sky: galaxy?.stars ? 'webgl' : galaxy ? 'still' : null, started: S.started, auto: Boolean(S.auto), scrolled: S.scrolled, shown: S.shown, moved, quiet: quieted, asleep, frames, soundAt, burst: burst?.phase ?? null,
      locking, goat: goatState, goatReady, mark: markEl.style.left ? [parseFloat(markEl.style.left), parseFloat(markEl.style.top)] : null,
      p: +pOfPos(S.shown).toFixed(4), touched: rv.wall, pop: rv.popAt === null ? null : +(rv.popAt - rv.t0).toFixed(3),
      twist: U?.uTwist.value || 0, epoch: EPOCH, contact: view && [view.kx, view.ky], figures: figureBoxes(),
      audible: sound.audible, warp: U?.uWarp.value ?? 0, warpSpeed: U?.uWarpSpeed.value ?? 0, starOpacity: U?.uOpacity.value ?? 0,
      source: burst?.source ?? null, lens: U && U.uLensScale.value > 0 ? [...U.uLens.value.toArray(), U.uLensScale.value] : null };
  }
};
function noticeMove() { onMove(); if (!moved) { moved = true; tell('move'); setTimeout(() => sourceFor(innerWidth, innerHeight)); } }
// The lock's scroll, both ways: forward brings them together, back moves them apart again, until they touch (from the
// touch nothing moves them: the scene is over).
function move(px) {
  if (!px) return;
  const was = S.scrolled;
  // in screens, not px, so a resize (or full screen) keeps them exactly as far apart as they were
  S.scrolled = clamp(S.scrolled + px * 5 / innerHeight, 0, TOUCH - 1);
  if (S.scrolled === was) return; // already apart as far as they go
  noticeMove();
  wake();
}
// a key before the touch: the rest of the way, quicker the less there is of it
function approach() {
  if (S.phase !== 'scene' || S.auto) return;
  noticeMove();
  momentum.cancel();
  if (!motion()) { S.scrolled = TOUCH - 1; wake(); return; }
  const from = 1 + S.scrolled;
  S.auto = { from, at: clock(), length: 0.35 + 1.5 * (TOUCH - from) / 4.2 };
  wake();
}


const screenOf = v3 => { const p = v3.clone().project(camera); return [(p.x + 1) * view.vw / 2, (1 - p.y) * view.vh / 2]; };
const at = (rig, pose, x, y) => { const [dx, dy] = rig.deform(pose, x, y); return screenOf(rig.group.localToWorld(new T.Vector3(...rig.local(dx, dy), 0))); };
const XAXIS = new T.Vector3(1, 0, 0);
// Each figure's box on screen as last drawn ([left, top, right, bottom], CSS px), for the page's state (checks only).
const posed = {};
function figureBoxes() {
  if (mode !== 'webgl' || !posed.locus) return null;
  const out = {};
  for (const [name, rig] of Object.entries(rigs)) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const i of rig.outline) {
      const [x, y] = at(rig, posed[name], rig.rest[2 * i], rig.rest[2 * i + 1]);
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    }
    out[name] = b.map(Math.round);
  }
  return out;
}
function layout() {
  const vw = innerWidth, vh = innerHeight;
  view = frame(vw, vh, pairBox);
  if (view.kind !== kind && plates[view.kind]?.img) usePlate(view.kind);
  if (mode === 'webgl') solveApproach(view, rigs);
  view.world = placeWorld(view, manifest.worlds[world][kind || view.kind]);
  if (mode === 'webgl') {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 3, Math.sqrt(9e6 / (vw * vh))));
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh; camera.near = 10; camera.far = (view.world.D0 / view.z0 - view.world.Zp) * 1.5; camera.updateProjectionMatrix();
    const C1 = cameraAt(view, 1, FOV[0]);
    air.place({ center: [C1.pos[0], C1.pos[1], 0.05 * C1.D], half: [0.62 * vw / view.s, 0.62 * vh / view.s, 0.4 * C1.D], size: 7 / view.s });
  } else if (mode === 'still') placeStill();
  if (galaxy) galaxy.resize(vw, vh, devicePixelRatio || 1);
  // the wordmark alone at the very centre, as on the website; the field comes to the same centre once it has gone
  // on its optical centre: its ink's mass, not its box, on the centre line (goat.mjs)
  const word = opticalWordmark(placeWordmark(vw, vh)), [wx, wy, ww] = word;
  Object.assign(markEl.style, { left: `${wx}px`, top: `${wy}px` });
  mark?.size(ww, devicePixelRatio || 1);
  const [gx, gy, gw, gh] = placeGoat(vw, vh, word);
  Object.assign(goatEl.style, { left: `${gx}px`, top: `${gy}px`, width: `${gw}px`, height: `${gh}px` });
  const size = Math.max(120, 300 * view.s);
  Object.assign(glow.style, { width: `${size}px`, height: `${size}px`, left: `${view.kx - size / 2}px`, top: `${view.ky - size / 2}px` });
  if (S.phase !== 'scene') {
    rv.at = [view.kx, view.ky];
    if (burst && !rv.fade) burst = makeBurst(); // rebase its lens and stars for the new screen
    if (mode === 'webgl' && !rv.open) render(clock(), CONTACT); // one fresh frozen contact after resize
  }
  wake();
}
function render(t, p) {
  renderer.resetState();
  const tl = timeline(p, motion() ? t : 0);
  const zoom = 1 - (1 - view.z0) * tl.dolly, fov = lens(p), C = cameraAt(view, zoom, fov, liftAt(p));
  const alive = motion() ? 1 - smooth(clamp(p / CONTACT)) : 0;
  for (const [name, rig] of Object.entries(rigs)) {
    const st = tl[name], f = FLOAT[name], off = offsetAt(view, name, st);
    rig.pose({ chains: st.chains, sway: st.sway }); posed[name] = { chains: st.chains, sway: st.sway };
    rig.place({ x: off[0] + alive * f.x * Math.sin(f.wx * t + f.px), y: off[1] + alive * f.y * Math.sin(f.wy * t + f.py), roll: st.roll + alive * f.r * Math.sin(f.wr * t), yaw: st.yaw });
  }
  camera.position.set(...C.pos); camera.quaternion.setFromAxisAngle(XAXIS, C.tilt);
  camera.fov = fov; camera.updateProjectionMatrix(); scene.updateMatrixWorld(); camera.updateMatrixWorld();
  // the plate where the opener puts it, made a little larger only if it would not cover the screen
  const w = view.world, [x0, y0, x1, y1] = w.rect;
  let k = 1;
  const placePlate = () => { plate.scale.set((x1 - x0) * k, (y0 - y1) * k, 1); plate.position.set(w.A[0] + ((x0 + x1) / 2 - w.A[0]) * k, w.A[1] + ((y0 + y1) / 2 - w.A[1]) * k, w.Zp); plate.updateMatrixWorld(); };
  placePlate();
  const corners = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]].map(([u, v]) => screenOf(plate.localToWorld(new T.Vector3(u, v, 0))));
  const As = screenOf(new T.Vector3(w.A[0], w.A[1], w.Zp));
  const L = Math.max(corners[0][0], corners[3][0]), R = Math.min(corners[1][0], corners[2][0]), Tp = Math.max(corners[0][1], corners[1][1]), B = Math.min(corners[2][1], corners[3][1]);
  const need = Math.max(1, L > 0 ? As[0] / (As[0] - L) : 1, R < view.vw ? (view.vw - As[0]) / (R - As[0]) : 1, Tp > 0 ? As[1] / (As[1] - Tp) : 1, B < view.vh ? (view.vh - As[1]) / (B - As[1]) : 1);
  if (need > 1) { k = need * 1.004; placePlate(); }
  // the air: motes everywhere but over the faces, the plate's own light, a warm haze about the contact
  const pr = renderer.getPixelRatio(), faces = [];
  for (const [name, spot, r] of [['locus', [518, 300], 70], ['vaita', [1066, 100], 50]]) {
    const [sx, sy] = at(rigs[name], { chains: tl[name].chains, sway: tl[name].sway }, ...spot), rr = r * view.s * zoom * pr;
    faces.push([sx * pr, sy * pr, rr, rr * 1.15]);
  }
  const near = smooth(clamp(p / CONTACT)), db = renderer.getDrawingBufferSize(new T.Vector2()), cs = screenOf(new T.Vector3(KX, -KY, 0));
  air.update({ time: t, opacity: motion() ? 0.84 - 0.2 * near : 0, glow: 0.06 * (1 - 0.8 * near), view: [db.x, db.y], faces, contact: [cs[0] * pr, cs[1] * pr], radius: Math.min(db.x, db.y) * 0.55, map: plate.material.map });
  const submitAt = profile ? performance.now() : 0;
  renderer.render(scene, camera);
  profile?.sample('webgl-submit', performance.now() - submitAt);

}


function openReveal(t) {
  momentum.cancel();
  S.phase = 'bubble'; S.auto = null; S.shown = TOUCH;
  Object.assign(rv, { t0: t, at: [view.kx, view.ky], popAt: null, fade: !motion() || !galaxy.stars, open: false, goat: null });
  // the moment, to the ms, that imperfect twists the very same sky from (sky.mjs); with no moving sky, none
  rv.wall = rv.fade ? null : Math.round(wall() * 1000) / 1000;
  profile?.phase('contact'); tell(rv.wall === null ? 'touch' : 'touch:' + Math.round(rv.wall * 1000));
  // Freeze the contact painting once. Its poses are stationary here; submitting it behind
  // a second full-DPR canvas every bubble frame needlessly doubles the GPU's work.
  sound.start(t); soundAt = t;
  if (mode === 'webgl') render(t, CONTACT);
  locking = false; delete sky.dataset.lock; // the lock's sky has long gone; the bubble's is its own
  sky.style.visibility = 'visible';
  galaxy.renderer.resetState(); galaxy.reset(); galaxy.stars?.reset();
  if (rv.fade) { galaxy.settle(0); return; }
  burst = makeBurst();
}
function makeBurst() {
  galaxy.stars.reset();
  aim(galaxy.camera, innerWidth, innerHeight);
  const bubble = revealAt(0, { at: rv.at, width: innerWidth, height: innerHeight, grow: GROW }).small;
  return contactBurst({ stars: galaxy.stars, camera: galaxy.camera, at: rv.at, width: innerWidth, height: innerHeight, whole: true, radius: HOLE_FIT * bubble,
    source: sourceFor(innerWidth, innerHeight), zoom: ZOOM });
}
// The shared burst is the stars' birth.
function pop(t, dt) {
  rv.popAt = t; S.phase = 'opening';
  burst?.update(sound.elapsed(t));
  galaxy.enter(0, t);
}
function stepReveal(t, dt) {
  if (S.phase === 'bubble') { if (sound.elapsed(t) >= BURST) { pop(t, dt); if (rv.fade) rv.open = true; } else return; }
  if (t - rv.popAt < (rv.fade ? 0 : SOONEST)) return;

  // the word alone until it has gone, then the goat (if it has loaded by then) until it has gone too; then completion,
  // on the shared contact clock
  const tau = sound.elapsed(t);
  if (tau < WORD.gone) return;
  rv.goat ??= goatReady;
  if (rv.goat && tau < goatTimes({ still: reduced.matches || rv.fade }).gone) return;
  S.phase = 'galaxy'; tell('complete');
  profile?.phase('galaxy');
}
function drawGalaxy(t) {
  if (!galaxy) return;
  if (burst && (burst.whole || rv.popAt !== null)) {
    burst.update(sound.elapsed(t));
    if (burst.done) { burst = null; galaxy.stars.reset(); }
  }
  const at = profile ? performance.now() : 0;
  // The twist and the twinkle are the wall clock's, shared with imperfect (sky.mjs); reduced motion holds them.
  const now = wall(), still = reduced.matches || rv.fade;
  const away = 1;
  const tau = sound.elapsed(t);
  // The bubble is black, just its rim, until it bursts: then the galaxy is born (Noah, 14 Oct: no galaxy in the bubble).
  const born = rv.popAt !== null ? away : 0;
  const w = !still && warpOf ? warpOf() : null;
  const opts = { motion: !still, starOpacity: rv.fade ? away : born, starTwist: twistAt(now, { touched: rv.wall, still }), starTime: still ? 0 : skyTime(now, EPOCH), starRotation: SPIN,
    starWarp: w?.distance || 0, starWarpSpeed: w?.speed || 0 };
  if (rv.fade) {
    sky.style.opacity = tau >= BURST ? '1' : '0';
    sky.style.clipPath = sky.style.webkitClipPath = 'none';
    rim.setAttribute('hidden', ''); glow.style.opacity = '0';
  } else if (!rv.open) {
    const b = revealAt(tau, { at: rv.at, width: innerWidth, height: innerHeight, scale: view.s, grow: GROW, motion: soundMotion });
    bubbleState = { ...b, tau: +tau.toFixed(3) };
    const d = bubblePath(...rv.at, Math.max(0.01, b.R), b.wt, b.wob, b); // the sound's ripples and grain on the rim
    sky.style.clipPath = sky.style.webkitClipPath = `path('${d}')`;
    rimPath.setAttribute('d', d); rim.removeAttribute('hidden'); rim.style.opacity = String(b.rim);
    glow.style.opacity = String(b.glow); glow.style.transform = `scale(${b.glowScale.toFixed(4)})`;
    if (b.done) { rv.open = true; sky.style.clipPath = sky.style.webkitClipPath = ''; rim.setAttribute('hidden', ''); glow.style.opacity = '0'; }
  }
  const onto = burst?.lens; // before it opens, the bubble looks onto the burst's source (framing's lens() is the camera's)
  galaxy.stars?.lens(onto?.from, onto?.to, onto?.scale);
  galaxy.frame(t, 0, { x: 0, y: 0 }, opts); frames++;
  // the wordmark: the website's, on the same clock; if it is still there, it goes with the field (imperfect's sky
  // draws only stars)
  const out = 0;
  const m = wordmarkAt(tau, { still: reduced.matches || rv.fade });
  // Whole from the burst until it goes, then the goat: no blur, grain formation or fades.
  markState = m.on && marksOn ? { ...m, formed: 1, opacity: 1 - out, blur: 0, scale: 1 } : { ...m, opacity: 0 };
  mark?.draw(markState);
  drawGoat(rv.goat && marksOn ? goatAt(tau, { still: reduced.matches || rv.fade }) : null);
  profile?.sample('world-submit', performance.now() - at);
}
// The goat after the word, at the same middle: white on the galaxy, as the word is.
function drawGoat(g) {
  goatState = g;
  const st = goatEl.style, on = Boolean(g?.on && g.opacity > 0);
  goatEl.hidden = !on;
  if (!on) return;
  st.opacity = g.opacity.toFixed(3);
  st.transform = g.scale !== 1 ? `scale(${g.scale.toFixed(4)})` : 'none';
  st.filter = g.blur > 0.0005 ? `blur(${(g.blur * parseFloat(st.width)).toFixed(2)}px)` : 'none';
}
let goatLoading;
function loadGoat() {
  if (goatLoading) return goatLoading;
  goatEl.src = GOAT.src;
  goatLoading = (goatEl.decode ? goatEl.decode() : new Promise((ok, no) => { goatEl.onload = ok; goatEl.onerror = no; })).then(() => { goatReady = true; }, () => {});
  return goatLoading;
}
// The galaxy behind the lock: at rest, twinkling and turning (from when the page began), never the lens or the warp.
function drawLockSky(t) {
  if (!galaxy) return;
  const now = wall(), still = reduced.matches || !galaxy.stars;
  galaxy.stars?.lens();
  galaxy.frame(t, 0, { x: 0, y: 0 }, { motion: !still, starOpacity: 1, starTwist: still ? 0 : -(now - EPOCH), starTime: still ? 0 : skyTime(now, EPOCH), starRotation: SPIN });
  frames++;
}


// One frame loop, the lock's approach and smoothing unchanged. Rest until Start;
// after the word keep only the shared sky alive until the film fully covers it.
let running = false, lastTick = null, drawnAt = -1, drawnP = -1;
function tick() {
  if (suspended || (asleep && S.phase === 'galaxy')) { running = false; return; }
  const tickAt = profile ? performance.now() : 0;
  const t = clock(), dt = lastTick === null ? 0 : clamp(t - lastTick, 0, 0.1);
  lastTick = t;
  if (S.phase === 'scene') {
    if (S.auto) {
      const u = clamp((t - S.auto.at) / S.auto.length);
      S.scrolled = S.auto.from + (TOUCH - S.auto.from) * u * u * (3 - 2 * u) - 1;
    }
    if (!S.auto && motion()) move(momentum.step(t, dt)); else momentum.cancel();
    const goal = 1 + S.scrolled;
    if (!motion()) S.shown = goal;
    else { S.shown += (goal - S.shown) * (1 - Math.exp(-dt / 0.085)); if (Math.abs(goal - S.shown) < 1e-4) S.shown = goal; }
    if (S.started && (pOfPos(S.shown) >= CONTACT - 0.002 || (!motion() && S.shown > 1))) openReveal(t);
  }
  if (S.phase === 'bubble' || S.phase === 'opening') stepReveal(t, dt);
  const p = S.phase === 'scene' ? pOfPos(S.shown) : CONTACT;
  const calm = S.phase === 'scene' && !S.auto && drawnP === p;
  if (locking && S.phase === 'scene') drawLockSky(t); // the painting waits, unseen, behind the lock's sky
  else if (mode === 'webgl' && S.phase === 'scene' && (motion() || drawnAt < 0 || drawnP !== p)
    && !(calm && !fixed() && t - drawnAt < 1 / 30 - 0.004)) {
    const paintAt = profile ? performance.now() : 0;
    if (drawnAt >= 0) profile?.sample('painting-gap', (t - drawnAt) * 1000);
    render(t, p);
    profile?.sample('painting-cpu', performance.now() - paintAt);
    drawnAt = t; drawnP = p;
  }
  if (mode === 'still' && drawnP !== p) { placeStill(); drawnP = p; }
  if (S.phase !== 'scene') drawGalaxy(t);
  onFrame(t, intro.state());
  profile?.sample('tick-cpu', performance.now() - tickAt);
  // a still sky (reduced motion, no moving sky) is drawn once per wake, not every frame for the whole film
  const still = S.phase === 'galaxy' && !burst && (reduced.matches || rv.fade) && !(warpOf?.()?.speed > 0);
  const busy = (locking && S.phase === 'scene' && !reduced.matches && Boolean(galaxy?.stars))
    || keepAlive() || (S.started && !still && (motion() || S.phase !== 'scene' || S.auto || S.shown !== 1 + S.scrolled));
  if (!document.hidden && busy) requestAnimationFrame(tick); else running = false;
}
function wake() { if (!suspended && !running && view) { running = true; lastTick = null; requestAnimationFrame(tick); } }
const images = {};
function placeStill() {
  const el = $('still'), [img, locus, vaita] = el.children;
  if (!img || !view) return;
  const w = view.world, s = view.s;
  Object.assign(img.style, { left: '0px', top: '0px', width: `${w.size[0]}px`, height: `${w.size[1]}px`, transform: `translate(${w.wx}px, ${w.wy}px) scale(${w.sW})` });
  for (const [im, m] of [[locus, art.locus], [vaita, art.vaita]]) {
    Object.assign(im.style, { left: '0px', top: '0px', width: `${m.crop[2]}px`, height: `${m.crop[3]}px`, transform: `translate(${view.kx + (m.crop[0] - KX) * s}px, ${view.ky + (m.crop[1] - KY) * s}px) scale(${s})` });
  }
}
function stillMode() {
  mode = 'still'; canvas.hidden = true;
  const el = $('still'); el.hidden = false;
  el.replaceChildren(plates[kind].img.cloneNode(), images.vaita.cloneNode(), images.locus.cloneNode());
  placeStill();
}

// Without WebGL, reconstruct the website's actual painting, not an invented replacement.
async function stillGalaxy() {
  // No cut-out downloads without WebGL either: a plain theme-coloured cut.
  return { renderer: { resetState() {} }, resize() {}, settle() {}, enter() {}, reset() {}, setFade() {}, frame() {} };
}


const load = src => new Promise((ok, fail) => {
  const img = new Image(); img.alt = ''; img.decoding = 'async';
  img.onload = () => (img.decode ? img.decode() : Promise.resolve()).then(() => ok(img), () => ok(img));
  img.onerror = () => fail(new Error(`could not load ${src}`));
  img.src = src;
});
function usePlate(k) {
  kind = k;
  const e = plates[k];
  if (mode === 'webgl') {
    if (!e.tex) { e.tex = new T.Texture(e.img); e.tex.colorSpace = T.SRGBColorSpace; e.tex.anisotropy = 4; e.tex.needsUpdate = true; }
    plate.material.map = e.tex; plate.material.needsUpdate = true;
  }
}
// The galaxy is made first, so the lock can stand on it while the paintings load (skyReady), then the painting.
let skyMade;
const skyReady = new Promise(ok => { skyMade = ok; });
async function start() {
  loadGoat(); // decode alongside the paintings, not on the burst's critical path
  const k0 = innerWidth < innerHeight ? 'port' : 'land';
  const paintings = Promise.all([load(file(art.locus)), load(file(art.vaita)), load(file(manifest.worlds[world][k0]))]);
  paintings.catch(() => {}); // awaited below; a failure is ready's
  // Separate canvases let the lock draw the site's exact DOM reveal, with no shader copy.
  galaxy = await createScene($('galaxyScene'), { clear: new T.Color(BG), pixels: SKY_PIXELS }); // the one pixel sky (sky.mjs)
  mark = createWordmark(markEl, { ink: INK });
  if (galaxy) { inkOf(INK, galaxy.stars.material.uniforms.uColor.value); }
  else { galaxy = await stillGalaxy(); sky.style.background = BG; }
  await galaxy.resize(innerWidth, innerHeight, devicePixelRatio || 1);
  layout();
  addEventListener('resize', layout);
  reduced.addEventListener?.('change', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  skyMade(true);
  const [locus, vaita, img] = await paintings;
  profile?.mark('assets-decoded');
  images.locus = locus; images.vaita = vaita; plates[k0] = { img };
  const contextAt = profile ? performance.now() : 0;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  profile?.mark('context-ready', { ms: performance.now() - contextAt, webgl: !!gl });
  if (gl) {
    if (profile) {
      for (const name of ['compileShader', 'linkProgram']) {
        const original = gl[name].bind(gl);
        gl[name] = (...args) => {
          const at = performance.now();
          try { return original(...args); }
          finally { profile.sample(name + '-cpu', performance.now() - at); }
        };
      }
    }
    mode = 'webgl';
    renderer = new T.WebGLRenderer({ canvas, context: gl, antialias: false });
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.setClearColor('#07060c');
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(FOV[0], 1, 10, 1e5);
    plate = new T.Mesh(new T.PlaneGeometry(1, 1), sharpen(new T.MeshBasicMaterial({ depthTest: false, depthWrite: false })));
    plate.renderOrder = 0; plate.frustumCulled = false; scene.add(plate);
    rigs = { vaita: createPainting(VAITA, vaita, art.vaita.crop), locus: createPainting(LOCUS, locus, art.locus.crop) };
    for (const rig of Object.values(rigs)) scene.add(rig.group);
    air = createAir();
    scene.add(air.motes.back, air.motes.front); plate.add(air.glow);
    usePlate(k0);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); stillMode(); });
  } else { kind = k0; stillMode(); }
  renderer?.resetState();
  layout();
  profile?.mark('painting-ready', { mode, paintingPixels: canvas.width * canvas.height, skyPixels: $('galaxyScene').width * $('galaxyScene').height });
  if (mode === 'webgl') {
    const firstAt = profile ? performance.now() : 0;
    render(clock(), 0);
    profile?.mark('first-paint-submit', { ms: performance.now() - firstAt, programs: renderer.info.programs.length });
    drawnAt = clock(); drawnP = 0;
  }

  if (profile) requestAnimationFrame(() => requestAnimationFrame(() => profile.mark('first-presentation-opportunity')));
  bindLockScroll({ active: () => S.started && S.phase === 'scene' && !S.auto && !suspended && !quieted, height: () => innerHeight, move: px => move(px), momentum, clock });
  // the other orientation's plate, if a turned or another screen wants it
  addEventListener('resize', () => {
    const k = innerWidth < innerHeight ? 'port' : 'land';
    if (!plates[k]) { plates[k] = {}; load(file(manifest.worlds[world][k])).then(img => { plates[k].img = img; layout(); }, () => {}); }
  });
  wake();
  return true;
}

const ready = start().then(async value => {
  // Ready must include the lettering: do not lose its brief appearance to loading.
  if (!await mark.ready) throw new Error('Wordmark could not load');
  await Promise.all([sound.ready, loadGoat()]); // failed media still runs silently / without the missing image
  tell('ready');
  return value;
}).catch(error => { tell('failed'); throw error; });
return { intro, ready, skyReady };
}
