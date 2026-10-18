// Stars behind the page. At z = 0 one world unit is one CSS px, so the camera and DOM share a page plane.
// The lock shares this camera, pixel ratio and star clock with imperfect's kept sky.
// pixels (opt-in, the launch page's): the pixel sky (stars.mjs), drawn at the screen's own pixels so every square is
// whole device pixels.
import * as THREE from './vendor/three.module.js';
import { createStars } from './stars.mjs';
import { FOV, pixelRatioFor, pixelRatioOf, distanceFor } from './sky.mjs';
export { pixelRatioOf, PIXEL_BUDGET } from './sky.mjs';

export async function createScene(canvas, { clear = 0x040308, pixels = false } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { return null; }
  renderer.setClearColor(clear, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10);
  const stars = createStars({ width: canvas.clientWidth, height: canvas.clientHeight, pixels });
  if (pixels) canvas.style.imageRendering = 'pixelated';
  scene.add(stars.points);
  let vw = 1, vh = 1, D = 1;

  return {
    renderer, scene, camera, stars,
    // The lock's entrance/exit interface remains, but there are no painted pieces to animate or fade.
    instances: [],
    enter() {}, settle() {}, leave() {}, reset() {}, setFade() {},
    arrival() { return 0; },
    get D() { return D; },
    async resize(w, h, dpr, { stars: placeStars = true } = {}) {
      vw = w; vh = h;
      renderer.setPixelRatio(pixels ? pixelRatioOf(w, h, dpr) : pixelRatioFor(w, h, dpr));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      D = distanceFor(h);
      camera.near = D * 0.05; camera.far = D * 9;
      camera.updateProjectionMatrix();
      if (placeStars) stars.place(w, h, D);
    },
    // t seconds, camY the page px travelled down, pointer -1..1 (eased by the caller).
    // starTime is the stars' own clock (else t), shared with the lock's final and imperfect's first frame.
    // starWarp/starWarpSpeed: the launch film's hyperdrive (stars.mjs); 0 leaves the sky as it was.
    frame(t, camY, pointer, { motion = true, starOpacity = 1, flow = 0, starTwist = 0, starTime = t, starRotation = null, starWarp = 0, starWarpSpeed = 0 } = {}) {
      const cx = vw / 2, cy = -(camY + vh / 2);
      camera.position.set(cx + pointer.x * vw * 0.018, cy - pointer.y * vh * 0.018, D);
      camera.lookAt(cx, cy, 0);
      stars.tick(starTime, renderer.getPixelRatio(), { twinkle: motion, opacity: starOpacity, flow, twist: starTwist, rotation: starRotation });
      stars.warp(starWarp, starWarpSpeed);
      renderer.render(scene, camera);
    },
    // Where a point on the page plane is on screen now.
    project(x, y) { const v = new THREE.Vector3(x, -y, 0).project(camera); return [(v.x + 1) / 2 * vw, (1 - v.y) / 2 * vh]; },
  };
}
