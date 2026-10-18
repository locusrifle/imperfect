// Static configuration. Which computer the launch ends in is not here: the lock's password decides, and the locker
// says where (locker/site-locks.mjs, from a private file), so no workbench's address is in the site's source.
export const config = Object.freeze({
  // The website's film: packed side by side (picture | matte), composited over the live galaxy (film.mjs).
  videoUrl: new URL('media/v8-lets-begin.mp4?v=09347c5c', import.meta.url).href,
  // The film's hyperdrive cues (warp: [film seconds, speed]); the galaxy follows them.
  cuesUrl: new URL('media/v8-cues.json?v=9ad8ce1e', import.meta.url).href,
  // Required: the REAL product emits this only when its connected UI is usable.
  // Navigation/load (including refused/auth frames) can never establish readiness.
  demoReadyType: 'imperfect:demo-ready',
  mediaTimeoutMs: 20000,
  demoTimeoutMs: 15000,
  fadeMs: 650,
  // While the film plays, the real product mounts hidden once this much film has
  // actually played with this much buffered ahead, so it is usually verified by
  // the end. Then film-out and product-in share one window (0 with reduced motion).
  preloadAfterS: 10,
  preloadAheadS: 15,
  handoffMs: 1200,
  // Unlocked: the lock and its galaxy fade away from the painting (0 with reduced motion).
  unlockMs: 600,
  // A one-word hint ("scroll") if the visitor has not moved them this long after the unlock. false removes it.
  scrollHint: true,
  hintAfterMs: 4000,
});
