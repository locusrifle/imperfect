// The sky imperfect OS's lock and imperfect share (desktop/lock, apps/code's arrival.js): the website's own stars
// (stars.mjs, its one seed) placed for the screen and seen by one camera, with their time a pure function of the
// wall clock. The lock's page (WebKit) and imperfect's window (Electron) each draw it alone, and at the same
// moment they draw the very same frame, however many frames either dropped or slept, so when the lock goes
// nothing in the sky moves.
//
// What they share: the lock's epoch (when it began: the twinkle's clock), the moment Locus and Vaita touched (the
// twist's). Unlock does not change the motion.
// The website's own scene (scene.mjs) takes its pixel ratio and camera from here too.
import * as THREE from './vendor/three.module.js';
import { createStars, ROTATION } from './stars.mjs';
import { BURST } from './bootup.mjs';

export const FOV = 30;
// After the touch (s): stars are born and start twisting at pop; the burst settles burst seconds later.
export const TOUCH = { pop: BURST, burst: 2.0 };

// Noah chose Countercurrent: one steady turn, opposite the original current. Its law (stars.mjs): slow in the
// middle, faster and faster outwards, each radius at its own constant rate.
export const TWIST = 'reverse';
export { ROTATION };
export const BOOT_ROTATION = Object.freeze({ ...ROTATION, centre: ROTATION.centre * 0.4, edge: ROTATION.edge * 0.4 });
// The one galaxy's pixel stars, wherever it is drawn (the website's boot, the lock, the kept sky): no little galaxies.
export const SKY_PIXELS = Object.freeze({ clusters: false });

// Whole device-pixel squares, within one budget on the launch, lock and kept sky.
export const PIXEL_BUDGET = 16e6;
export function pixelRatioOf(w, h, dpr) {
  const device = dpr > 0 ? dpr : 1;
  let ratio = device;
  for (let k = 2; ratio > 1 && w * h * ratio * ratio > PIXEL_BUDGET; k++) ratio = Math.max(1, device / k);
  return ratio;
}
export const pixelRatioFor = (w, h, dpr) => Math.min(dpr || 1, 2, Math.sqrt(8e6 / (w * h)));
export const distanceFor = h => (h / 2) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));

// Constant elapsed motion from the burst. Pure wall-clock evaluation: gone, dropped frames, focus,
// sleep and theme changes cannot change the angle or speed. Reduced motion remains intentionally still.
export function twistAt(now, { touched = null, still = false } = {}) {
  if (still || !Number.isFinite(touched) || !Number.isFinite(now) || now <= touched + TOUCH.pop) return 0;
  return -(now - touched - TOUCH.pop);
}

// The twinkle's clock: seconds since the lock began (small, so the shader keeps its precision), the epoch to the
// ms as the locker hands it the page (?epoch=%.3f) and imperfect reads it from `held` to the ns.
export const skyTime = (now, epoch) => (Number.isFinite(epoch) ? now - Math.round(epoch * 1000) / 1000 : now % 86400);

// A theme colour as the stars' shader takes it: the theme's own bytes, not converted, so the ink is the ink.
export function inkOf(hex, colour = new THREE.Color()) {
  const v = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())?.[1] || 'ffffff';
  return colour.setRGB(...[0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255), THREE.LinearSRGBColorSpace);
}

// The camera on the first screen, as the website's scene has it with the pointer at rest.
export function aim(camera, w, h) {
  const D = distanceFor(h);
  camera.aspect = w / h; camera.near = D * 0.05; camera.far = D * 9; camera.updateProjectionMatrix();
  camera.position.set(w / 2, -h / 2, D); camera.lookAt(w / 2, -h / 2, 0); camera.updateMatrixWorld();
  return D;
}

// imperfect's side: the stars alone on a canvas of their own, the whole window. frame() draws the sky for a
// moment; drawing nothing else, it never needs the clouds' textures or the opener's paintings.
export function createSky(canvas, { width, height, dpr = 1, bg = '#000000', ink = '#ffffff' } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' }); }
  catch { return null; }
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10);
  // counted for the screen the lock was drawn on, as the lock's scene counts them
  const stars = createStars({ width, height, pixels: SKY_PIXELS });
  canvas.style.imageRendering = 'pixelated';
  scene.add(stars.points);
  let w = 0, h = 0, ratio = 0;
  const sky = {
    renderer, stars, camera,
    resize(nw, nh, ndpr = 1) {
      if (nw === w && nh === h && ndpr === ratio) return;
      w = nw; h = nh; ratio = ndpr;
      renderer.setPixelRatio(pixelRatioOf(w, h, ratio));
      renderer.setSize(w, h, false);
      stars.place(w, h, aim(camera, w, h));
    },
    theme(nbg, nink) { renderer.setClearColor(new THREE.Color(nbg), 1); inkOf(nink, stars.material.uniforms.uColor.value); },
    // now (s, wall clock); epoch, touched, gone as twistAt has them; avoid: what the stars keep clear of (stars.mjs)
    frame({ now, epoch = null, touched = null, gone = null, still = false, avoid = null }) {
      stars.tick(still ? 0 : skyTime(now, epoch), renderer.getPixelRatio(), { twinkle: !still, twist: twistAt(now, { touched, still }), rotation: BOOT_ROTATION, avoid });
      renderer.render(scene, camera);
    },
    dispose() { stars.geometry.dispose(); stars.material.dispose(); renderer.dispose(); },
  };
  sky.resize(width, height, dpr);
  sky.theme(bg, ink);
  return sky;
}
