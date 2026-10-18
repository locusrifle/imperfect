// Pictures a tool returned stay in the conversation and go to the model again
// with every later request, compaction and branch summary. Full-size PNGs
// (3-4 MB each as base64) made one picture session's requests ~100 MB on
// 5 Oct 2026: Codex's WebSocket closed and its SSE fallback stalled. So at
// Pi's public stream boundary every oversized tool-result picture is sent as a
// JPEG preview instead, copy-on-write: the session file, the messages Pi
// holds and the person's own attachments are never changed.
import { resizeImage } from '@earendil-works/pi-coding-agent';

// About 0.35 MB, a 1536x1024 picture at full size in JPEG quality 55.
export const PREVIEW_BYTES = 450_000;
const NOTE = { type: 'text', text: '(The picture above is sent as a smaller JPEG preview to keep requests small; any transparency is not shown. The original file is unchanged.)' };

// One preview per picture block for as long as Pi holds that block.
const previews = new WeakMap();
function preview(block, resize) {
  if (!previews.has(block)) {
    previews.set(block, resize(Buffer.from(block.data, 'base64'), block.mimeType, { maxBytes: PREVIEW_BYTES })
      .then(made => made && made.data.length < block.data.length ? { type: 'image', data: made.data, mimeType: made.mimeType } : null, () => null));
  }
  return previews.get(block);
}

const oversized = block => block?.type === 'image' && typeof block.data === 'string' && block.data.length > PREVIEW_BYTES;

export async function compactRequestImages(context, { signal, resize = resizeImage } = {}) {
  const messages = context?.messages;
  if (!Array.isArray(messages) || !messages.some(m => m?.role === 'toolResult' && Array.isArray(m.content) && m.content.some(oversized))) return context;
  const out = [];
  for (const message of messages) {
    if (signal?.aborted || message?.role !== 'toolResult' || !Array.isArray(message.content) || !message.content.some(oversized)) { out.push(message); continue; }
    const content = [];
    for (const block of message.content) {
      // A picture that cannot be made smaller is still sent, never dropped.
      const small = oversized(block) && !signal?.aborted ? await preview(block, resize) : null;
      content.push(...(small ? [small, NOTE] : [block]));
    }
    out.push({ ...message, content });
  }
  return { ...context, messages: out };
}

export function withCompactRequestImages(streamFn, options = {}) {
  return async (model, context, streamOptions) =>
    streamFn(model, await compactRequestImages(context, { ...options, signal: streamOptions?.signal }), streamOptions);
}
