// The launch film over the site's own galaxy. The film file is packed side by side: the picture on the left
// (premultiplied: the frame as it looks on black), its matte on the right (luma; white is solid). Each half is 4:3.
// A transparent WebGL canvas puts them back together over the live sky, so the film's words float in the galaxy.
// The 4:3 picture sits 'contain' in the safe area; outside it the film's own edge is held (its edges are
// transparent, except Apple's white card, which so fills the whole screen).
// The media element stays laid out and playing underneath (iOS must keep decoding it), invisible. Without WebGL,
// or if the context is lost, the plain film shows instead: the picture half, cropped, on black.
const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
const FRAG = `precision mediump float;
uniform sampler2D uFilm;
uniform vec4 uRect;   // the 4:3 picture in drawing-buffer px: left, bottom, width, height
uniform vec2 uTexel;  // half a texel of the packed frame (u, v)
uniform float uFloor; // the matte's compression noise floor
void main() {
  vec2 uv = clamp((gl_FragCoord.xy - uRect.xy) / uRect.zw, 0.0, 1.0);
  // each half on its own, never filtering across the middle
  float u = clamp(uv.x * 0.5, uTexel.x, 0.5 - uTexel.x), v = clamp(1.0 - uv.y, uTexel.y, 1.0 - uTexel.y);
  vec3 colour = texture2D(uFilm, vec2(u, v)).rgb;
  float a = dot(texture2D(uFilm, vec2(u + 0.5, v)).rgb, vec3(0.2126, 0.7152, 0.0722));
  a = clamp((a - uFloor) / (1.0 - uFloor), 0.0, 1.0);
  gl_FragColor = vec4(min(colour, vec3(a)), a);
}`;
export const ASPECT = 4 / 3;
export const NOISE_FLOOR = 3 / 255;

// The 4:3 picture's place: 'contain' in the area (both in CSS px, relative to the screen).
export function filmRect(area) {
  const w = Math.min(area.width, area.height * ASPECT), h = w / ASPECT;
  return { x: area.left + (area.width - w) / 2, y: area.top + (area.height - h) / 2, width: w, height: h };
}

export function createFilmLayer({ video, canvas, screen, area, maxRatio = 2 }) {
  let gl = null, program = null, texture = null, mode = 'plain', rect = null, ratio = 1, handle = null, polling = null;
  let haveFrame = false, frames = 0, lastTime = -1, watchdog = null, loop = false, onplain = () => {};
  const U = {};
  try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }); } catch {}
  if (gl) {
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) gl = null;
  }
  if (gl) {
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uFilm', 'uRect', 'uTexel', 'uFloor']) U[name] = gl.getUniformLocation(program, name);
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1i(U.uFilm, 0); gl.uniform1f(U.uFloor, NOISE_FLOOR);
    gl.clearColor(0, 0, 0, 0);
    mode = 'webgl';
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); plain(); });
  }
  screen.dataset.mode = mode;

  function plain() {
    if (mode === 'plain') return;
    mode = 'plain'; stop(); gl = null; screen.dataset.mode = 'plain';
    onplain();
  }
  function layout() {
    const box = screen.getBoundingClientRect(), safe = area.getBoundingClientRect();
    rect = filmRect({ left: safe.left - box.left, top: safe.top - box.top, width: safe.width, height: safe.height });
    for (const [k, v] of Object.entries({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })) screen.style.setProperty(`--film-${k}`, `${v}px`);
    if (!gl) return;
    ratio = Math.min(devicePixelRatio || 1, maxRatio);
    const w = Math.max(1, Math.round(box.width * ratio)), h = Math.max(1, Math.round(box.height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    draw();
  }
  function upload() {
    if (!gl || video.readyState < 2 || !video.videoWidth) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video); }
    catch { plain(); return false; } // a frame WebGL may not read (never expected same-origin)
    gl.uniform2f(U.uTexel, 0.5 / video.videoWidth, 0.5 / video.videoHeight);
    haveFrame = true; frames++; lastTime = video.currentTime;
    return true;
  }
  function draw() {
    if (!gl || !rect) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!haveFrame) return;
    gl.uniform4f(U.uRect, rect.x * ratio, canvas.height - (rect.y + rect.height) * ratio, rect.width * ratio, rect.height * ratio);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function present() { if (upload()) draw(); }
  // A new frame each time the media element presents one; where that is unavailable (or never arrives), poll on
  // animation frames for a changed time instead.
  function onFrame() { handle = null; if (!loop) return; present(); clearTimeout(watchdog); watchdog = null; schedule(); }
  function poll() { polling = null; if (!loop) return; if (video.currentTime !== lastTime || !haveFrame) present(); polling = requestAnimationFrame(poll); }
  function schedule() {
    if (!loop || !gl) return;
    if (video.requestVideoFrameCallback && polling === null) {
      handle = video.requestVideoFrameCallback(onFrame);
      if (!watchdog) watchdog = setTimeout(() => { watchdog = null; if (loop && !video.paused && handle !== null) { video.cancelVideoFrameCallback?.(handle); handle = null; poll(); } }, 600);
    } else if (polling === null) poll();
  }
  function start() { if (loop || !gl) return; loop = true; present(); schedule(); }
  function stop() {
    loop = false; clearTimeout(watchdog); watchdog = null;
    if (handle !== null) video.cancelVideoFrameCallback?.(handle);
    if (polling !== null) cancelAnimationFrame(polling);
    handle = polling = null;
  }
  new ResizeObserver(layout).observe(screen);
  new ResizeObserver(layout).observe(area);
  addEventListener('resize', layout);
  video.addEventListener('seeked', () => { if (loop) present(); });
  layout();
  return {
    get mode() { return mode; },
    set onplain(fn) { onplain = fn; },
    start, stop, present, layout,
    state: () => ({ mode, frames, rect, ratio, looping: loop, rvfc: handle !== null, polling: polling !== null }),
    // Inspection only (tests): the composited premultiplied RGBA at points in CSS px of this canvas.
    probe(points) {
      if (!gl) return null;
      present();
      const out = new Uint8Array(4);
      return points.map(([x, y]) => {
        gl.readPixels(Math.round(x * ratio), Math.round(canvas.height - 1 - y * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return [...out];
      });
    },
  };
}

// The frame's own time (the same for everything drawn in one animation frame) where there is one, in seconds.
const frameTime = () => (globalThis.document?.timeline?.currentTime ?? performance.now()) / 1000;

// The film's hyperdrive (its cues' warp: [film seconds, speed] keyframes) as distance flown, integrated once over film
// time, so pausing, seeking and replaying are exact. Between keyframes the speed eases (smoothstep), so it eases in
// and out at every cue's edge and is constant along a plateau; the keyframes' times and speeds are the cues' own.
// Distance is in whole depths at perSecond depths a second at speed 1 (the film's own DEPTH_PER_S). Every stretch
// that starts and ends at rest is scaled to cover a whole number of depths, so the sky comes back exactly as it was.
// clock: seconds now, for the smoothing below (the frame's time by default).
export function warpTable(cues, { perSecond = 0.6, step = 0.02, clock = frameTime } = {}) {
  const keys = (Array.isArray(cues?.warp) ? cues.warp : []).filter(k => Array.isArray(k) && k.length >= 2 && k.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
  const speed = t => {
    if (!keys.length || !(t > keys[0][0])) return keys.length ? Math.max(0, keys[0][1]) : 0;
    for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) { const [a, sa] = keys[i - 1], [b, sb] = keys[i], u = (t - a) / (b - a); return Math.max(0, sa + (sb - sa) * u * u * (3 - 2 * u)); }
    return Math.max(0, keys[keys.length - 1][1]);
  };
  const end = Math.max(Number(cues?.duration) || 0, keys.length ? keys[keys.length - 1][0] : 0) + 1;
  const n = Math.ceil(end / step) + 1, step_ = i => speed(i * step);
  const inc = new Float64Array(n);
  for (let i = 1; i < n; i++) inc[i] = (step_(i - 1) + step_(i)) / 2 * perSecond * step;
  for (let i = 1; i < n;) {
    if (inc[i] === 0) { i++; continue; }
    let j = i, total = 0;
    while (j < n && inc[j] > 0) total += inc[j++];
    if (j < n) { const scale = Math.max(1, Math.round(total)) / total; for (let k = i; k < j; k++) inc[k] *= scale; }
    i = j;
  }
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + inc[i];
  // The film's time as the sky flies by it. While the film plays, its currentTime moves in uneven steps (measured in
  // Chromium: 5-26 ms in a steady 16.7 ms frame, and every second or so it drops back about 10 ms), and the sky would
  // judder with it. So while it plays the sky runs on a clock that keeps the frames' pace and is drawn gently onto the
  // film's (never more than SLACK apart, never backwards). A seek is the film's own time exactly, and so is a film
  // that has not moved since; through a stall the sky waits where it is.
  const LEAD = 0.1, SLACK = 0.05, PULL = 0.2, HELD = 0.15, JUMP = 0.25;
  let film = null, since = 0, smooth = 0, last = 0, moving = false;
  const follow = t => {
    const now = clock();
    if (!Number.isFinite(t) || !Number.isFinite(now)) { film = null; moving = false; return t; }
    if (t === film && now === last) return smooth; // asked again in the same frame
    if (t !== film) { // on by about the time that passed (playing, or going again after a stall), or a seek
      const on = film !== null && now > last && t > film && Math.abs(t - (moving ? film + (now - since) : film)) < JUMP;
      film = t; since = now;
      if (!on) { moving = false; last = now; return (smooth = t); }
      moving = true;
    } else if (!moving || now - since > HELD) { moving = false; last = now; return smooth; } // held, or stalled
    const target = film + Math.min(now - since, LEAD), ahead = smooth + (now - last);
    const pulled = ahead + (target - ahead) * (1 - Math.exp(-(now - last) / PULL));
    smooth = Math.max(smooth, Math.min(target + SLACK, Math.max(target - SLACK, pulled)));
    last = now;
    return smooth;
  };
  return {
    speed,
    distance(t) {
      if (!(t > 0)) return 0;
      const x = Math.min(t / step, n - 1), i = Math.floor(x), f = x - i;
      return i + 1 < n ? dist[i] + (dist[i + 1] - dist[i]) * f : dist[n - 1];
    },
    // what the sky takes at the film's time t: depths flown (only the fraction matters) and the speed now, on the
    // smoothed clock while the film plays (above); at rest, exactly nothing
    at(t) { const time = follow(t), s = speed(time); return s > 0 ? { distance: this.distance(time) % 1, speed: s } : { distance: 0, speed: 0 }; },
  };
}
