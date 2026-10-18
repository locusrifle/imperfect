// Posting to the person's own X account, straight to the X API: the post's
// text, with a video or pictures, sent only once the person has said "post"
// to the exact post in imperfect's window. Every harness gets it from tools.mjs.
//
// The account's keys are the person's own (OAuth 1.0a user context: an app's
// API key and secret, and the access token and secret it made for their own
// account). They never expire and need no browser, so signing is all there is
// to it: HMAC-SHA1 over each request, below. They are read at each call from
// ~/.imperfect/credentials/x and never written anywhere else.
//
// Nothing here can skip the question. Without a window to ask in, or if the
// person closes it, picks "don't post" or the turn is stopped, nothing is
// uploaded and nothing is posted.
//
// The keys live in one box: ~/.imperfect/credentials on the computer the
// others follow (the authority in machine.json, Locus's PC). A computer
// without them asks the box who the account is, asks the person in its own
// window, and only after their yes sends the post and its media there to be
// signed and published (createXBox, below): the action travels, the keys never do.
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const API = 'https://api.x.com/2';
const POST = 'post';
const DONT = "don't post";
const CHUNK = 4 * 1024 * 1024; // X takes at most 5 MB a segment
const MOST_PICTURES = 4;
const KINDS = {
  '.mp4': { type: 'video/mp4', category: 'tweet_video', kind: 'video', most: 512 },
  '.mov': { type: 'video/quicktime', category: 'tweet_video', kind: 'video', most: 512 },
  '.gif': { type: 'image/gif', category: 'tweet_gif', kind: 'gif', most: 15 },
  '.png': { type: 'image/png', category: 'tweet_image', kind: 'picture', most: 5 },
  '.jpg': { type: 'image/jpeg', category: 'tweet_image', kind: 'picture', most: 5 },
  '.jpeg': { type: 'image/jpeg', category: 'tweet_image', kind: 'picture', most: 5 },
  '.webp': { type: 'image/webp', category: 'tweet_image', kind: 'picture', most: 5 },
};

export const X_POST_TOOL = {
  name: 'x_post',
  description: "Post to the person's own X (Twitter) account: text, optionally with one video (mp4 or mov, up to 2 minutes 20 seconds unless the account has Premium) or one GIF or up to 4 pictures, optionally as a reply. The keys' account is checked first; no media is uploaded and no post is published until the person approves the exact post in a dialog in the window; that dialog is their consent, and if they decline the answer is \"not posted\". Do it in this order: write the post, film or make the media, put the media in front of the person with show so they can watch it, then call x_post with the final text and media. Never call it to \"preview\" a draft, never post something other than what they saw, and do not try to post another way if they decline: ask what to change instead. Answers with the post's address.",
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'the exact text of the post' },
      media: { type: 'array', items: { type: 'string' }, description: "files to attach, absolute or relative to the session's folder: one video (mp4, mov) or one GIF, or up to 4 pictures (png, jpg, webp)" },
      reply_to: { type: 'string', description: 'the post to reply to: its address (https://x.com/<name>/status/<id>) or id' },
    },
    required: ['text'],
  },
};

export function credentialsFile(env = process.env) {
  return join(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'credentials', 'x');
}

export const NO_KEYS = file => `This computer has no X keys yet, so nothing was posted. Ask the person to make them once: at console.x.com, create an app; in its user authentication settings set the app permissions to "Read and write" (before making the access token); then under Keys and tokens copy the API key and secret and generate an access token and secret for their own account. Save them as JSON in ${file} (mode 600): {"api_key": "...", "api_secret": "...", "access_token": "...", "access_secret": "..."}. That folder is the one box of keys: it belongs on the computer the others follow (the authority in machine.json; for Locus, the PC), and a computer that follows it keeps none and posts through it.`;

// The keys in the box, or null when this computer has none.
async function readKeys(file) {
  let keys;
  try { keys = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${file} is not JSON with api_key, api_secret, access_token and access_secret, so nothing was posted.`);
  }
  const missing = ['api_key', 'api_secret', 'access_token', 'access_secret'].filter(name => typeof keys?.[name] !== 'string' || !keys[name].trim());
  if (missing.length) throw new Error(`${file} is missing ${missing.join(', ')}, so nothing was posted. ${NO_KEYS(file)}`);
  return keys;
}

// RFC 3986, as OAuth 1.0a wants it.
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// The Authorization header for one request. Query parameters (and form
// fields, for an urlencoded body) are signed; a JSON or multipart body is not.
export function oauthHeader({ method, url, form = {}, keys, nonce = randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) {
  const address = new URL(url);
  const oauth = {
    oauth_consumer_key: keys.api_key, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp), oauth_token: keys.access_token, oauth_version: '1.0',
  };
  const pairs = [...address.searchParams, ...Object.entries(form), ...Object.entries(oauth)]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const base = [method.toUpperCase(), encode(`${address.origin}${address.pathname}`), encode(pairs.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const signature = createHmac('sha1', `${encode(keys.api_secret)}&${encode(keys.access_secret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${encode(k)}="${encode(v)}"`).join(', ');
}

function failure(status, text, doing) {
  let said = text;
  try {
    const body = JSON.parse(text);
    said = body.detail || body.errors?.map(e => e.message || e.detail).filter(Boolean).join('; ') || body.title || text;
  } catch {}
  said = String(said).slice(0, 400);
  if (status === 401) return `X did not accept the keys (401) while ${doing}: ${said}. Check ~/.imperfect/credentials/x against the app's Keys and tokens.`;
  if (status === 403 && /permission|oauth1/i.test(said)) return `X says the keys may not post (403) while ${doing}: ${said}. In the app's user authentication settings, set the app permissions to "Read and write", then regenerate the access token and secret and save the new ones.`;
  if (status === 402) return `X wants credits for the API (402) while ${doing}: ${said}. Buy credits at console.x.com (Billing).`;
  if (status === 429) return `X's limit is reached for now (429) while ${doing}: ${said}`;
  return `X refused (${status}) while ${doing}: ${said}`;
}

// The model may hand a list as a list, as JSON, or as one path.
function paths(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (text.startsWith('[')) { try { return JSON.parse(text).map(String).filter(Boolean); } catch {} }
  return [text];
}

function replyId(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const id = text.match(/\/status(?:es)?\/(\d+)/)?.[1] ?? (/^\d+$/.test(text) ? text : null);
  if (!id) throw new Error(`reply_to should be a post's address or id, not ${text}`);
  return id;
}

async function attachments(list, here) {
  const files = await Promise.all(paths(list).map(async path => {
    const file = resolve(here, path);
    const kind = KINDS[extname(file).toLowerCase()];
    if (!kind) throw new Error(`${file} is not a video (mp4, mov), GIF or picture (png, jpg, webp)`);
    const { size } = await stat(file).catch(() => { throw new Error(`${file} does not exist`); });
    if (size > kind.most * 1024 * 1024) throw new Error(`${basename(file)} is ${megabytes(size)}; X takes a ${kind.kind} of at most ${kind.most} MB`);
    return { file, size, ...kind };
  }));
  const moving = files.filter(f => f.kind !== 'picture');
  if (moving.length && files.length > 1) throw new Error('A post carries one video or one GIF on its own, or up to 4 pictures');
  if (files.length > MOST_PICTURES) throw new Error(`A post carries at most ${MOST_PICTURES} pictures`);
  return files;
}

const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const wait = (ms, signal) => new Promise((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('Stopped while X was processing the video')); }, { once: true });
});

// The X API as x_post uses it, signed here with the keys: who they are, one
// file uploaded (in segments, then waited on while X processes it), the post.
function signedX(keys, { send, signal, pause }) {
  async function call(method, url, body, doing) {
    signal?.throwIfAborted();
    const multipart = body instanceof FormData;
    const response = await send(url, {
      method,
      headers: { authorization: oauthHeader({ method, url, keys }), ...(body && !multipart ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
      signal,
    });
    const answer = await response.text();
    if (!response.ok) throw new Error(failure(response.status, answer, doing));
    try { return answer ? JSON.parse(answer) : {}; } catch { return {}; }
  }
  return {
    async me() {
      const me = (await call('GET', `${API}/users/me`, null, 'finding the account')).data;
      if (!me?.username) throw new Error('X did not say which account these keys belong to; nothing was posted');
      return { username: me.username };
    },
    async upload({ name, bytes, type, category }) {
      const started = await call('POST', `${API}/media/upload/initialize`, { media_type: type, total_bytes: bytes.length, media_category: category }, `uploading ${name}`);
      const id = started.data?.id;
      if (!id) throw new Error(`X did not start the upload of ${name}; nothing was posted`);
      for (let at = 0, index = 0; at < bytes.length; at += CHUNK, index++) {
        const part = new FormData();
        part.append('segment_index', String(index));
        part.append('media', new Blob([bytes.subarray(at, at + CHUNK)], { type: 'application/octet-stream' }), 'media');
        await call('POST', `${API}/media/upload/${id}/append`, part, `uploading ${name}`);
      }
      let info = (await call('POST', `${API}/media/upload/${id}/finalize`, null, `uploading ${name}`)).data?.processing_info;
      const until = Date.now() + 15 * 60_000;
      while (info && info.state !== 'succeeded') {
        if (info.state === 'failed') throw new Error(`X could not process ${name}: ${info.error?.message || 'processing failed'}; nothing was posted`);
        if (Date.now() > until) throw new Error(`X was still processing ${name} after 15 minutes; nothing was posted`);
        await pause(Math.max(1, Number(info.check_after_secs) || 5) * 1000, signal);
        info = (await call('GET', `${API}/media/upload?command=STATUS&media_id=${id}`, null, `waiting for X to process ${name}`)).data?.processing_info;
      }
      return id;
    },
    async tweet({ text, media_ids = [], reply = null }) {
      const posted = await call('POST', `${API}/tweets`, {
        text,
        ...(media_ids.length ? { media: { media_ids } } : {}),
        ...(reply ? { reply: { in_reply_to_tweet_id: reply } } : {}),
      }, 'posting');
      return posted.data?.id;
    },
  };
}

// The same three, asked of the box (createXBox) by a computer without keys.
function boxX({ url, name }, { send, signal }) {
  async function ask(action, body, type) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await send(`${url}/x/${action}`, { method: 'POST', headers: { origin: url, 'content-type': type }, body, signal, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`${name}, which keeps the X keys, could not be reached (${error.message})`);
    }
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${name}, which keeps the X keys, answered: ${answer.error || response.status}`);
    return answer;
  }
  return {
    me: () => ask('me', '{}', 'application/json'),
    upload: async f => (await ask(`media?name=${encodeURIComponent(f.name)}`, f.bytes, f.type)).id,
    tweet: async post => (await ask('tweet', JSON.stringify(post), 'application/json')).id,
  };
}

// Where the box is, told by the machine server (system/server.mjs): null on
// the box itself and on a computer of its own, else { url, name }, the url ''
// while it cannot be reached.
const BOX = Symbol.for('imperfect.x.box');
export function provideKeyBox(find) { globalThis[BOX] = find; }
const keyBox = async () => (await globalThis[BOX]?.()) ?? null;

// ui: the window's dialogs for the session calling (Pi's ctx.ui, or the
// adapter Claude's tab asks through), filled in by the harness.
export async function runXPost({ text, media, reply_to, cwd, ui, signal } = {}, { fetch: send = fetch, keysFile = credentialsFile(), pause = wait, box = keyBox } = {}) {
  const words = String(text ?? '').trim();
  if (!words) throw new Error('x_post needs the text of the post');
  const here = resolve(String(cwd || process.cwd()));
  const files = await attachments(media, here);
  const reply = replyId(reply_to);
  if (!ui?.select) throw new Error('There is no window here to ask the person in, so nothing was posted.');
  const keys = await readKeys(keysFile);
  let x;
  if (keys) x = signedX(keys, { send, signal, pause });
  else {
    const there = await box();
    if (!there) throw new Error(NO_KEYS(keysFile));
    if (!there.url) throw new Error(`The X keys are kept on ${there.name}, and this computer cannot reach it right now, so nothing was posted. Try again once ${there.name} is on.`);
    x = boxX(there, { send, signal });
  }

  // Which account the keys speak for, asked each time: it checks the keys
  // before the person is asked, and names the account in the question.
  const me = await x.me();
  // Hold the bytes named in the approval, not paths that can be replaced
  // while the person is deciding. Recheck the limit against these bytes.
  for (const f of files) {
    f.bytes = await readFile(f.file, { signal });
    f.size = f.bytes.length;
    if (f.size > f.most * 1024 * 1024) throw new Error(`${basename(f.file)} is ${megabytes(f.size)}; X takes a ${f.kind} of at most ${f.most} MB`);
  }
  const lines = [words];
  if (files.length) lines.push('', ...files.map(f => `with ${f.kind}: ${basename(f.file)} (${megabytes(f.size)})`));
  if (reply) lines.push('', `in reply to https://x.com/i/status/${reply}`);
  const picked = await ui.select(`Post this to X as @${me.username}?`, [DONT, POST], { signal, message: lines.join('\n') });
  if (picked !== POST) return 'Not posted: the person did not approve it. No media was uploaded and no post was published. Ask them what to change.';

  const ids = [];
  for (const f of files) ids.push(await x.upload({ ...f, name: basename(f.file) }));
  const id = await x.tweet({ text: words, media_ids: ids, reply });
  if (!id) throw new Error('X answered without a post id; check the account before trying again');
  return `Posted to X as @${me.username}: https://x.com/${me.username}/status/${id}`;
}

// The box's side: a computer of the person's with no keys asked them in its
// window, and sends what they approved here to be signed: POST /x/me,
// /x/media?name=<file> (the bytes as the body), /x/tweet { text, media_ids,
// reply }. Guarded: the machine server answers only its own
// tailnet name or loopback (tailscale serve, never funnel), and the exact
// origin is required, which a page elsewhere cannot claim and /peer/ drops.
export function createXBox({ keysFile = credentialsFile(), fetch: send = fetch, pause = wait } = {}) {
  return async function handle(req, res, path, search = '') {
    const action = /^\/x\/(me|media|tweet)$/.exec(path)?.[1];
    if (!action || req.method !== 'POST') return false;
    const json = (status, value) => {
      if (res.headersSent) return;
      // Answered before the whole body arrived (too big): this connection is done.
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(req.complete ? {} : { connection: 'close' }) });
      res.end(JSON.stringify(value));
    };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    // The asking computer's turn stopped: stop asking X too.
    const stop = new AbortController();
    res.once('close', () => { if (!res.writableFinished) stop.abort(); });
    const bad = message => Object.assign(new Error(message), { status: 400 });
    try {
      const keys = await readKeys(keysFile);
      if (!keys) throw Object.assign(new Error(NO_KEYS(keysFile)), { status: 404 });
      const x = signedX(keys, { send, signal: stop.signal, pause });
      if (action === 'me') { json(200, await x.me()); return true; }
      if (action === 'media') {
        const name = basename(new URLSearchParams(search).get('name') ?? '');
        const kind = KINDS[extname(name).toLowerCase()];
        if (!kind) throw bad(`${name || 'that'} is not a video (mp4, mov), GIF or picture (png, jpg, webp)`);
        const bytes = await received(req, kind.most * 1024 * 1024, `X takes a ${kind.kind} of at most ${kind.most} MB`);
        if (!bytes.length) throw bad(`${name} is empty`);
        json(200, { id: await x.upload({ name, bytes, ...kind }) });
        return true;
      }
      let post;
      try { post = JSON.parse((await received(req, 64 * 1024, 'too long')).toString('utf8')); } catch (error) { throw error.status ? error : bad('not JSON'); }
      const words = String(post?.text ?? '').trim();
      const ids = post?.media_ids ?? [];
      const reply = post?.reply ?? null;
      if (!words) throw bad('the post has no text');
      if (!Array.isArray(ids) || ids.length > MOST_PICTURES || !ids.every(id => typeof id === 'string' && /^\w{1,64}$/.test(id))) throw bad('media_ids should be up to 4 ids from /x/media');
      if (reply !== null && !(typeof reply === 'string' && /^\d{1,32}$/.test(reply))) throw bad('reply should be a post id');
      json(200, { id: await x.tweet({ text: words, media_ids: ids, reply }) });
    } catch (error) {
      json(error.status || 502, { error: error.message });
    }
    return true;
  };
}

async function received(req, most, tooBig) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > most) throw Object.assign(new Error(tooBig), { status: 413 });
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
