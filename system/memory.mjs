// Memory: a system of record of what Noah does with his computers, in one
// place on the PC (~/.imperfect/memory/), and a reading of it for agents.
//
// The record is the harnesses' own session logs, the way code is the record
// of a codebase. A pass copies every log that changed gzipped into
// raw/<computer>/<harness>/ (and each computer's ~/imperfect reflog into
// reflog/), so nothing is lost when a harness tidies its logs away. (The
// calls with Vaita there were, and their sounds, were copied as they are into
// raw/<computer>/calls/; those stay, and are counted, but no more are made.)
// The logs themselves are left exactly as they
// are (each harness needs its log to resume a session). A log is copied once
// it has been still for 30 minutes, so never halfway through a write, and
// again if it grew (it was resumed): .done.json remembers each log's size and
// time. Until then a log on this computer is read where it is, so what was
// said a minute ago is in memory at the next pass. Other computers are
// reached over ssh, named in computers.json ({ "laptop": "noah@laptop" }); one
// that does not answer is caught up later.
//
// The sessions themselves never write memory: they do the work, and one
// separate model reads what they did. Its unit is the episode (episodes): a
// stretch of one session that has ended, where the agent finished a turn and
// nothing followed for ten minutes. A session that goes on later gets a new
// episode from where the last one stopped. Each episode goes to Pi (MODEL at
// THINKING, told what to write by memory-prompt.md) once, on the first pass
// after it closes, as a transcript: Noah's words, the agent's words, and a
// line for each tool call with its result cut short. It answers the projects
// the episode worked on (named from the paths it touched, out of those the
// code finds in ~/imperfect, ~/projects, ~/workbench, ~/archive and ~/notes),
// a summary and the turns: Noah's word for word and the agent's as what
// happened (an old day may also hold what Vaita said in a call, read as it
// was). The answer is kept in derived/<hash of the transcript>.json with
// where and when the episode was, so nothing goes to the model twice.
// derived/ is the layer every view is made from by code alone:
//
//   - days/, one file per day in this computer's zone (days/2026-10-03.md),
//     where `cat days/*.md` is the whole thread. A day holds each session that
//     spoke that day, in the order of its first turn that day: a heading (its
//     times, computer, harness and short id), where it ran, the commit
//     ~/imperfect was at, the agent's model, what made the entry, the projects,
//     a summary, and its turns.
//   - projects/<name>.md, every episode that touched that project, newest
//     first, so "what happened with dacre" is one file (renderViews).
//   - index.json, project -> episodes and day -> episodes, for tools.
//   - recent.md, the last 48 hours for an agent to read first (renderRecent),
//     under what is open.
//
// A timer starts a pass every two minutes, and one runs at a time (lock).
// Each reaches this computer, so a laptop that is off costs it nothing, makes
// recent.md and the days it covers again from the logs written to since then
// (a second or two), and gives the model the episodes that closed, newest
// first, one call at a time. Every half hour a pass reaches every computer
// and makes all of days/ again, and the model takes on the backlog (episodes
// it has not written yet), still newest first, for at most RUN_MS; fresh
// passes go on every two minutes beside it, and an episode that closes
// meanwhile goes to the model next. Every two hours the pass then keeps Pi and
// Claude Code up to date (system/upgrade.mjs).
//
// An episode the model has not reached yet (one still going, or in the
// backlog), or that it failed TRIES times, is written by the filter:
//
//   - Noah's message, word for word: injected system reminders, hook output
//     and voice-mode instructions are cut, a picture becomes [image] and a
//     pasted block [pasted text: its first line];
//   - the agent's last text before Noah's next message, word for word.
//
// Both leave out sessions in which Noah never spoke or that ran in a
// throwaway folder, a line a log holds twice (Claude Code sometimes writes
// part of a session again), thinking, and errors a retry replaced. A replay,
// a session in which everything distinctive Noah said he had said word for
// word in an earlier one (a probe or a test run again), is only its heading.
// Secrets are redacted on the way in and out: anything shaped like a key, a
// password said in so many words, the exact values of the files in
// ~/.imperfect/credentials/ (read here, kept in memory only), and every value
// the model reported redacting (kept only as a hash, in .secrets).
//
// What is open across sessions, waiting on Noah or left unfinished, is
// written by the model too (openList, told how by memory-open-prompt.md),
// after new episodes, at most every half hour: it reads recent.md as an agent
// would, with the list it wrote last time at the top, and writes the list
// again, letting go of what the sessions show done, decided or dropped. Above
// it, what imperfect's own jobs could not do (open/, readRaised), as they
// wrote it, which the model never reads.
//
// Once a night (nightly, memory-nightly-prompt.md) memory opens a Pi session
// in imperfect, the nightly review: it reads the day's episodes beside
// ~/notes, ~/AGENTS.md and the day's commits, says where the system met Noah
// and where it did not, asks him each decision and acts on his answers. The
// list of what is open says while one waits on him.
//
// Each session is joined to git by time: the commit ~/imperfect had checked
// out on that computer then, from the kept reflog, and a mark where it moved.
//
//   node system/memory.mjs                  a pass (the timer)
//   node system/memory.mjs whole            a pass that reaches every computer and takes on the backlog, now
//   node system/memory.mjs search <words>   what was said: Noah first, newest first
//   node system/memory.mjs sizes            logs, raw bytes, sessions and days/ bytes per computer
//   node system/memory.mjs home             exit 0 when memory lives on this computer (install.sh)
//
// recall (RECALL_TOOL, runRecall) is the search as an agent tool, by words,
// project or both. On another computer it asks the PC (POST /memory,
// createMemoryRoute) the way x_post asks it to post: memory stays in one place.
import { constants } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { SECRETS } from '../locker/hooks/pre-receive.mjs';
import { readConfig, resolvePrefix } from './machine.mjs';
import { importedBytes, readMemoryImport, validateMemoryImport } from './memory-imports.mjs';
import { readTailnet, tailnetStatus } from './machines.mjs';
import { durableArchiveRows, loadDurableArchive } from '../apps/code/native/durable-archive.mjs';

const QUIET_MS = 30 * 60_000; // a log this still is copied into raw/
const EPISODE_GAP = 10 * 60_000; // this long after a turn finished, an episode has ended
const REPO = resolve(import.meta.dirname, '..');
export const memoryDir = (prefix = resolvePrefix()) => join(prefix, 'memory');

// --- time, in this computer's own zone ---------------------------------------
const pad = n => String(n).padStart(2, '0');
export function localTime(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const zone = `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}
const day = ms => localTime(ms).slice(0, 10);
const clock = ms => localTime(ms).slice(11, 16);
const startOfDay = ms => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();

// --- secrets -----------------------------------------------------------------
// The store's list of what must never be pushed, and a few more shapes.
const SHAPES = [
  ...SECRETS.map(([pattern]) => pattern),
  /\bic_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[prs]k_(live|test)_[A-Za-z0-9]{8,}/,
  /\btskey-[a-z]+-/,
  /\bcf[a-z]{1,3}_[A-Za-z0-9]{30,}/,
].map(pattern => new RegExp(`(?:${pattern.source})[\\w-]*`, 'g')); // to the end of the token

// A value in a credentials file that is worth hunting for: long, one word,
// not an address, a path or a plain URL.
const secretLike = v => v.length >= 10 && !/\s/.test(v) && !/^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i.test(v)
  && !/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(v) && !/^[/~.]/.test(v) && (/\d/.test(v) || v.length >= 24);

// The values in ~/.imperfect/credentials/, never written anywhere.
export async function credentialValues(dir, files = null) {
  const values = new Set();
  const take = v => { if (typeof v === 'string' && secretLike(v.trim())) values.add(v.trim()); };
  const leaves = v => { if (v && typeof v === 'object') Object.values(v).forEach(leaves); else take(v); };
  for (const name of files ?? await readdir(dir).catch(() => [])) {
    const bytes = await readFile(join(dir, name)).catch(() => null);
    if (!bytes || bytes.includes(0)) continue; // a keystore, or a folder
    const text = bytes.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      // Claude's config snapshot mixes sign-in state with public feature/model
      // caches. Exempt only observed public model metadata positions, never
      // arbitrary leaves in a cache. Key-shape redaction remains independent.
      if (name === '.claude.json' && parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (['cachedGrowthBookFeatures', 'cachedExperimentData', 'clientDataCacheSlots'].includes(key)) {
            const publicModel = path => (
              key === 'clientDataCacheSlots' && path.length === 2 && /^bi1-[a-f0-9]{16}$/.test(path[0]) && path[1] === 'model'
            ) || (
              key === 'cachedGrowthBookFeatures' && path.length === 2 && ['tengu_tool_search_unsupported_models', 'tengu_lucky_cerf'].includes(path[0]) && /^\d+$/.test(path[1])
            ) || (
              key === 'cachedExperimentData' && path.length === 3 && path[0] === 'tengu_lucky_cerf' && path[1] === 'value' && /^\d+$/.test(path[2])
            );
            const metadata = (v, path = []) => {
              if (v && typeof v === 'object') for (const [field, child] of Object.entries(v)) metadata(child, [...path, field]);
              else if (!publicModel(path) || typeof v !== 'string' || !/^claude-(?:opus|sonnet|haiku|fable|[0-9])[-a-z0-9]*$/.test(v)) take(v);
            };
            metadata(value);
          } else leaves(value);
        }
      } else leaves(parsed);
      continue;
    } catch {}
    for (const line of text.split('\n')) {
      take(line);
      const value = /^\s*(?:export\s+)?[\w.-]+\s*[=:]\s*(.*)$/.exec(line)?.[1];
      if (value) take(value.trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

const hash = text => createHash('sha256').update(text).digest('hex');
// A word, for matching against the hashes of what the model redacted.
const WORD = /[^\s'"`<>()[\]{},;:=/\\|*]{6,}/g;

// hashes: of values the model reported redacting (learned), so they are
// redacted from then on wherever they appear.
export function redactor(values = [], hashes = new Set()) {
  return text => {
    let out = String(text)
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1[redacted]@')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
      // a password said in so many words: "sudo is …", "password: …", "… is the password"
      .replace(/\b((?:sudo|password)(?: password)?(?: is|:)\s+)(?!\[redacted\]|(?:required|needed|not|no|available|enabled|disabled|blocked|missing|set|the|a|an|only|still|now|fine|ok|okay|working|asked|prompting|wrong|correct|right|changed|in|on)\b)[^\s,.;)]+/gi, '$1[redacted]')
      .replace(/(\S{4,})(\s+is\s+(?:the|my|his)\s+(?:sudo\s+)?(?:password|passcode|pin)\b)/gi, (all, word, rest) => (/[\d\W_]|[a-z][A-Z]/.test(word) && word !== '[redacted]' ? `[redacted]${rest}` : all));
    for (const shape of SHAPES) out = out.replace(shape, '[redacted]');
    for (const value of values) if (out.includes(value)) out = out.split(value).join('[redacted]');
    if (hashes.size) {
      out = out.replace(WORD, word => {
        const bare = word.replace(/[.,!?]+$/, '');
        return hashes.has(hash(bare)) ? `[redacted]${word.slice(bare.length)}` : word;
      });
    }
    return out;
  };
}

// What the model reported redacting, kept as hashes in .secrets: one word of
// at least six characters, the way WORD finds it, shaped like a secret (a
// digit, a sign, mixed case, or long), so a word the model took for one by
// mistake ("locusrifle") is not taken out of all of memory.
const learned = async dir => new Set((await readFile(join(dir, '.secrets'), 'utf8').catch(() => '')).split('\n').filter(line => /^[0-9a-f]{64}$/.test(line)));
async function learn(dir, hashes, values) {
  const fresh = values.map(value => String(value).trim().replace(/^[`'"]+|[`'".,!?]+$/g, ''))
    .filter(value => value.match(WORD)?.[0] === value && (/[\d\W_]|[a-z][A-Z]/.test(value) || value.length >= 16)).map(hash).filter(known => !hashes.has(known));
  if (!fresh.length) return;
  for (const known of fresh) hashes.add(known);
  await put(join(dir, '.secrets'), `${[...hashes].join('\n')}\n`);
}

// --- the filter --------------------------------------------------------------
// The words of a message, with a marker for each thing that is not words.
function said(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b?.type === 'text' ? b.text ?? '' : b?.type === 'image' ? '[image]' : b?.type === 'document' ? '[document]' : ''))
    .filter(Boolean).join('\n');
}

const firstLine = text => (String(text).split('\n').map(line => line.trim()).find(Boolean) ?? '').slice(0, 100);
// What the harness says on Noah's behalf: notifications, command output, stops.
const HARNESS = /^(<task-notification>|<local-command-|\[Request interrupted by user|Caveat: The messages below)/;

// A picture (or any file) written into text as a data: URL.
const DATA_URL = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g;
export function noahWords(text) {
  const words = String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<([\w-]*hook[\w-]*)>[\s\S]*?<\/\1>/g, '')
    .replace(/(<\/spoken-input>)\s*<instruction>[\s\S]*?<\/instruction>/g, '$1')
    .replace(/<spoken-input>\s*([\s\S]*?)\s*<\/spoken-input>/g, '[spoken] $1')
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, body) => `[pasted text: ${firstLine(body)}]`)
    .replace(DATA_URL, '[data]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // A slash command reads as he typed it: /model opus.
  const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(words);
  if (command) return [command[1], /<command-args>([\s\S]*?)<\/command-args>/.exec(words)?.[1].trim()].filter(Boolean).join(' ');
  return HARNESS.test(words) ? '' : words;
}

// Turns: each of Noah's messages, then the agent's last text before his next.
// Text before his first message answers nobody.
function turns(events, afterRecord = 0) {
  const out = [];
  let reply = null;
  for (const event of events) {
    // A new block may share the old reply's message id, but not its words.
    if (afterRecord && event.sourceRecordIndex > afterRecord && reply?.sourceRecordIndex <= afterRecord) reply = null;
    if (event.who === 'noah') {
      if (reply) out.push(reply);
      reply = null;
      out.push(event);
    } else if (event.who === 'agent' && out.length) {
      const same = reply && event.id && reply.id === event.id;
      reply = same ? (reply.text.endsWith(event.text) ? reply : { ...event, text: `${reply.text}\n\n${event.text}` }) : event;
    }
  }
  if (reply) out.push(reply);
  return out.filter(event => !afterRecord || event.sourceRecordIndex > afterRecord)
    .map(({ at, who, text }) => ({ at, who, text: text.trim() }));
}

// A JSON object a line, one at a time, from text (Pi's answer).
function* lines(text) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

// A log's lines, read as its bytes stream in: only one line is ever a string,
// so a log of any size is read whole if no line of it is longer than most
// (what Node can make a string of; a line longer is the log's error).
export async function* logLines(bytes, most = constants.MAX_STRING_LENGTH) {
  let parts = [], size = 0;
  for await (const chunk of bytes) {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      parts.push(chunk.subarray(start, end));
      size += end - start;
      if (size > most) break;
      yield Buffer.concat(parts, size).toString('utf8');
      parts = [];
      size = 0;
      start = end + 1;
    }
    if (size <= most && start < chunk.length) { parts.push(chunk.subarray(start)); size += chunk.length - start; }
    if (size > most) throw new Error(`a line of more than ${most} bytes`);
  }
  if (size) yield Buffer.concat(parts, size).toString('utf8');
}

// Pictures go as soon as a line is read: an image (or document) keeps only
// that it was one, which is all said() notes ([image]), and a data: URL
// anywhere is [data], as in Noah's words. What a tool wrote into a file is
// only measured (toolLine), never shown, so it keeps its length.
const ARGUMENTS = { tool_use: 'input', toolCall: 'arguments' };
function unpictured(value, measured = false) {
  if (typeof value === 'string') return measured ? value : value.replace(DATA_URL, '[data]');
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'image' || value.type === 'document') return { type: value.type };
  for (const [key, inner] of Object.entries(value)) {
    value[key] = key === ARGUMENTS[value.type] && inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).map(([name, arg]) => [name, unpictured(arg, measured || BODY.test(name))]))
      : unpictured(inner, measured);
  }
  return value;
}

// A log's JSON objects, pictures out, from its text or a stream of its bytes.
async function* records(log, most) {
  let sourceRecordIndex = 0;
  for await (const line of typeof log === 'string' ? log.split('\n') : logLines(log, most)) {
    if (!line.trim()) continue;
    sourceRecordIndex++;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    yield { record: unpictured(record), sourceRecordIndex };
  }
}

const oneLine = (text, most) => { const line = String(text).replace(/\s+/g, ' ').trim(); return line.length > most ? `${line.slice(0, most)}…` : line; };

// For the model, a tool call is one line: its name and arguments, a body
// (what was written into a file) only measured; and its result cut short, a
// file read only counted, a worker's report kept longer.
const BODY = /^(content|new_string|old_string|edits|oldText|newText|patch)$/;
function toolLine(name, input) {
  const args = Object.entries(input && typeof input === 'object' ? input : {}).flatMap(([key, value]) => {
    if (value == null || value === '') return [];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return [BODY.test(key) ? `${key}=(${text.length} chars)` : `${key}=${oneLine(text, /prompt|command|text|description|query/.test(key) ? 600 : 160)}`];
  });
  return `${name}(${args.join(', ')})`;
}
function resultLine(name, content, error) {
  const text = said(content).trim();
  if (!text) return error ? 'error' : '';
  if (/^read$/i.test(name) && !error) return `(${text.split('\n').length} lines)`;
  return `${error ? 'error: ' : ''}${oneLine(text, /^(agent|task)$/i.test(name) ? 2000 : 300)}`;
}

// Each reader answers the session's id, folder and the agent's models; its
// events in order: Noah's words, the agent's words, each tool call (with its
// result) and the harness's notes (a worker finished); and from those the
// filter's turns (entries). Each reads a log's text or a stream of its bytes
// (most: as logLines).
// Claude Code: one JSON object a line; an assistant message is spread over a
// line per block, sharing message.id. It sometimes writes a stretch of a
// session into its log again, uuids and all: a line already read is skipped.
export async function readClaude(log, most, { afterRecord = 0 } = {}) {
  let id = '', cwd = '';
  const events = [], models = new Set(), calls = new Map(), seen = new Set();
  for await (const { record: e, sourceRecordIndex } of records(log, most)) {
    const emit = event => events.push({ ...event, sourceRecordIndex });
    if (seen.has(e.uuid)) continue;
    if (e.uuid) seen.add(e.uuid);
    const at = Date.parse(e.timestamp);
    id ||= e.sessionId ?? '';
    cwd ||= e.cwd ?? '';
    if (e.isSidechain || !Number.isFinite(at)) continue;
    const content = e.message?.content;
    if (e.type === 'user') {
      const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : [];
      for (const b of results) { const call = calls.get(b.tool_use_id); if (call) call.result = resultLine(call.name, b.content, b.is_error); }
      const words = said(content);
      if (/^\s*<task-notification>/.test(words)) { emit({ at, who: 'note', text: oneLine(words.replace(/<[^>]*>/g, ' '), 600) }); continue; }
      if (e.toolUseResult !== undefined || results.length || e.isMeta || e.isCompactSummary || e.promptSource === 'system' || (e.origin && e.origin.kind !== 'human')) continue;
      const noah = noahWords(words);
      if (noah) emit({ at, who: 'noah', text: noah });
    } else if (e.type === 'assistant' && !e.isApiErrorMessage && e.message?.model !== '<synthetic>') {
      if (e.message?.model && sourceRecordIndex > afterRecord) models.add(e.message.model);
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text' && b.text?.trim()) emit({ at, who: 'agent', id: e.message?.id, text: b.text });
        else if (b?.type === 'tool_use') { const call = { at, who: 'tool', name: b.name, text: toolLine(b.name, b.input), result: '', sourceRecordIndex }; calls.set(b.id, call); events.push(call); }
      }
    }
  }
  return { id, cwd, models: [...models], events: events.filter(event => event.sourceRecordIndex > afterRecord), entries: turns(events, afterRecord) };
}

// Pi: a header line, then entries; a reply that failed is retried as another.
export async function readPi(log, most, { afterRecord = 0, archive = false } = {}) {
  let id = '', cwd = '';
  const events = [], models = new Set(), calls = new Map(), seen = new Set();
  for await (const { record: e, sourceRecordIndex: index } of records(log, most)) {
    const sourceRecordIndex = archive ? e.sourceRecordIndex : index;
    const emit = event => events.push({ ...event, sourceRecordIndex });
    const at = Date.parse(e.timestamp);
    if (e.type === 'session') { id ||= e.id ?? ''; cwd ||= e.cwd ?? ''; continue; }
    if (e.type !== 'message' || !Number.isFinite(at)) continue;
    if (afterRecord && e.id) {
      if (seen.has(e.id)) continue; // a replay of a historical record is not a new turn
      seen.add(e.id);
    }
    const m = e.message ?? {};
    if (archive && m.role === 'user' && e.archiveKind && e.archiveKind !== 'pi.user') {
      emit({ at, who: 'note', text: oneLine(said(m.content), 600) });
    } else if (m.role === 'user') {
      const words = noahWords(said(m.content));
      if (words) emit({ at, who: 'noah', text: words });
    } else if (m.role === 'toolResult') {
      const call = calls.get(m.toolCallId);
      if (call) call.result = resultLine(call.name, m.content, m.isError);
    } else if (m.role === 'assistant' && m.stopReason !== 'error') {
      if (m.model && sourceRecordIndex > afterRecord) models.add(m.provider ? `${m.provider}/${m.model}` : m.model);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text' && b.text?.trim()) emit({ at, who: 'agent', id: e.id, text: b.text });
        else if (b?.type === 'toolCall') { const call = { at, who: 'tool', name: b.name, text: toolLine(b.name, b.arguments), result: '', sourceRecordIndex }; calls.set(b.id, call); events.push(call); }
      }
    }
  }
  return { id, cwd, models: [...models], events: events.filter(event => event.sourceRecordIndex > afterRecord), entries: turns(events, afterRecord) };
}
// Codex rollouts retain response items as well as UI event messages. Prefer
// the response items (including tools), never both copies of the same turn.
export async function readCodex(log, most, { afterRecord = 0 } = {}) {
  let id = '', cwd = '', source;
  const events = [], fallback = [], models = new Set(), calls = new Map(), seen = new Set();
  const content = blocks => said(typeof blocks === 'string' ? blocks : blocks?.map(b => ({ ...b,
    type: ['input_text', 'output_text'].includes(b?.type) ? 'text' : b?.type === 'input_image' ? 'image' : b?.type })));
  const userWords = text => /^(?:# AGENTS\.md instructions\b|<environment_context\b|<INSTRUCTIONS>)/.test(text.trim()) ? '' : noahWords(text);
  for await (const { record: e, sourceRecordIndex } of records(log, most)) {
    const p = e.payload ?? {}, at = Date.parse(e.timestamp);
    if (e.type === 'session_meta') { id ||= p.id ?? ''; cwd ||= p.cwd ?? ''; source = p.source; continue; }
    if (e.type === 'turn_context') { if (p.model && sourceRecordIndex > afterRecord) models.add(p.model); continue; }
    if (!Number.isFinite(at) || !['event_msg', 'response_item'].includes(e.type)) continue;
    const key = JSON.stringify([e.type, at, p]);
    if (seen.has(key)) continue;
    seen.add(key);
    const emit = (event, into = events) => into.push({ at, ...event, sourceRecordIndex });
    if (e.type === 'event_msg') {
      const item = p.type === 'item_completed' ? p.item : null;
      const who = p.type === 'user_message' || item?.type === 'UserMessage' ? 'noah'
        : p.type === 'agent_message' || item?.type === 'AgentMessage' ? 'agent' : null;
      const text = who === 'noah' ? userWords(item ? content(item.content) : p.message ?? '') : item ? content(item.content) : p.message;
      if (who && text?.trim()) emit({ who, text }, fallback);
    } else if (e.type === 'response_item') {
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const text = p.role === 'user' ? userWords(content(p.content)) : content(p.content);
        if (text.trim()) emit({ who: p.role === 'user' ? 'noah' : 'agent', id: p.id, text });
      } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
        let input = p.input ?? p.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { arguments: input }; } }
        const call = { at, who: 'tool', name: p.name, text: toolLine(p.name, input), result: '', sourceRecordIndex };
        calls.set(p.call_id, call); events.push(call);
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const call = calls.get(p.call_id);
        if (call) call.result = resultLine(call.name, content(p.output), false);
      }
    }
  }
  // Exec/subagent rollouts are still archived byte-for-byte, not episodes in
  // which their injected task is mistaken for Noah speaking.
  if (source && !['cli', 'vscode'].includes(source)) return { id, cwd, models: [], events: [], entries: [] };
  const echoes = new Map(), echoKey = e => JSON.stringify([e.who, e.text.replace(/\[(?:image|document)\]/g, '').trim()]);
  for (const e of events) echoes.set(echoKey(e), (echoes.get(echoKey(e)) ?? 0) + 1);
  for (const e of fallback) {
    const key = echoKey(e), n = echoes.get(key) ?? 0;
    if (n) echoes.set(key, n - 1); else events.push(e);
  }
  events.sort((a, b) => a.sourceRecordIndex - b.sourceRecordIndex);
  return { id, cwd, models: [...models], events: events.filter(e => e.sourceRecordIndex > afterRecord), entries: turns(events, afterRecord) };
}
const READERS = { claude: readClaude, pi: readPi, codex: readCodex };

// --- joined to git -----------------------------------------------------------
// `git reflog --date=iso-strict --format='%H %gd'`: "<hash> HEAD@{<time>}", newest first.
export function parseReflog(text) {
  return String(text).split('\n').flatMap(line => {
    const m = /^([0-9a-f]{40}) \S*@\{([^}]+)\}/.exec(line.trim());
    const at = m && Date.parse(m[2]);
    return m && Number.isFinite(at) ? [{ commit: m[1], at }] : [];
  }).sort((a, b) => a.at - b.at);
}
export const commitAt = (reflog, at) => reflog.findLast(move => move.at <= at)?.commit ?? null;

// Uuid v7 ids (Pi) begin with the time, so their tail tells sessions apart.
export const shortId = id => (/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(id) ? id.replace(/-/g, '').slice(-8) : id.replace(/-/g, '').slice(0, 8));

// --- the days ----------------------------------------------------------------
// A line of what was said that reads like the days' own structure.
const STRUCTURE = /^(# \d{4}-\d\d-\d\d|## \d\d:\d\d–\d\d:\d\d .*|### \d\d:\d\d (?:noah|vaita|agent)|-- commit \S+ --)$/gm;
// Probes and tests run in throwaway folders; nobody spoke there.
const throwaway = cwd => /^(\/tmp|\/var\/tmp|\/private\/tmp|\/(?:home|Users)\/[^/]+\/\.cache)(\/|$)/.test(cwd);
// Shorter than this, what Noah said ("yes", "continue") is not distinctive.
const DISTINCTIVE = 20;

// A replay: a session in which everything distinctive Noah said, he had said
// word for word in an earlier one. It points to where he first said it.
function markReplays(sessions) {
  const said = session => session.entries.filter(entry => entry.who === 'noah' && entry.text.length >= DISTINCTIVE);
  const first = new Map();
  for (const session of sessions) {
    if (session.imported) continue; // continuations cannot turn canonical history into a replay
    for (const entry of said(session)) {
      const known = first.get(entry.text);
      if (!known || entry.at < known.at) first.set(entry.text, { session, at: entry.at });
    }
  }
  for (const session of sessions) {
    const own = said(session), earlier = own.map(entry => first.get(entry.text));
    if (!session.imported && own.length && earlier.every((known, i) => known.session !== session && known.at < own[i].at)) session.replayOf = earlier[0];
  }
}

// One session's part of one day: each piece as the model wrote it, or as the
// filter did where it has not.
const atClock = (date, time) => new Date(`${date}T${time}:00`).getTime();
function renderPart({ session, from, to, before, pieces }, redact) {
  const { computer, harness, id, cwd, raw, reflog, replayOf, models } = session;
  const heading = `## ${clock(from)}–${clock(to)} ${computer} ${harness} ${shortId(id)}`;
  if (replayOf) {
    const when = day(replayOf.at) === day(from) ? clock(replayOf.at) : `${day(replayOf.at)} ${clock(replayOf.at)}`;
    return `${heading} · replay of ${shortId(replayOf.session.id)} (${when})\n`;
  }
  const made = [...new Set(pieces.filter(piece => piece.derived).map(piece => piece.derived.made))];
  const filtered = pieces.filter(piece => !piece.derived).map(piece => `${clock(piece.from)}–${clock(piece.to)}`);
  const projects = [...new Set(pieces.flatMap(piece => piece.derived?.projects ?? []))];
  let commit = commitAt(reflog, from);
  const out = [heading, `cwd: ${cwd}`, `session: ${id}`, `raw: ${raw}`, `commit: ${commit ?? 'none'}`, `model: ${models.join(', ') || 'unknown'}`,
    `made: ${!made.length ? 'filter' : `${made.join(', ')}${filtered.length ? `, and the filter for ${filtered.join(', ')}` : ''}`}`];
  if (projects.length) out.push(`projects: ${projects.join(', ')}`);
  if (before) out.push(`continues from ${before}`);
  const summary = pieces.flatMap(piece => (piece.derived?.summary ? piece.derived.summary.split('\n') : []));
  // Lines that are not points are indented, so none reads as a field.
  if (summary.length) out.push('', 'summary:', ...summary.map(line => redact(/^- /.test(line) ? line : `  ${line.trim()}`)));
  const date = day(from);
  for (const piece of pieces) {
    const said = piece.derived ? piece.derived.turns.map(turn => ({ ...turn, at: atClock(date, turn.time) })) : piece.entries;
    for (const entry of said) {
      const now = commitAt(reflog, entry.at);
      if (now !== commit) { commit = now; out.push('', `-- commit ${now ?? 'none'} --`); }
      out.push('', `### ${clock(entry.at)} ${entry.who}`, redact(entry.text).replace(STRUCTURE, '\\$1'));
    }
  }
  return `${out.join('\n')}\n`;
}

// Each session's turns split by day, with its episodes that day; a day's
// sessions in the order of their first turn that day. Answers date -> parts.
function dayParts(sessions, now) {
  const days = new Map();
  for (const session of sessions) {
    const byDay = Map.groupBy(session.entries, entry => day(entry.at)), cuts = Map.groupBy(session.replayOf ? [] : episodes(session, now), episode => episode.day);
    [...byDay.keys()].sort().forEach((date, i, dates) => {
      const entries = byDay.get(date), cut = cuts.get(date) ?? [];
      // From its first turn to its last, or to work that landed after it.
      const times = [...entries.map(entry => entry.at), ...cut.flatMap(piece => [piece.from, piece.to])];
      (days.get(date) ?? days.set(date, []).get(date)).push({ session, entries, pieces: cut, from: Math.min(...times), to: Math.max(...times), before: dates[i - 1] });
    });
  }
  for (const parts of days.values()) parts.sort((a, b) => a.from - b.from);
  return days;
}
const renderDay = (date, parts, redact) => `# ${date}\n${parts.map(part => `\n${renderPart(part, redact)}`).join('')}`;

// --- the model ---------------------------------------------------------------
const MODEL = 'openai-codex/gpt-6.1-sol', THINKING = 'high';
const PI = join(REPO, 'node_modules', '.bin', 'pi');
const PROMPT = join(REPO, 'system', 'memory-prompt.md');
const PIECE_BYTES = 100 * 1024; // what one call reads, at most: about 25K tokens, 3 minutes
const RUN_MS = 90 * 60_000; // no call starts later than this into a run
const TRIES = 3; // answers that could not be used, before an episode is left to the filter

// The transcript as the model reads it.
function transcriptLine(event) {
  const time = `[${clock(event.at)}]`;
  if (event.who === 'noah') return `\n${time} NOAH:\n${cap(event.text, 20_000)}\n`;
  if (event.who === 'agent') return `${time} AGENT: ${cap(event.text.trim(), 8000)}`;
  if (event.who === 'note') return `${time} (note) ${event.text}`;
  return `${time} · ${event.text}${event.result ? `\n    → ${event.result}` : ''}`;
}

// --- projects ----------------------------------------------------------------
// What an episode worked on, named from where: ~/imperfect is imperfect,
// ~/projects/<name> that project, ~/workbench/<piece> and ~/archive/<piece>
// that piece, and ~/notes/<name>.md its topic. Older sessions put a piece in
// a stage, ~/workbench/<stage>/<piece>: still that piece, and a stage is
// never a name. A name is also a file name in projects/.
export const projectName = name => String(name).toLowerCase().trim().replace(/\.md$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
const PLACE = /(?:~|\/(?:home|Users)\/[^/\s'"`]+|\/root)\/(?:(imperfect)(?![\w.-])|(?:projects|archive)\/([\w.-]+)|workbench\/([\w.-]+)(?:\/([\w.-]+))?|notes\/([\w.-]+)\.md)/g;
const STAGE = /^(ideas|making|done|inspo|archive)$/;
export function projectsIn(text) {
  const names = new Set();
  for (const [, imperfect, kept, piece, inStage, topic] of String(text).matchAll(PLACE)) {
    const found = imperfect ?? kept ?? (STAGE.test(piece ?? '') ? inStage : piece) ?? topic;
    const name = found && projectName(found.replace(/\.+$/, ''));
    if (name) names.add(name);
  }
  return [...names];
}

// The projects there are, from those folders in this computer's home: each
// name with where it is, for the model to name them by.
export async function knownProjects(home = homedir()) {
  const known = new Map([['imperfect', '~/imperfect']]);
  const folders = async path => (await readdir(path, { withFileTypes: true }).catch(() => [])).filter(entry => !entry.name.startsWith('.'));
  for (const entry of await folders(join(home, 'projects'))) if (entry.isDirectory()) known.set(projectName(entry.name), `~/projects/${entry.name}`);
  for (const top of ['archive', 'workbench']) {
    for (const piece of await folders(join(home, top))) if (!STAGE.test(piece.name)) known.set(projectName(piece.name.replace(/\.[^.]+$/, '')), `~/${top}/${piece.name}`);
  }
  for (const entry of await folders(join(home, 'notes'))) if (entry.isFile() && entry.name.endsWith('.md')) known.set(projectName(entry.name), `~/notes/${entry.name}`);
  known.delete('');
  return [...known].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 300).map(([name, where]) => `${name} (${where})`);
}

// --- episodes ----------------------------------------------------------------
// A session in episodes, cut from its start. One ends where the agent's words
// close a turn and nothing follows for EPISODE_GAP (or where nothing at all
// follows for QUIET_MS: a turn left hanging), and at midnight, so an episode
// is one day's. One longer than the model reads at once is cut where Noah
// speaks once it is half full, or wherever the next line would overflow it.
// A session that goes on leaves its episodes as they were and adds new ones.
// The last is closed once the log has been still for EPISODE_GAP after the
// agent's words, or for QUIET_MS whatever it ended on (a log copied into raw/
// is); until then it is live, and the model waits. Each carries the filter's
// turns for its stretch, in case the model has not done it.
function episodes(session, now) {
  const cut = [];
  let size = 0, last = null;
  for (const event of session.events) {
    const text = transcriptLine(event), bytes = Buffer.byteLength(text) + 1, gap = last ? event.at - last.at : 0;
    const ended = last && (day(event.at) !== day(last.at) || gap >= QUIET_MS || (gap >= EPISODE_GAP && last.who === 'agent'));
    const full = size && ((event.who === 'noah' && size > PIECE_BYTES / 2) || size + bytes > PIECE_BYTES);
    if (!cut.length || ended || full) { cut.push([]); size = 0; }
    cut.at(-1).push({ event, text });
    size += bytes;
    last = event;
  }
  const quiet = session.live ? now - Math.max(session.mtime ?? 0, last?.at ?? 0) : Infinity;
  return cut.map((stretch, i) => {
    const from = stretch[0].event.at, to = stretch.at(-1).event.at, next = cut[i + 1]?.[0].event.at ?? Infinity;
    const said = session.events.filter(event => event.who === 'noah' && event.at < from);
    const earlier = (said.length > 21 ? [said[0], ...said.slice(-20)] : said).map(event => `- ${day(event.at)} ${clock(event.at)} ${oneLine(event.text, 200)}`);
    const transcript = stretch.map(line => line.text).join('\n'), touched = projectsIn(`${session.cwd}\n${transcript}`);
    const head = [`Session ${session.id} on ${session.computer}, harness ${session.harness}, in ${session.cwd}; the agent's model: ${session.models.join(', ') || 'unknown'}.`,
      `This stretch: ${day(from)}, ${clock(from)}–${clock(to)}, local time.`,
      `Projects its paths point to: ${touched.join(', ') || 'none'}.`];
    if (earlier.length) head.push('', 'Earlier in this session, Noah said (context only):', ...earlier);
    const input = `${head.join('\n')}\n\nTranscript:\n${transcript}\n`;
    const live = i === cut.length - 1 && !(quiet >= QUIET_MS || (quiet >= EPISODE_GAP && stretch.at(-1).event.who === 'agent'));
    return { from, to, day: day(from), input, key: hash(input), derived: null, tries: 0, live, touched,
      where: { session: session.id, computer: session.computer, harness: session.harness, cwd: session.cwd },
      label: `${day(from)} ${clock(from)} ${session.computer} ${session.harness} ${shortId(session.id)}`,
      entries: session.entries.filter(entry => (i ? entry.at >= from : true) && entry.at < next) };
  });
}

// The model's answer: the projects, a summary, the turns headed
// `### HH:MM who`, and after `=== secrets` what it redacted. A turn outside the
// episode's minutes means it lost its place, and the answer is not used
// (unusable: it counts as a try). With no projects line, projects is null.
const unusable = message => Object.assign(new Error(message), { answer: true });
export function parseAnswer(text, { from, to }) {
  const [body, tail = ''] = String(text).split(/^=== secrets[ \t]*$/m);
  const summary = [], turns = [];
  let projects = null;
  for (const line of body.split('\n')) {
    const head = /^### (\d\d):(\d\d) (noah|vaita|agent)[ \t]*$/.exec(line), named = !turns.length && /^projects:(.*)$/i.exec(line.trim());
    if (head) turns.push({ time: `${head[1]}:${head[2]}`, who: head[3], lines: [] });
    else if (named) projects = [...new Set(named[1].split(',').map(projectName).filter(name => name && name !== 'none'))].slice(0, 6);
    else (turns.at(-1)?.lines ?? summary).push(line);
  }
  if (!turns.length) throw unusable('the answer has no turns');
  const minutes = ms => { const [h, m] = clock(ms).split(':'); return h * 60 + Number(m); };
  for (const { time } of turns) {
    const [h, m] = time.split(':'), at = h * 60 + Number(m);
    if (at < minutes(from) - 1 || at > minutes(to) + 1) throw unusable(`a turn at ${time} is outside ${clock(from)}–${clock(to)}`);
  }
  return {
    projects,
    summary: summary.join('\n').replace(/^\s*summary:\s*/i, '').trim(),
    turns: turns.map(({ time, who, lines: body }) => ({ time, who, text: body.join('\n').trim() })).filter(turn => turn.text),
    secrets: tail.split('\n').map(line => line.trim()).filter(Boolean),
  };
}

// Pi, from this repository, with no tools, files or session of its own: the
// transcript in, the answer out. An answer cut short is unusable; no answer
// at all (Pi down, signed out, timed out) is not the piece's fault.
export const askPi = (prefix = resolvePrefix()) => (input, prompt = PROMPT) => new Promise((done, fail) => {
  const child = execFile(process.execPath, [PI, '-p', '--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files',
    '--no-prompt-templates', '--no-themes', '--model', MODEL, '--thinking', THINKING, '--system-prompt', prompt],
  { env: { ...process.env, PI_CODING_AGENT_DIR: join(prefix, 'data', 'agent') }, cwd: tmpdir(), maxBuffer: 1 << 28, timeout: 15 * 60_000 }, (error, stdout, stderr) => {
    const end = [...lines(stdout)].findLast(event => event.type === 'agent_end');
    const answer = end?.messages?.findLast(message => message.role === 'assistant');
    if (error || !answer) return fail(new Error(`pi: ${oneLine(String(stderr || error?.message || 'no answer'), 300)}`));
    if (answer.stopReason !== 'stop') return fail(unusable(`pi stopped: ${answer.stopReason} ${answer.errorMessage ?? ''}`.trim()));
    done(said(answer.content));
  });
  child.stdin.end(input);
});

// The episodes waiting for the model, by key: closed, not written yet, not
// given up on. Every reading adds to it (enqueue), so one that closes while
// the model works through the backlog goes next.
export const episodeQueue = () => Object.assign(new Map(), { done: new Set() });
const waiting = piece => !piece.derived && piece.tries < TRIES && !piece.live;
function enqueue(queue, pieces) {
  for (const piece of pieces) if (waiting(piece) && !queue.done.has(piece.key)) queue.set(piece.key, piece);
}

// The queue through the model, one call at a time, newest first; each answer
// kept as soon as it is in, with where and when the episode was, and then
// after() (the views made again). A run stops starting calls after RUN_MS, or
// when Pi has failed three times running (it is caught up next run).
async function derive(queue, { dir, ask, redact, hashes, log, known = [], after = async () => {} }) {
  const store = join(dir, 'derived');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const start = Date.now(), made = [];
  let failing = 0;
  while (queue.size && failing < 3 && Date.now() - start < RUN_MS) {
    const piece = [...queue.values()].reduce((a, b) => (b.to > a.to ? b : a));
    queue.delete(piece.key);
    queue.done.add(piece.key);
    try {
      const told = known.length ? `Known projects (name and where): ${known.join(', ')}.\n\n` : '';
      const answer = parseAnswer(await ask(redact(`${told}${piece.input}`)), piece);
      await learn(dir, hashes, answer.secrets);
      piece.derived = { made: `${MODEL.split('/').pop()} ${THINKING}`, at: localTime(Date.now()), ...piece.where, day: piece.day, from: piece.from, to: piece.to,
        projects: (answer.projects ?? piece.touched).filter(name => redact(name) === name),
        summary: redact(answer.summary), turns: answer.turns.map(turn => ({ ...turn, text: redact(turn.text) })) };
      await put(join(store, `${piece.key}.json`), `${JSON.stringify(piece.derived)}\n`);
      failing = 0;
      made.push(piece.key);
      await after();
    } catch (error) {
      log(`${piece.label}: ${error.message}`);
      if (error.answer) await put(join(store, `${piece.key}.json`), `${JSON.stringify({ tries: ++piece.tries, error: error.message })}\n`);
      else { failing++; queue.done.delete(piece.key); }
    }
  }
  return { made, left: queue.size };
}

// The episodes the model has written, newest first: one for each stretch,
// the latest answer where a stretch was asked again.
async function readEpisodes(dir) {
  const store = join(dir, 'derived'), stretches = new Map();
  for (const name of (await readdir(store).catch(() => [])).filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
    const record = await readFile(join(store, name), 'utf8').then(JSON.parse, () => null);
    if (!record?.turns || !record.session) continue;
    const episode = { key: name.slice(0, 64), ...record, projects: record.projects ?? [] }, same = `${record.computer} ${record.session} ${record.from}`;
    const known = stretches.get(same);
    if (!known || Date.parse(known.at) < Date.parse(record.at)) stretches.set(same, episode);
  }
  return [...stretches.values()].sort((a, b) => b.to - a.to || (a.key < b.key ? -1 : 1));
}

// --- recent.md ---------------------------------------------------------------
// The last two days at a glance, for an agent starting a session: what is
// open (openList), then each session's part of each day, most recently active
// first, under the heading it has in that day's file, and what happened in
// it: the summary its entry opens with, or where the model has not been (a
// log still being written, or one it has not reached yet), Noah's messages in
// order, each one line cut to its first 200 characters (the first, which sets
// the session going, to 600). Over 24 KB, the oldest sessions are left out
// whole, and the top says so.
const RECENT_MS = 48 * 3600_000;
export const RECENT_BYTES = 24 * 1024;
const tilde = path => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderRecent(days, { now, redact, dir, open, raised = [], review = null }) {
  const parts = [...days.values()].flat()
    .filter(part => part.to >= now - RECENT_MS && !part.session.replayOf && part.entries.some(entry => entry.who === 'noah'))
    .sort((a, b) => b.to - a.to)
    .map(({ session: { computer, harness, id, cwd, live }, from, to, pieces }) => ({
      date: day(from),
      head: `### ${clock(from)}–${clock(to)} ${computer} ${harness} ${shortId(id)} · ${tilde(cwd)}${live ? ' · still being written' : ''}`,
      said: pieces.flatMap((piece, p) => (piece.derived ? piece.derived.summary.split('\n').filter(line => line.trim()).map(line => redact(/^- /.test(line) ? line : `  ${line.trim()}`))
        : piece.entries.filter(entry => entry.who === 'noah').map((entry, i) => `- ${clock(entry.at)} ${oneLine(redact(entry.text), i || p ? 200 : 600)}`))),
    }));
  const render = (kept, cut = 0) => {
    const out = [`# recent: what happened in the last 48 hours, newest first (made ${localTime(now).slice(0, 16).replace('T', ' ')})`, '',
      `First what is open: what imperfect's own jobs could not do (an update whose tests fail, for an agent to fix), then what waits on Noah or was left unfinished, as the model that writes memory last listed it, each with the day and session it came from. Then each session, headed as in that day's file (times, computer, harness, id) with the folder it ran in, and whether its log is still being written; then what happened in it: the summary its entry in that day's file opens with, or, where the model has not been yet, Noah's messages in order, each cut to one line. The whole record, Noah word for word and what each agent did, is ${tilde(dir)}/days/YYYY-MM-DD.md, and the recall tool searches it.`];
    if (open || raised.length || review) out.push('', `## Open${open ? ` (listed ${open.made})` : ''}`, '', ...raised, ...(open?.items.length ? open.items : raised.length ? [] : ['- nothing']));
    if (review) out.push('', `The nightly review of ${review.day} waits on Noah's answers: the Pi session "nightly review ${review.day}" in imperfect, opened ${review.opened.slice(0, 16).replace('T', ' ')}.`);
    const left = parts.slice(kept.length);
    if (left.length) out.push('', `Left out to keep this short: ${plural(left.length, 'older session')} (${plural(left.reduce((n, part) => n + part.said.length, 0), 'line')}), back to ${left.at(-1).date} ${left.at(-1).head.slice(4, 9)}. They are in days/.`);
    if (cut) out.push('', `Left out of the newest session: its first ${plural(cut, 'line')}.`);
    if (!parts.length) out.push('', 'Nothing was said in these 48 hours.');
    let date = '';
    for (const part of kept) {
      if (part.date !== date) out.push('', `## ${date = part.date}`);
      out.push('', part.head, ...(part === kept[0] ? part.said.slice(cut) : part.said));
    }
    return `${out.join('\n')}\n`;
  };
  const fits = text => Buffer.byteLength(text) <= RECENT_BYTES;
  let kept = parts.length, text = render(parts);
  while (!fits(text) && kept > 1) text = render(parts.slice(0, --kept));
  for (let cut = 1; !fits(text) && cut < (parts[0]?.said.length ?? 0); cut++) text = render(parts.slice(0, 1), cut);
  return text;
}

// --- what is open ------------------------------------------------------------
// Waiting on Noah, or left unfinished, across sessions: the model reads
// recent.md as an agent would, with the list it wrote last time at the top,
// and writes the list again (memory-open-prompt.md), each item a line
// `- <date> <session>: …`, at most OPEN_BYTES of them. It is kept in
// open.json with the episodes of the last 48 hours it was written after, so
// it is asked again only after a new one, and at most every OPEN_MS; an answer
// that is not a list leaves the last one standing.
const OPEN_PROMPT = join(REPO, 'system', 'memory-open-prompt.md');
const OPEN_BYTES = 1536;
const OPEN_MS = 30 * 60_000;
const readOpen = dir => readFile(join(dir, 'open.json'), 'utf8').then(JSON.parse, () => null);

export function parseOpen(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const items = lines.filter(line => /^- \d{4}-\d\d-\d\d \S+: \S/.test(line));
  if (!items.length && !(lines.length === 1 && /^none\.?$/i.test(lines[0]))) throw unusable('the answer is not a list');
  let bytes = 0;
  return items.filter(item => (bytes += Buffer.byteLength(item) + 1) <= OPEN_BYTES);
}

// Answers the list, and whether it was written again.
async function openList({ dir, ask, redact, now, log }) {
  const before = await readOpen(dir);
  const key = hash((await readEpisodes(dir)).filter(episode => episode.to >= now - RECENT_MS).map(episode => episode.key).sort().join('\n'));
  const recent = await readFile(join(dir, 'recent.md'), 'utf8').catch(() => null);
  if (recent === null || before?.key === key || now - (before?.at ?? 0) < OPEN_MS) return { open: before, asked: false };
  try {
    // recent.md as an agent reads it, but for the line saying when it was made
    // and what imperfect's own jobs raised, which are theirs to take away.
    const raised = new Set((await readRaised(dir)).map(redact));
    let section = false;
    const read = recent.split('\n').slice(1).filter(line => {
      if (/^## /.test(line)) section = /^## Open\b/.test(line);
      return !(section && raised.has(line));
    }).join('\n');
    const open = { key, at: now, made: localTime(now).slice(0, 16).replace('T', ' '), items: parseOpen(redact(await ask(read, OPEN_PROMPT))) };
    await put(join(dir, 'open.json'), `${JSON.stringify(open, null, 1)}\n`);
    return { open, asked: true };
  } catch (error) {
    log(`open: ${error.message}`);
    return { open: before, asked: false };
  }
}

// What imperfect's own jobs leave open, a file each in open/ (upgrade.md:
// packages system/upgrade.mjs could not take), written and taken away by the
// job itself. Shown as they are, above the model's list, and never given to
// the model, so it neither carries one on nor lets one go.
export const raisedDir = (dir = memoryDir()) => join(dir, 'open');
async function readRaised(dir) {
  const names = (await readdir(raisedDir(dir)).catch(() => [])).filter(name => /\.(md|json)$/.test(name)).sort().slice(0, 256);
  const texts = await Promise.all(names.map(async name => {
    if (name.endsWith('.md')) return readFile(join(raisedDir(dir), name), 'utf8').catch(() => '');
    // Worker notices also have a markdown projection; do not list twice.
    if (names.includes(name.replace(/\.json$/, '.md'))) return '';
    try {
      const file = join(raisedDir(dir), name);
      if ((await stat(file)).size > 256 * 1024) return '- Raised incident is too large to read.';
      const record = JSON.parse(await readFile(file, 'utf8'));
      return `- ${redactor()(String(record.summary || record.title || record.kind || 'Raised incident')).replace(/[\r\n]+/g, ' ').slice(0, 500)} (${name})`;
    } catch { return '- A raised incident could not be read.'; }
  }));
  return texts.flatMap(text => text.split('\n').filter(line => line.trim()));
}

// --- the views made from derived/ --------------------------------------------
// projects/<name>.md, each project's episodes newest first, and index.json,
// project -> episodes and day -> episodes (newest first), each episode with
// where and when it was. By code alone, from the episodes the model wrote;
// made again only when they changed.
async function renderViews(dir) {
  const episodes = await readEpisodes(dir);
  const index = { episodes: {}, projects: {}, days: {} };
  for (const episode of episodes) {
    const { key, day: date, from, to, computer, harness, session, cwd, projects } = episode;
    index.episodes[key] = { day: date, from: localTime(from), to: localTime(to), computer, harness, session, short: shortId(session), cwd: tilde(cwd), projects, file: `days/${date}.md` };
    for (const name of projects) (index.projects[name] ??= []).push(key);
    (index.days[date] ??= []).push(key);
  }
  const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)));
  const text = `${JSON.stringify({ projects: sorted(index.projects), days: sorted(index.days), episodes: index.episodes }, null, 1)}\n`;
  const known = await readFile(join(dir, 'index.json'), 'utf8').catch(() => null);
  if (known === text && await stat(join(dir, 'projects')).catch(() => null)) return;
  const byKey = new Map(episodes.map(episode => [episode.key, episode]));
  await swap(dir, 'projects', Object.entries(index.projects).map(([name, keys]) => [`${name}.md`, renderProject(name, keys.map(key => byKey.get(key)))]));
  await put(join(dir, 'index.json'), text);
}

function renderProject(name, episodes) {
  const out = [`# ${name}: every episode that touched it, newest first`, '',
    `Made from the model's episodes. Each is headed with its day, times, computer, harness and short session id; its turns, Noah word for word, are under that session in days/<day>.md, and the recall tool searches them by project.`];
  for (const { day: date, from, to, computer, harness, session, cwd, projects, summary } of episodes) {
    const also = projects.filter(other => other !== name);
    out.push('', `## ${date} ${clock(from)}–${clock(to)} ${computer} ${harness} ${shortId(session)}`, `session: ${session} · ${tilde(cwd)}${also.length ? ` · also: ${also.join(', ')}` : ''}`,
      ...summary.split('\n').filter(line => line.trim()).map(line => (/^- /.test(line) ? line : `  ${line.trim()}`)));
  }
  return `${out.join('\n')}\n`;
}

// A folder of the memory made again whole, and swapped in.
async function swap(dir, name, files) {
  const fresh = join(dir, `${name}.${process.pid}.part`), stale = join(dir, `${name}.${process.pid}.old`);
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh, { recursive: true, mode: 0o700 });
  for (const [file, text] of files) await writeFile(join(fresh, file), text, { mode: 0o600 });
  await rename(join(dir, name), stale).catch(() => {});
  await rename(fresh, join(dir, name));
  await rm(stale, { recursive: true, force: true });
}

// --- the nightly review ------------------------------------------------------
// Once a night, on a pass in NIGHT_HOUR (04:00 to 04:59, and only then: a
// first run in the evening waits for the night), memory opens a Pi session
// in imperfect (POST /sessions/open on loopback, with the session token, as
// locker/tell.mjs does), named "nightly review <day>", in the sessions like
// any other, on memory's own model and thinking level where Pi's settings
// name none: it reads the day before (its episodes, the
// projects they touched, recent.md, ~/AGENTS.md, ~/notes, the day's commits),
// looks at where the system met Noah and where it did not, asks him each
// decision with its question tool, and acts on his answers in the morning
// (memory-nightly-prompt.md). Unanswered decisions stay in their original
// review for at most REVIEW_DAYS; subsequent nights do repair-only maintenance,
// without replacing that record. No episodes means no session unless an upgrade
// failure is raised. nightly.json holds decision reviews and the last night checked.
const NIGHTLY_PROMPT = join(REPO, 'system', 'memory-nightly-prompt.md');
const NIGHT_HOUR = 4;
const REVIEW_DAYS = 7;
const reviewMark = date => `Nightly review of ${date}.`;
const readNightly = dir => readFile(join(dir, 'nightly.json'), 'utf8').then(JSON.parse, () => ({ reviews: [] }));

// Opens a session in the imperfect on this computer: { agent, cwd, name,
// prompt, model?, thinking? } -> { id }.
export const openSessionHere = (prefix = resolvePrefix(), send = fetch) => async session => {
  const token = (await readFile(join(prefix, 'session-token'), 'utf8')).trim();
  const { port } = await readConfig(prefix);
  const response = await send(`http://127.0.0.1:${port}/sessions/open`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(session), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`imperfect said ${response.status}`);
  return response.json();
};

// The last review, if it waits on Noah: opened under REVIEW_DAYS ago, and its
// session (found by the line it opens with) shows no answer from him.
function waitingReview(nightly, sessions, now) {
  const last = nightly.reviews?.at(-1);
  if (!last || now - Date.parse(last.opened) >= REVIEW_DAYS * 24 * 3600_000) return null;
  const session = sessions.find(one => one.entries.find(entry => entry.who === 'noah')?.text.startsWith(reviewMark(last.day)));
  const answered = session && (session.entries.filter(entry => entry.who === 'noah').length > 1
    || session.events.some(event => event.who === 'tool' && event.name === 'AskUserQuestion' && event.result && !/^error|closed the questions without answering/.test(event.result)));
  return answered ? null : last;
}

// Memory's model and thinking level for a Pi session, where Pi's own settings
// (data/agent/settings.json) do not name one.
async function reviewModel(prefix) {
  const settings = await readFile(join(prefix, 'data', 'agent', 'settings.json'), 'utf8').then(JSON.parse, () => ({}));
  return { ...(settings.defaultModel ? {} : { model: MODEL }), ...(settings.defaultThinkingLevel ? {} : { thinking: THINKING }) };
}

async function nightly({ prefix, dir, home, sessions, now, open, log, hour = NIGHT_HOUR }) {
  const state = await readNightly(dir), today = day(now);
  if (new Date(now).getHours() !== hour || state.checked >= today) return;
  const date = day(startOfDay(now) - 1), save = () => put(join(dir, 'nightly.json'), `${JSON.stringify({ ...state, checked: today }, null, 1)}\n`);
  const episodes = (await readEpisodes(dir)).some(episode => episode.day === date);
  const raisedUpgrade = await readFile(join(dir, 'open', 'upgrade.md'), 'utf8').then(text => !!text.trim(), () => false);
  if (!episodes && !raisedUpgrade) { log(`nightly review: no episodes or raised upgrade failure on ${date}`); return save(); }
  const waiting = waitingReview(state, sessions, now), repairOnly = !!waiting || !episodes;
  const mode = repairOnly ? `REPAIR-ONLY maintenance. ${waiting ? `The prior unanswered review is "nightly review ${waiting.day}" (session ${waiting.id}). Preserve its unanswered record; do not duplicate questions or act on pending decisions.` : 'No episodes yesterday; inspect the raised upgrade failure.'} Ask no new questions in this pass.\n\n` : '';
  const prompt = `${reviewMark(date)}\n\n${mode}${(await readFile(NIGHTLY_PROMPT, 'utf8')).replaceAll('{{day}}', date).replaceAll('{{memory}}', tilde(dir)).replaceAll('{{pulseState}}', tilde(join(prefix, 'data', 'state'))).trim()}\n`;
  try {
    const { id } = await open({ agent: 'pi', cwd: home, name: `${repairOnly ? 'nightly repair' : 'nightly review'} ${date}`, prompt, ...await reviewModel(prefix) });
    if (!repairOnly) state.reviews = [...(state.reviews ?? []).slice(-30), { day: date, opened: localTime(now), id }];
    log(`nightly ${repairOnly ? 'repair' : 'review'}: opened for ${date}`);
    await save();
  } catch (error) {
    log(`nightly review: ${error.message}; tried again next pass`);
  }
}

// --- reading and writing -----------------------------------------------------
// Every session from raw/ and the logs read where they are (live, standing in
// for their older copies in raw/), split into each day's parts and cut into
// episodes, each with the model's kept answer. With since, only the logs
// written to from then on, as .done.json tells, which are all the days from
// then on need: each holds only sessions written to that day or later.
async function load({ prefix, dir, live = [], since = 0, now, log }) {
  const hashes = await learned(dir);
  const redact = redactor(await credentialValues(join(prefix, 'credentials')), hashes);
  const done = Object.values(await readDone(dir));
  const written = new Map(done.map(entry => [entry.raw, entry.mtime]));
  const imports = new Map(done.filter(entry => entry.importPath).map(entry => [entry.raw, entry.importPath]));
  const provenanceByRaw = new Map(done.filter(entry => entry.provenance).map(entry => [entry.raw, entry.provenance]));
  const provenanceByPath = new Map(done.filter(entry => entry.provenance).map(entry => [entry.provenance.path, entry.provenance]));
  const logs = new Map();
  for (const computer of await readdir(join(dir, 'raw')).catch(() => [])) {
    for (const harness of Object.keys(READERS)) {
      for (const name of (await readdir(join(dir, 'raw', computer, harness)).catch(() => [])).filter(name => name.endsWith('.gz'))) {
        const raw = join('raw', computer, harness, name);
        if (!(written.get(raw) < since)) logs.set(raw, { computer, harness, bytes: () => pipeline(createReadStream(join(dir, raw)), createGunzip(), () => {}) });
      }
    }
  }
  for (const { raw, path, snapshot, mtime } of live) {
    const [, computer, harness] = raw.split('/');
    logs.set(raw, { computer, harness, bytes: () => createReadStream(path), path, snapshot, mtime });
  }
  const sessions = [], reflogs = new Map();
  let unread = 0;
  for (const [raw, { computer, harness, bytes, path, snapshot, mtime }] of [...logs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!reflogs.has(computer)) reflogs.set(computer, parseReflog(await readFile(join(dir, 'reflog', computer), 'utf8').catch(() => '')));
    try {
      const durable = raw.endsWith('.sqlite.gz');
      const importPath = imports.get(raw) ?? path;
      const provenance = durable ? provenanceByRaw.get(raw) : importPath ? (await readMemoryImport(dir, importPath) || provenanceByPath.get(importPath)) : null;
      if (imports.has(raw) && !provenance) throw new Error('memory import: archived import manifest missing');
      let session, legacyHash, identity, archiveSize;
      const digest = createHash('sha256');
      if (durable) {
        const archive = await loadDurableArchive(snapshot || join(dir, raw));
        const legacy = archive.entries.find(e => e.kind === 'imperfect.legacy');
        if (legacy) {
          legacyHash = hash(legacy.data.source);
          if (provenance) for await (const _ of importedBytes(Readable.from([Buffer.from(legacy.data.source)]), provenance)) { /* validate immutable prefix */ }
        } else if (provenance) throw new Error('memory import: Durable archive has no original');
        session = await readPi(durableArchiveRows(archive, { activeBranch: true }).map(JSON.stringify).join('\n'), undefined,
          { afterRecord: provenance?.recordCount ?? 0, archive: true });
        identity = archive.identity; archiveSize = archive.entries.length;
      } else {
        const hashed = async function* () { for await (const chunk of bytes()) { digest.update(chunk); yield chunk; } };
        session = await READERS[harness](provenance ? importedBytes(hashed(), provenance) : hashed(), undefined,
          { afterRecord: provenance?.recordCount ?? 0 });
      }
      session.id ||= basename(raw, '.jsonl.gz');
      // Keep even an empty Durable projection here: it can supersede a legacy
      // import containing only historical/abandoned messages, without episodes.
      if ((durable || (provenance ? session.entries.length : session.entries.some(entry => entry.who === 'noah'))) && !throwaway(session.cwd)) {
        sessions.push({ ...session, computer, harness, durable, identity, archiveSize, legacyHash, sourceHash: durable ? null : digest.digest('hex'), imported: Boolean(provenance), raw: path ? `${tilde(path)} (being written)` : raw, live: Boolean(path), mtime, reflog: reflogs.get(computer) });
      }
    } catch (error) {
      unread++;
      log(`${raw}: ${error.message}`);
    }
  }
  // Exact source bytes, not a shared title/UUID, prove a JSONL is already in a
  // Durable archive. Snapshots/mirrors of that same Durable identity count once.
  const originals = new Set(sessions.filter(s => s.legacyHash).map(s => `${s.computer}:${s.legacyHash}:${s.imported}`));
  const latest = new Map();
  for (const s of sessions.filter(s => s.durable)) {
    const key = s.identity;
    if (!latest.has(key) || latest.get(key).archiveSize < s.archiveSize || (latest.get(key).archiveSize === s.archiveSize && s.imported && !latest.get(key).imported)) latest.set(key, s);
  }
  const selected = sessions.filter(s => s.durable ? latest.get(s.identity) === s && s.entries.length : !originals.has(`${s.computer}:${s.sourceHash}:${s.imported}`));
  // A runtime archive/renamed rollout can mirror a native log, or an older
  // prefix of it. UUID alone is not proof: retain divergent histories. Compare
  // original bytes or the complete ordered narrative, within one provenance.
  const unique = [], histories = new Map();
  const narrative = s => s.events.map(({ at, who, id, name, text, result }) => JSON.stringify([at, who, id, name, text, result]));
  for (const s of selected) {
    if (s.durable) { unique.push(s); continue; }
    const key = JSON.stringify([s.computer, s.harness, s.id, s.cwd, s.imported]);
    const peers = histories.get(key);
    if (!peers) { histories.set(key, [{ session: s }]); unique.push(s); continue; }
    const story = narrative(s);
    const same = peers.find(p => p.session.sourceHash === s.sourceHash || (p.story ||= narrative(p.session)).slice(0, Math.min(p.story.length, story.length)).every((event, i) => event === story[i]));
    if (!same) { peers.push({ session: s, story }); unique.push(s); }
    else if (story.length > same.session.events.length || (story.length === same.session.events.length && s.live && !same.session.live)) {
      unique[unique.indexOf(same.session)] = s;
      same.session = s; same.story = story;
    }
  }
  sessions.splice(0, sessions.length, ...unique);
  markReplays(sessions);
  const days = dayParts(sessions, now);
  const pieces = [...days.values()].flat().flatMap(part => part.pieces);
  const store = join(dir, 'derived');
  const kept = new Set(await readdir(store).catch(() => []));
  for (const piece of pieces) {
    if (!kept.has(`${piece.key}.json`)) continue;
    const answer = await readFile(join(store, `${piece.key}.json`), 'utf8').then(JSON.parse, () => null);
    if (answer?.turns) piece.derived = answer;
    else piece.tries = answer?.tries ?? 0;
  }
  return { sessions, days, pieces, redact, hashes, unread };
}

// days/, the views made from derived/, and recent.md, written from a reading.
// With since, the days from then on, each put in place (the rest stand as the
// last whole pass made them); without, all of days/ made again and swapped in
// whole.
async function render({ dir, days, redact, now, since, open, sessions }) {
  if (since) {
    for (const [date, parts] of days) if (date >= day(since)) await put(join(dir, 'days', `${date}.md`), renderDay(date, parts, redact));
  } else {
    await swap(dir, 'days', [...days].map(([date, parts]) => [`${date}.md`, renderDay(date, parts, redact)]));
  }
  await renderViews(dir);
  return renderRecentFile({ dir, days, redact, now, open, sessions });
}
async function renderRecentFile({ dir, days, redact, now, open, sessions }) {
  const raised = (await readRaised(dir)).map(redact);
  const review = waitingReview(await readNightly(dir), sessions, now);
  const recent = renderRecent(days, { now, redact, dir, open, raised, review });
  await put(join(dir, 'recent.md'), recent);
  return recent;
}

// Answers no episode asks for any more are let go: the store holds only what
// a reading of everything (pieces) wants, and what was written meanwhile.
async function letGo(dir, pieces, made = []) {
  const wanted = new Set([...pieces.map(piece => piece.key), ...made].map(key => `${key}.json`));
  for (const name of await readdir(join(dir, 'derived')).catch(() => [])) if (!wanted.has(name)) await rm(join(dir, 'derived', name), { force: true });
}

// --- gathering ---------------------------------------------------------------
const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
// BSD and GNU find share -exec, not -printf or stat's format flags. Node is
// already required for the source-side SQLite backup; use its nanosecond stat
// here too, so same-size WAL commits still invalidate the collection stamp.
const FILE_STATS = `const { statSync } = require('node:fs'); for (const path of process.argv.slice(1)) { const s = statSync(path, { bigint: true }); if (s.isFile()) console.log([String(s.size), Number(s.mtimeNs) / 1e9, path, String(s.ctimeNs), String(s.dev) + ':' + String(s.ino)].join('\\t')); }`;
const LIST = `find "$HOME/.claude/projects" "$HOME/.pi/agent/sessions" "$HOME/.pi/agent/sessions-from-the-other-runtime" "$HOME/.imperfect/data/state/sessions" "$HOME/.imperfect/data/state/sessions-from-the-other-runtime" "$HOME/.imperfect/data/agent/sessions" "$HOME/.imperfect/data/agent/sessions-from-the-other-runtime" "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions" \\( -name '*.jsonl' -o -name '*.sqlite' -o -name '*.sqlite-wal' \\) -not -path '*/subagents/*' -exec node -e ${quote(FILE_STATS)} {} + 2>/dev/null; true`;
const REFLOG = `git -C "$HOME/imperfect" reflog --date=iso-strict --format='%H %gd' 2>/dev/null; true`;

// A command's output, or with into, the output streamed into that file, so a
// log of any size is never held.
const failed = (error, stderr) => new Error(String(stderr || error.message).trim().split('\n').at(-1));
function exec(file, args, options = {}, into = null) {
  if (!into) {
    return new Promise((done, fail) => execFile(file, args, { encoding: 'buffer', maxBuffer: 1 << 30, timeout: 600_000, ...options },
      (error, stdout, stderr) => (error ? fail(failed(error, stderr)) : done(stdout))));
  }
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, ...options });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const ended = new Promise((done, fail) => child.on('error', error => fail(failed(error))).on('close', (code, signal) =>
    (code === 0 ? done() : fail(failed(new Error(`${file} ended with ${signal ?? code}`), stderr)))));
  // A failed command can exit before the destination even opens. Let both
  // lifetimes settle before put() removes its partial file, or an outstanding
  // write can recreate that file after cleanup. A failed destination must also
  // stop the producer instead of waiting for its command timeout.
  const copied = pipe(child.stdout, createWriteStream(into, { mode: 0o600 })).catch(error => {
    child.kill();
    throw error;
  });
  return Promise.allSettled([ended, copied]).then(([exit, copy]) => {
    if (copy.status === 'rejected') throw copy.reason;
    if (exit.status === 'rejected') throw exit.reason;
  });
}
export const here = (env = process.env) => (command, into) => exec('sh', ['-c', command], { env }, into);
// SSH is non-login on a Mac: its Dock/keeper Node need not be on sshd's PATH.
// Read only the public runtime path, never any harness or credential config.
export const memorySourceEnvironment = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -x /usr/bin/plutil ] && [ -f "$HOME/.imperfect/mac.json" ]; then
  imperfect_node=$(/usr/bin/plutil -extract node raw -o - "$HOME/.imperfect/mac.json" 2>/dev/null) || imperfect_node=
  if [ -n "$imperfect_node" ] && [ -x "$imperfect_node" ]; then export PATH="$(dirname "$imperfect_node"):$PATH"; fi
fi
node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || a === 22 && b >= 19 ? 0 : 1)' >/dev/null 2>&1 || { echo 'History collection requires Node 22.19 or newer on the source computer' >&2; exit 1; }
`;
export const overSsh = destination => (command, into) => exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'ControlMaster=auto', '-o', `ControlPath=/tmp/imperfect-memory-${process.getuid?.() ?? 0}-%C`, '-o', 'ControlPersist=60', destination, `${memorySourceEnvironment}${command}`], {}, into);

// This computer (local: its logs still being written are read where they
// are), and the others named in computers.json.
export async function computers(dir = memoryDir()) {
  const others = await readFile(join(dir, 'computers.json'), 'utf8').then(JSON.parse, () => ({}));
  return [{ name: hostname().split('.')[0], run: here(), local: true },
    ...Object.entries(others).filter(([, to]) => typeof to === 'string' && to).map(([name, to]) => ({ name, run: overSsh(to) }))];
}

// data, or what write(part) writes there, put in place whole.
async function put(path, data, write = part => writeFile(part, data, { mode: 0o600 })) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  try {
    await write(part);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  await rename(part, path);
}
const readDone = async dir => {
  let text;
  try { text = await readFile(join(dir, '.done.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const done = JSON.parse(text);
  if (!done || typeof done !== 'object' || Array.isArray(done)) throw new Error('Invalid memory collection index; refusing to forget archive provenance');
  return done;
};

// Each computer's reflog is kept beside the raw logs, so days/ can be made
// from raw/ alone, even once a harness or git has let go.
async function keepReflog(dir, name, text) {
  const path = join(dir, 'reflog', name);
  const known = await readFile(path, 'utf8').catch(() => '');
  const all = [...new Set(`${known}\n${text}`.split('\n').filter(Boolean))].join('\n');
  if (all !== known) await put(path, `${all}\n`);
}

// Quiet JSONL logs are gzipped byte-for-byte; active local ones are read live.
// SQLite always travels as a standalone online backup, including hot remote
// databases. Never gzip/copy only a live SQLite main file.
async function copy({ dir, from, now, log }) {
  const donePath = join(dir, '.done.json');
  const done = await readDone(dir), live = [];
  const rawOwners = new Map(Object.entries(done).map(([key, entry]) => [entry.raw, key]));
  const convertedImports = new Map(Object.values(done).filter(e => e.provenance).map(e => [e.provenance.path, e.provenance]));
  let taken = 0, importProblems = 0;
  for (const { name, run, local } of from) {
    let files;
    try {
      files = String(await run(LIST)).split('\n').flatMap(line => {
        const [size, time, path, ctime, inode] = line.split('\t');
        return path ? [{ size: Number(size), mtime: Math.round(Number(time) * 1000), path, stamp: JSON.stringify([size, time, ctime, inode]) }] : [];
      });
      const wal = new Map(files.filter(f => f.path.endsWith('.sqlite-wal')).map(f => [f.path.slice(0, -4), f]));
      files = files.filter(f => !f.path.endsWith('.sqlite-wal')).map(f => f.path.endsWith('.sqlite')
        ? { ...f, stamp: JSON.stringify([f.stamp, wal.get(f.path)?.stamp]), mtime: Math.max(f.mtime, wal.get(f.path)?.mtime || 0) } : f);
      await keepReflog(dir, name, String(await run(REFLOG)));
    } catch (error) {
      log(`${name}: not reachable (${error.message}); it is caught up later`);
      continue;
    }
    for (const file of files) {
      const key = `${name}:${file.path}`;
      const harness = file.path.includes('/.claude/projects/') ? 'claude' : file.path.includes('/.codex/') ? 'codex' : 'pi';
      const durable = file.path.endsWith('.sqlite');
      const distinctPath = durable || harness === 'codex' || file.path.includes('/sessions-from-the-other-runtime/') || file.path.includes('/.imperfect/data/agent/');
      let raw = done[key]?.raw || join('raw', name, harness, `${distinctPath ? `${hash(file.path)}-` : ''}${basename(file.path)}.gz`);
      if (rawOwners.has(raw) && rawOwners.get(raw) !== key) raw = join('raw', name, harness, `${hash(file.path)}-${basename(file.path)}.gz`);
      rawOwners.set(raw, key);
      try {
        if (durable) {
          // Snapshot hot databases too: remote work and WAL-only commits must
          // not wait for the source to become quiet. Always read our snapshot.
          if (local && now - file.mtime < QUIET_MS) live.push({ raw, path: file.path, snapshot: join(dir, raw), mtime: file.mtime });
          const reader = local ? quote(join(REPO, 'apps/code/native/durable-archive.mjs')) : '"$HOME/imperfect/apps/code/native/durable-archive.mjs"';
          const source = file.path.endsWith('.jsonl.durable.sqlite') ? file.path.slice(0, -'.durable.sqlite'.length) : null;
          let provenance = null;
          if (source) {
            if (local) provenance = await readMemoryImport(dir, source);
            else {
              const script = `import { readMemoryImport } from './system/memory-imports.mjs'; import { homedir } from 'node:os'; import { join } from 'node:path'; console.log(JSON.stringify(await readMemoryImport(join(homedir(), '.imperfect/memory'), ${JSON.stringify(source)})));`;
              provenance = JSON.parse(String(await run(`cd "$HOME/imperfect" && node --input-type=module -e ${quote(script)}`)));
            }
          }
          // Conversion can outlive its JSONL/manifest. Never forget a cutoff
          // already validated against this archive's immutable original bytes.
          provenance ||= done[key]?.provenance || null;
          if (done[key]?.stamp === file.stamp && JSON.stringify(done[key]?.provenance || null) === JSON.stringify(provenance)) continue;
          let size;
          await put(join(dir, raw), null, async part => {
            await run(`${local ? quote(process.execPath) : 'node'} ${reader} snapshot ${quote(file.path)}`, part);
            const archive = await loadDurableArchive(part, { compressed: true });
            size = archive.byteLength;
            if (provenance) {
              const source = archive.entries.find(e => e.kind === 'imperfect.legacy')?.data.source;
              if (!source) throw new Error('memory import: Durable archive has no original');
              for await (const _ of importedBytes(Readable.from([Buffer.from(source)]), provenance)) { /* validate before replacing raw */ }
            }
          });
          done[key] = { size, mtime: file.mtime, stamp: file.stamp, raw, ...(provenance ? { provenance } : {}) };
          await put(donePath, `${JSON.stringify(done, null, 1)}\n`);
          taken++;
          continue;
        }
        const provenance = local ? (await readMemoryImport(dir, file.path) || convertedImports.get(file.path)) : null;
        if (provenance) {
          raw = join('raw', name, harness, `import-${hash(file.path)}-${basename(file.path)}.gz`);
          await validateMemoryImport(file.path, provenance);
          if (file.size === provenance.byteCutoff) continue; // never resumed: no duplicate raw or episodes
        }
        if (now - file.mtime < QUIET_MS) {
          if (local) live.push({ raw, path: file.path, mtime: file.mtime });
          continue;
        }
        if (done[key]?.size === file.size && done[key]?.mtime === file.mtime) continue;
        await put(join(dir, raw), null, part => run(`gzip -c -- ${quote(file.path)}`, part));
        done[key] = { size: file.size, mtime: file.mtime, raw, ...(provenance ? { importPath: file.path } : {}) };
        await put(donePath, `${JSON.stringify(done, null, 1)}\n`);
        taken++;
      } catch (error) {
        importProblems++;
        log(`${key}: ${error.message}; tried again next pass`);
      }
    }
  }
  return { taken, live, importProblems };
}

// A pass: what changed copied from each computer (from) into raw/, then days/
// and recent.md made again, the days from since on or, without, all of them,
// and the views made from derived/. The closed episodes the model has not
// written go into queue. With ask (the model, askPi), it writes them, newest
// first, each followed by after() (in the timer's pass, a fresh pass, so
// recent.md has it) and the list of what is open when that is due, and the
// list once more. With open (a session opener, openSessionHere), the nightly
// review when it is due. serial: around copying and writing, so a pass can
// run beside the long middle of another. home: where ~/projects, ~/workbench,
// ~/archive and ~/notes are.
export async function gather({ prefix = resolvePrefix(), dir = memoryDir(prefix), home = homedir(), from, now = Date.now(), since = 0, log = console.log, ask, serial = job => job(), queue = episodeQueue(), after, open: opener, hour } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const started = Date.now(), clockNow = () => now + Date.now() - started;
  const { taken, live, importProblems } = await serial(async () => copy({ dir, from: from ?? await computers(dir), now, log }));
  const { sessions, days, pieces, redact, hashes, unread } = await load({ prefix, dir, live, since, now, log });
  enqueue(queue, pieces);
  let made = [], open = await readOpen(dir);
  if (ask) {
    const listed = async () => { const list = await openList({ dir, ask, redact, now: clockNow(), log }); open = list.open; return list.asked; };
    ({ made } = await derive(queue, { dir, ask, redact, hashes, log, known: await knownProjects(home),
      after: after && (async () => { await after(); if (await listed()) await after(); }) }));
    if (!since && !unread && !importProblems) await letGo(dir, pieces, made);
    await serial(() => render({ dir, days, redact, now, since, open, sessions }));
    await listed();
  }
  if (opener) await nightly({ prefix, dir, home, sessions, now: clockNow(), open: opener, log, hour });
  const recent = await serial(() => (ask ? renderRecentFile : render)({ dir, days, redact, now, since, open, sessions }));
  const derived = pieces.filter(piece => piece.derived).length;
  await put(join(dir, 'pulse-pass.json'), `${JSON.stringify({ finished: new Date(clockNow()).toISOString(), waiting: pieces.length - derived, derived, pieces: pieces.length })}\n`);
  return { taken, live: live.length, sessions: sessions.length, replays: sessions.filter(session => session.replayOf).length, days: days.size, recentBytes: Buffer.byteLength(recent),
    pieces: pieces.length, derived, derivedNow: made.length, waiting: pieces.length - derived, open: open?.items.length ?? null };
}

// One pass at a time: a socket in Linux's abstract namespace, named for the
// memory folder. The kernel lets it go when the process ends, however it
// ends, so a pass that died never holds up the next. Answers how to let go,
// or null while another pass holds it.
export function lock(dir = memoryDir()) {
  return new Promise(done => {
    const server = createServer();
    server.once('error', () => done(null));
    server.listen({ path: `\0imperfect-memory-${hash(resolve(dir)).slice(0, 16)}` }, () => { server.unref(); done(() => new Promise(closed => server.close(closed))); });
  });
}

// Per computer: its logs and their bytes (and gzipped, in raw/), the calls'
// recordings it once made and the bytes of those and their logs, and its sessions,
// replays and bytes in days/.
export async function sizes({ dir = memoryDir() } = {}) {
  const done = await readDone(dir);
  const by = {};
  const row = name => (by[name] ??= { logs: 0, rawBytes: 0, gzipBytes: 0, calls: 0, callBytes: 0, sessions: 0, replays: 0, memoryBytes: 0 });
  for (const [key, entry] of Object.entries(done)) {
    const r = row(key.slice(0, key.indexOf(':')));
    if (basename(dirname(entry.raw)) === 'calls') { if (entry.raw.endsWith('.webm')) r.calls++; r.callBytes += entry.size; continue; }
    r.logs++;
    r.rawBytes += entry.size;
    r.gzipBytes += (await stat(join(dir, entry.raw)).catch(() => null))?.size ?? 0;
  }
  const counted = new Set();
  for (const part of await readDays(dir)) {
    const r = row(part.computer);
    r.memoryBytes += part.bytes;
    if (!counted.has(part.key)) { counted.add(part.key); r[part.replay ? 'replays' : 'sessions']++; }
  }
  return { computers: by };
}

// --- recall ------------------------------------------------------------------
const SESSION = /^## \d\d:\d\d–\d\d:\d\d (\S+) (\S+) (\S+)( · replay of .*)?$/;
const sha = text => (/^[0-9a-f]{40}$/.test(text) ? text : null);

// The days read back: each session's part of each day, its turns with the
// commit at each.
async function readDays(dir) {
  const parts = [];
  const files = (await readdir(join(dir, 'days')).catch(() => [])).filter(name => /^\d{4}-\d\d-\d\d\.md$/.test(name)).sort();
  for (const file of files) {
    const path = join(dir, 'days', file), date = file.slice(0, 10);
    let part = null, entry = null, head = false;
    for (const line of (await readFile(path, 'utf8').catch(() => '')).split('\n')) {
      const session = SESSION.exec(line), turn = /^### (\d\d:\d\d) (noah|vaita|agent)$/.exec(line), move = /^-- commit (\S+) --$/.exec(line);
      if (session) {
        const [, computer, harness, short, replay] = session;
        part = { file, path, computer, harness, session: short, key: `${computer} ${harness} ${short}`, replay: Boolean(replay), commit: null, bytes: 0, entries: [] };
        parts.push(part);
        entry = null;
        head = true;
      } else if (part && turn) {
        const zone = localTime(new Date(`${date}T${turn[1]}`).getTime()).slice(19);
        entry = { time: `${date}T${turn[1]}${zone}`, who: turn[2], commit: part.commit, lines: [] };
        part.entries.push(entry);
        head = false;
      } else if (part && move) {
        part.commit = sha(move[1]);
        entry = null;
        head = false;
      } else if (head) {
        const field = /^(commit|session): (.*)$/.exec(line);
        if (field?.[1] === 'commit') part.commit = sha(field[2]);
        if (field?.[1] === 'session') part.key = field[2];
      } else if (entry) entry.lines.push(line.replace(/^\\(?=#{1,3} \d|-- commit )/, ''));
      if (part) part.bytes += Buffer.byteLength(line) + 1;
    }
  }
  for (const part of parts) part.entries = part.entries.map(({ lines: body, ...entry }) => ({ ...entry, text: body.join('\n').trim() }));
  return parts;
}

const terms = query => [...String(query).toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] ?? m[2]);

function isAncestor(commit, repo) {
  return new Promise(done => execFile('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'HEAD'], error => done(!error ? true : error.code === 1 ? false : null)));
}

// Every entry holding all the words: Noah's first, then the summaries of the
// episodes (what projects/ is made of), then the agents'; newest first in
// each. A hit brings its neighbour: the answer to a question, or the question
// an answer was for, from the session's next day if it was after midnight.
// With project, only what was said in the episodes the model named it in; with
// a project and no words, those episodes' summaries.
export async function search(query, { limit = 10, dir = memoryDir(), repo = REPO, project = '' } = {}) {
  const words = terms(query), name = project ? projectName(project) : '';
  if (!words.length && !name) return [];
  const holds = text => words.every(word => text.toLowerCase().includes(word));
  const episodes = (await readEpisodes(dir)).filter(episode => !name || episode.projects.includes(name));
  const within = (session, time) => {
    const at = Date.parse(time);
    return episodes.some(episode => episode.session === session && at >= episode.from - 60_000 && at <= episode.to + 60_000);
  };
  const hits = [];
  let order = 0;
  if (words.length) {
    const sessions = new Map();
    for (const { entries, key, file, path, computer, harness, session } of await readDays(dir)) {
      const turns = sessions.get(key) ?? sessions.set(key, []).get(key);
      for (const entry of entries) turns.push({ ...entry, file, path, computer, harness, session, key });
    }
    for (const turns of sessions.values()) {
      turns.forEach((entry, i) => {
        order++;
        if (!holds(entry.text) || (name && !within(entry.key, entry.time))) return;
        const other = turns[entry.who === 'noah' ? i + 1 : i - 1];
        const neighbour = other && other.who !== entry.who ? { who: other.who, time: other.time, text: other.text } : null;
        const { key, ...hit } = entry;
        hits.push({ ...hit, neighbour, order });
      });
    }
  }
  const minute = ms => { const time = localTime(ms); return `${time.slice(0, 16)}${time.slice(19)}`; };
  for (const episode of episodes) {
    if (!holds(episode.summary)) continue;
    const file = episode.projects[0] ? `projects/${episode.projects[0]}.md` : `days/${episode.day}.md`;
    hits.push({ who: 'summary', time: minute(episode.from), to: minute(episode.to), text: episode.summary, file, path: join(dir, file), computer: episode.computer, harness: episode.harness,
      session: shortId(episode.session), projects: episode.projects, commit: null, neighbour: null, order: order++ });
  }
  const rank = who => (who === 'noah' ? 0 : who === 'summary' ? 1 : 2);
  hits.sort((a, b) => rank(a.who) - rank(b.who) || Date.parse(b.time) - Date.parse(a.time) || b.order - a.order);
  const kept = hits.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  const known = new Map();
  for (const hit of kept) {
    delete hit.order;
    if (hit.commit && !known.has(hit.commit)) known.set(hit.commit, await isAncestor(hit.commit, repo));
    hit.ancestor = hit.commit ? known.get(hit.commit) : null;
  }
  return kept;
}

export const RECALL_TOOL = {
  name: 'recall',
  description: "Search what Noah and agents did in past sessions, on every computer: Noah's own words first, then summaries of episodes (a stretch of a session, as the model that keeps memory wrote it), then the agents' answers, newest first. Use it when asked about a past decision or \"what did we do about X\", and before redoing something that may have been settled. Give a few distinctive words; every word must appear (quote a phrase to keep it together). Give a project (imperfect, a folder in ~/projects, a piece in ~/workbench or ~/archive, a note's topic in ~/notes) to keep to the episodes that worked on it, or a project alone for its latest episodes. Each hit is the words said, with the question or answer beside it, its session and file, and the commit ~/imperfect was at then, so `git show <commit>:<path>` in ~/imperfect shows the system as it was. For what happened rather than a search, on the PC: ~/.imperfect/memory/recent.md is the last 48 hours, days/YYYY-MM-DD.md the whole record day by day, projects/<name>.md every episode of a project, and index.json lists episodes by project and by day.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'words that must all appear in what was said (may be empty when a project is given)' },
      project: { type: 'string', description: 'only episodes that worked on this project, e.g. imperfect or dacre' },
      limit: { type: 'number', description: 'how many hits, at most (default 10, up to 50)' },
    },
  },
};

// Where memory is, told by the machine server (createMemoryRoute): null here,
// else the PC's URL ('' while it cannot be reached).
let where = async () => null;

const cap = (text, most = 1200) => (text.length > most ? `${text.slice(0, most)} […]` : text);
function describe(query, hits, project = '') {
  const what = [query && `holding "${query}"`, project && `in the episodes of ${projectName(project)}`].filter(Boolean).join(' ');
  if (!hits.length) return `Nothing said in past sessions ${what}. Try fewer or other words${project ? ', or no project' : ''}.`;
  const out = [`${hits.length} thing${hits.length === 1 ? '' : 's'} said ${what} (Noah first, newest first). \`git show <commit>:<path>\` in ~/imperfect shows the system as it was then.`];
  hits.forEach((hit, i) => {
    if (hit.who === 'summary') {
      out.push('', `${i + 1}. summary of an episode, ${hit.time.slice(0, 16).replace('T', ' ')}–${hit.to.slice(11, 16)} on ${hit.computer} (${hit.harness} ${hit.session}), projects: ${hit.projects.join(', ') || 'none'}`, `   ${hit.path}`,
        `   ${cap(hit.text).replace(/\n/g, '\n   ')}`);
      return;
    }
    const commit = hit.commit ? `commit ${hit.commit.slice(0, 12)}${hit.ancestor === true ? ' (in HEAD)' : hit.ancestor === false ? ' (not in HEAD)' : ''}` : 'no commit (before ~/imperfect)';
    const pair = [hit, hit.neighbour].filter(Boolean).sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.who === 'noah' ? -1 : 1));
    out.push('', `${i + 1}. ${hit.who}, ${hit.time.slice(0, 16).replace('T', ' ')} on ${hit.computer} (${[hit.harness, hit.session].filter(Boolean).join(' ')}), ${commit}`, `   ${hit.path ?? hit.file}`,
      ...pair.map(entry => `   ${entry.who} ${entry.time.slice(11, 16)}: ${cap(entry.text).replace(/\n/g, '\n   ')}`));
  });
  return out.join('\n');
}

export async function runRecall({ query, project, limit, signal } = {}, { locate = () => where(), fetch: send = fetch, find = search } = {}) {
  const words = String(query ?? '').trim(), name = String(project ?? '').trim();
  if (!words && !name) throw new Error('recall needs words to look for, a project, or both');
  const most = Math.max(1, Math.min(50, Number(limit) || 10));
  const url = await locate();
  if (url === null) return describe(words, await find(words, { limit: most, project: name }), name);
  if (!url) throw new Error('Memory is kept on the PC, and this computer cannot reach it right now. Try again once the PC is on.');
  let response;
  try {
    response = await send(`${url}/memory`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ query: words, project: name, limit: most }), signal, redirect: 'error' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`The PC, which keeps memory, could not be reached (${error.message})`);
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`The PC, which keeps memory, answered: ${answer.error || response.status}`);
  return describe(words, answer.hits ?? [], name);
}

// The PC's side: POST /memory { query, project, limit } -> { hits }, for recall on the
// person's other computers. Guarded like /x: the exact origin is
// required, which a page elsewhere cannot claim and /peer/ drops.
// authority(): the PC's URL when this computer is not it, else null.
export function createMemoryRoute({ authority = async () => null, dir } = {}) {
  where = authority;
  return async function handle(req, res, path) {
    if (path !== '/memory' || req.method !== 'POST') return false;
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    try {
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16_384) throw Object.assign(new Error('too long'), { status: 413 });
      }
      const { query, project, limit } = JSON.parse(raw || '{}');
      json(200, { hits: await search(String(query ?? ''), { limit, project: String(project ?? ''), ...(dir ? { dir } : {}) }) });
    } catch (error) {
      json(error.status || 400, { error: error.message });
    }
    return true;
  };
}

// Memory lives where the others' things land: on the authority in
// machine.json, or here when this computer follows none (start.mjs).
// 0 here, 1 elsewhere, 2 cannot tell (no tailnet answer).
export async function memoryHome(prefix = resolvePrefix(), status = tailnetStatus) {
  const { authority } = await readConfig(prefix);
  if (!authority.id) return 0;
  const self = readTailnet(await status()).self?.id;
  return !self ? 2 : self === authority.id ? 0 : 1;
}

// A pass as the timer starts it, every two minutes: this computer's logs
// read, recent.md and the days it covers made again, and the episodes that
// closed given to the model. The first pass in each half hour (.whole), or
// one asked for, reaches every computer, makes all of days/ again and gives
// the model its backlog too. While the model works, a fresh pass still runs
// every two minutes beside it in this process, and what closes meanwhile goes
// to the model next. Once a night it opens the nightly review. In the first
// pass after each even hour (.upgraded) Pi and Claude Code are then brought
// up to date (system/upgrade.mjs), into this service's journal.
const FRESH_MS = 2 * 60_000;
const WHOLE_MS = 30 * 60_000;
const slot = ms => { const [date, hour] = localTime(ms).split('T'); return `${date} ${Math.floor(parseInt(hour, 10) / 2)}`; };

async function pass({ whole = false, dir = memoryDir() } = {}) {
  if (!await lock(dir)) return console.log('memory: another pass is running');
  const everyone = await computers(dir), local = everyone.filter(computer => computer.local), now = Date.now();
  const recently = () => startOfDay(Date.now() - RECENT_MS);
  let chain = Promise.resolve();
  const serial = job => (chain = chain.then(job, job));
  const queue = episodeQueue();
  const fresh = async () => {
    const result = await gather({ dir, from: local, since: recently(), queue });
    if (result.taken) console.log(`memory: took ${plural(result.taken, 'log')}, read ${result.live} still being written, made recent.md (${kb(result.recentBytes)})`);
  };
  const stamp = async name => Date.parse(await readFile(join(dir, name), 'utf8').catch(() => ''));
  if (whole || Math.floor(await stamp('.whole') / WHOLE_MS) !== Math.floor(now / WHOLE_MS)) {
    whole = true;
    await put(join(dir, '.whole'), localTime(now));
  }
  const beside = setInterval(() => serial(fresh).catch(error => console.error(`memory: fresh pass: ${error.message}`)), FRESH_MS);
  try {
    const result = await gather({ dir, from: whole ? everyone : local, since: whole ? 0 : recently(), ask: askPi(), serial, queue, after: () => serial(fresh), open: openSessionHere() });
    if (whole || result.taken || result.derivedNow) {
      console.log(`memory: took ${plural(result.taken, 'log')}, the model wrote ${plural(result.derivedNow, 'episode')} (${result.derived} of ${result.pieces} ${whole ? 'are' : 'lately are'} its, the rest the filter's, ${result.waiting} waiting) and ${result.open === null ? 'no list of what is open' : plural(result.open, 'open item')}, made ${whole ? `${result.days} days` : 'the last days'} and recent.md (${kb(result.recentBytes)}) again`);
    }
    await serial(fresh);
    const upgraded = await stamp('.upgraded');
    if (whole && !(Number.isFinite(upgraded) && slot(upgraded) === slot(now))) {
      await put(join(dir, '.upgraded'), localTime(now));
      await new Promise(done => spawn(process.execPath, [join(REPO, 'system', 'upgrade.mjs')], { stdio: 'inherit' }).on('close', done).on('error', error => { console.error(`memory: upgrade: ${error.message}`); done(); }));
    }
  } finally {
    clearInterval(beside);
  }
}
const kb = n => `${(n / 1024).toFixed(0)} KB`;

if (process.argv[1] === import.meta.filename) {
  const [command, ...rest] = process.argv.slice(2);
  const table = ({ computers: by }) => Object.entries(by).map(([name, r]) =>
    `${name}: ${r.logs} logs, ${kb(r.rawBytes)} (raw/ ${kb(r.gzipBytes)} gzipped); ${r.calls} calls recorded, ${kb(r.callBytes)}; ${r.sessions} sessions and ${r.replays} replays in days/, ${kb(r.memoryBytes)}`).join('\n');
  if (command === 'search') console.log(describe(rest.join(' '), await search(rest.join(' '), { limit: 20 })));
  else if (command === 'sizes') console.log(table(await sizes()));
  else if (command === 'home') process.exitCode = await memoryHome();
  else if (!command || command === 'whole') await pass({ whole: command === 'whole' });
  else {
    console.error('usage: node system/memory.mjs [whole | search <words> | sizes | home]');
    process.exitCode = 2;
  }
}
