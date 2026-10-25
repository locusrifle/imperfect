// The mic in imperfect's dock: press to record, press again to stop. The
// recording goes into the input bar as a stand-in, "audio 1", the way a
// picture stands in as "image 1" (harness.js), and is heard on the PC while
// the person goes on. It becomes words in place of its stand-in when the
// message is sent. Esc while recording lets it go.
//
//   const voice = mountVoice({ begin, hold, fail });
//   begin(): where the recording belongs, taken when recording starts (it throws if nowhere)
//   hold(recording, where): the finished recording, for the bar

export const isVoiceFile = file => /^(audio|video)\//.test(file?.type || '') || /\.(m4a|mp3|wav|ogg|opus|aac|flac|mp4|mov|webm|mkv)$/i.test(file?.name || '');

// A waveform: speaking, not a microphone.
const MIC = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 8.5v3M6.5 6v8M10 3v14M13.5 6v8M17 8.5v3"/></svg>';

export function mountVoice({ begin = () => null, hold = () => {}, fail = () => {} }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry-voice';
  button.innerHTML = MIC;
  const clock = document.createElement('span');
  clock.className = 'entry-voice-clock';
  button.append(clock);
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  let recorder = null, started = 0, ticking = null, opening = null;

  function paint() {
    const state = recorder ? 'recording' : opening ? 'opening' : 'idle';
    button.dataset.state = state;
    button.hidden = !canRecord;
    const label = { opening: 'Waiting for microphone permission (Esc cancels)', recording: 'Stop: the recording goes in the message (Esc lets it go)', idle: 'Record into the message' }[state];
    button.title = label;
    button.setAttribute('aria-label', label);
    const seconds = recorder ? Math.floor((Date.now() - started) / 1000) : 0;
    clock.textContent = recorder ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  }

  async function start() {
    // Where it belongs is taken now, before permission can suspend the window.
    let where;
    try { where = begin(); }
    catch (error) { fail(error); return; }
    const pending = opening = { cancelled: false };
    paint();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (error) { fail(new Error(error?.name === 'NotAllowedError' ? 'the microphone is not allowed for this window' : `no microphone: ${error.message}`)); return; }
    finally { opening = null; paint(); }
    if (pending.cancelled) { for (const track of stream.getTracks()) track.stop(); return; }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(kind => MediaRecorder.isTypeSupported?.(kind));
    const chunks = [];
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch (error) { for (const track of stream.getTracks()) track.stop(); fail(error); return; }
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      const keep = !recorder?.cancelled;
      recorder = null;
      clearInterval(ticking);
      paint();
      if (!keep || !chunks.length) return;
      hold(new Blob(chunks, { type: chunks[0].type || type || 'audio/webm' }), where);
    };
    try { recorder.start(1000); }
    catch (error) { recorder = null; for (const track of stream.getTracks()) track.stop(); fail(error); paint(); return; }
    started = Date.now();
    ticking = setInterval(paint, 1000);
    paint();
  }
  function stop({ cancel = false } = {}) {
    if (!recorder) return false;
    recorder.cancelled = cancel;
    recorder.stop();
    return true;
  }

  button.onclick = () => { if (recorder) stop(); else if (!opening) void start(); };
  addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (opening) { opening.cancelled = true; event.preventDefault(); }
    else if (stop({ cancel: true })) event.preventDefault();
  }, true);
  paint();
  return { button, toggle: () => button.click(), holding: () => Boolean(opening || recorder) };
}
