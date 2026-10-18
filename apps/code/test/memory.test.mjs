process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createMemoryRoute, gather, openSessionHere, here, knownProjects, localTime, lock, logLines, memoryHome, parseAnswer, parseOpen, projectsIn, readClaude, readPi, RECENT_BYTES, redactor, runRecall, search, shortId, sizes } from '../../../system/memory.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'memory');
// Made here, so no file in the repository looks like a key.
const SECRET = ['gh', 'p_', 'Q'.repeat(36)].join('');
const CREDENTIAL = ['Zq7', 'notAReal', 'Token42xyz'].join('');
const CLAUDE_ID = 'c1a0de00-1111-4222-8333-444455556666';
const PI_ID = '01a0aaaa-0000-7000-8000-00000000beef';
const at = iso => new Date(iso);
const NOW = Date.parse('2026-09-30T03:00:00Z');

async function fixture(name) {
  return (await readFile(join(FIXTURES, name), 'utf8')).replaceAll('@@SECRET@@', SECRET).replaceAll('@@CREDENTIAL@@', CREDENTIAL);
}

// A home with a Claude session, a Pi session, a worker transcript, a probe in
// /tmp and one still being written; ~/imperfect committed at two times.
async function world() {
  const home = await mkdtemp(join(tmpdir(), 'memory-'));
  const prefix = join(home, '.imperfect');
  const project = join(home, '.claude', 'projects', '-home-noah--imperfect-data-workspace');
  const pi = join(prefix, 'data', 'state', 'sessions');
  await mkdir(join(project, CLAUDE_ID, 'subagents'), { recursive: true });
  await mkdir(pi, { recursive: true });
  await mkdir(join(prefix, 'credentials'), { recursive: true });
  await writeFile(join(prefix, 'credentials', 'box-token'), `${CREDENTIAL}\n`);
  const files = {
    claude: join(project, `${CLAUDE_ID}.jsonl`),
    pi: join(pi, `2026-09-30T01-00-00-000Z_${PI_ID}.jsonl`),
    worker: join(project, CLAUDE_ID, 'subagents', 'agent-1.jsonl'),
    probe: join(home, '.claude', 'projects', '-tmp-probe', 'b0b0b0b0-1111-4222-8333-444455556666.jsonl'),
    busy: join(project, 'd0d0d0d0-1111-4222-8333-444455556666.jsonl'),
  };
  await mkdir(join(home, '.claude', 'projects', '-tmp-probe'), { recursive: true });
  await writeFile(files.claude, await fixture('claude.jsonl'));
  await writeFile(files.pi, await fixture('pi.jsonl'));
  await writeFile(files.worker, (await fixture('claude.jsonl')).replaceAll('Make the theme picker', 'WORKER PROMPT'));
  await writeFile(files.probe, (await fixture('claude.jsonl')).replaceAll('/home/noah/.imperfect/data/workspace', '/tmp/probe'));
  await writeFile(files.busy, (await fixture('claude.jsonl')).replaceAll('Make the theme picker', 'STILL TALKING'));
  for (const file of Object.values(files)) await utimes(file, at('2026-09-30T02:00:00Z'), at('2026-09-30T02:00:00Z'));
  await utimes(files.busy, at('2026-09-30T02:55:00Z'), at('2026-09-30T02:55:00Z'));

  const repo = join(home, 'imperfect');
  const gitEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (when, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: { ...gitEnv, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }).trim();
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { env: gitEnv });
  git('2026-09-29T00:00:00Z', 'commit', '--quiet', '--allow-empty', '-m', 'one');
  const first = git('2026-09-29T00:00:00Z', 'rev-parse', 'HEAD');
  git('2026-09-30T00:20:00Z', 'commit', '--quiet', '--allow-empty', '-m', 'two');
  const second = git('2026-09-30T00:20:00Z', 'rev-parse', 'HEAD');

  const dir = join(prefix, 'memory');
  const from = [{ name: 'laptop', run: here({ ...process.env, HOME: home }) }];
  const run = (now = NOW, ask) => gather({ prefix, dir, home, from, now, log: () => {}, ask });
  return { home, prefix, dir, files, first, second, repo, run };
}

// Another finished Claude session in the world: [time, who, text] a turn,
// who a tool for a tool call (text its command); written to last at mtime.
async function addLog(w, id, said, { cwd = '/home/noah/.imperfect/data/workspace', mtime = '2026-09-30T02:00:00Z' } = {}) {
  const file = join(w.home, '.claude', 'projects', '-home-noah--imperfect-data-workspace', `${id}.jsonl`);
  await writeFile(file, said.map(([timestamp, who, text], i) => JSON.stringify(who === 'noah'
    ? { type: 'user', uuid: `${id}-${i}`, sessionId: id, cwd, timestamp, message: { role: 'user', content: text } }
    : { type: 'assistant', uuid: `${id}-${i}`, sessionId: id, cwd, timestamp, message: { id: `m${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [who === 'agent' ? { type: 'text', text } : { type: 'tool_use', id: `t${i}`, name: who, input: { command: text } }] } })).join('\n'));
  await utimes(file, at(mtime), at(mtime));
  return file;
}

test('Claude: Noah word for word and the last answer before his next message; the rest is gone', async () => {
  const session = await readClaude(await fixture('claude.jsonl'));
  assert.equal(session.id, CLAUDE_ID);
  assert.equal(session.cwd, '/home/noah/.imperfect/data/workspace');
  assert.deepEqual(session.entries.map(entry => entry.who), ['noah', 'agent', 'noah', 'agent']);
  const [ask, answer, paste] = session.entries;
  assert.equal(ask.text, 'Make the theme picker only pictures, like this\n[image]', 'the reminder is cut, the picture is a marker');
  assert.equal(answer.text, `The worker finished: the picker is only pictures now.\n\nIt pushed with the key ${SECRET} in the remote, so rotate it.`,
    'the answer after a background report is the turn\'s last; the in-between text is dropped');
  assert.match(paste.text, /^\[pasted text: Handoff notes from the laptop\]\nwhat do you think\?/);
  const all = session.entries.map(entry => entry.text).join('\n');
  for (const gone of ['TOOL OUTPUT', 'grep -n', 'read it first', 'Let me look', 'report back', 'task-notification', 'WORKER REPORT', 'SIDECHAIN', 'API Error', 'Continue from', 'interrupted', 'Today\'s date', 'iVBOR', 'second line of the paste']) {
    assert.ok(!all.includes(gone), `${gone} is not kept`);
  }
});

test('Claude: a stretch of the log written again, uuids and all, is read once', async () => {
  const text = await fixture('claude.jsonl');
  const lines = text.trim().split('\n');
  const again = [...lines, ...lines.slice(1, 12)].join('\n');
  assert.equal((await readClaude(again)).entries.filter(entry => entry.who === 'noah').length, 2);
  assert.deepEqual((await readClaude(again)).entries, (await readClaude(text)).entries);
});

test('Pi: a failed reply that was retried, tool calls and extension notes are dropped', async () => {
  const session = await readPi(await fixture('pi.jsonl'));
  assert.equal(session.id, PI_ID);
  assert.deepEqual(session.entries.map(({ who, text }) => [who, text]), [
    ['noah', 'why is the sound gone\n[image]'],
    ['agent', 'The headset had the sound; it plays on the speakers now.'],
    ['noah', '[spoken] thanks, that works'],
    ['agent', 'Glad it works.'],
  ]);
  assert.equal(shortId(PI_ID), '0000beef', 'a time-first id is told apart by its tail');
  assert.equal(shortId(CLAUDE_ID), 'c1a0de00');
});

// A log's bytes as a stream, in chunks of size, gzipped (and gunzipped as it
// is read) or not.
const stream = (text, size = 7, gzip = false) => {
  const bytes = gzip ? gzipSync(text) : Buffer.from(text);
  const chunks = Readable.from(Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
  return gzip ? chunks.pipe(createGunzip()) : chunks;
};

test('a log is read a line at a time: one longer than a string can be is read whole, unless a single line is that long', async () => {
  const text = await fixture('pi.jsonl');
  const longest = Math.max(...text.split('\n').map(line => Buffer.byteLength(line)));
  assert.ok(Buffer.byteLength(text) > 2 * longest, 'the whole log is longer than its longest line');
  for (const gzip of [false, true]) {
    assert.deepEqual(await readPi(stream(text, 7, gzip), longest), await readPi(text), 'streamed under a cap the whole log is over, it reads as its text does');
  }
  const said = 'ünïcödé 🌸 ok';
  assert.deepEqual(await Array.fromAsync(logLines(stream(`${said}\n\n${said}`, 3))), [said, '', said], 'a character cut between chunks is whole');
  await assert.rejects(readPi(stream(text, 64), longest - 1), new RegExp(`a line of more than ${longest - 1} bytes`), 'a line longer than the cap is the log\'s error');
  await assert.rejects(readPi(stream(`${'x'.repeat(100)}\n`, 1000), 99), /a line of more than 99 bytes/, 'a line in one chunk too');
});

test('pictures are let go as each line is read: a marker stays, the bytes never reach the transcript', async () => {
  const picture = `iVBORw0KGgo${'PICTUREBYTES'.repeat(1000)}`;
  const at = '2026-09-30T00:00:00Z';
  const pi = [
    { type: 'session', id: PI_ID, cwd: '/home/noah/imperfect', timestamp: at },
    { type: 'message', id: 'a', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'paint me a square' }, { type: 'image', data: picture, mimeType: 'image/png' }] } },
    { type: 'message', id: 'b', timestamp: at, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'k', name: 'paint', arguments: { prompt: `like data:image/png;base64,${picture}`, content: `<img src="data:image/png;base64,${picture}">` } }] } },
    { type: 'message', id: 'c', timestamp: at, message: { role: 'toolResult', toolCallId: 'k', content: [{ type: 'text', text: `saved data:image/png;base64,${picture}` }, { type: 'image', data: picture }] } },
    { type: 'message', id: 'd', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: `Here it is: data:image/png;base64,${picture}` }] } },
  ].map(line => JSON.stringify(line)).join('\n');
  const session = await readPi(stream(pi, 4096, true));
  const said = JSON.stringify(session);
  assert.ok(!said.includes('PICTUREBYTES'), said.slice(0, 2000));
  assert.deepEqual(session.entries.map(entry => entry.text), ['paint me a square\n[image]', 'Here it is: [data]']);
  const call = session.events.find(event => event.who === 'tool');
  assert.equal(call.text, `paint(prompt=like [data], content=(${picture.length + 34} chars))`, 'what was written into a file is still only measured');
  assert.equal(call.result, 'saved [data] [image]');
});

test('secrets: shaped like a key, in a URL, or a value from the credentials box', () => {
  const redact = redactor([CREDENTIAL]);
  const said = redact(`key ${SECRET}, url https://buyer:${['ic', '_', 'a'.repeat(40)].join('')}@imperfect.computer/x, header Bearer abcdefghijklmnop, aws ${['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('')}, box ${CREDENTIAL}, sudo is hunter22`);
  for (const secret of [SECRET, 'a'.repeat(40), 'abcdefghijklmnop', 'ABCDEFGHIJKLMNOP', CREDENTIAL, 'hunter22']) assert.ok(!said.includes(secret), said);
  assert.match(said, /https:\/\/\[redacted\]@imperfect\.computer/);
  assert.equal(redact('sudo is required here'), 'sudo is required here');
  const tail = 'A1b2C3d4E5f6G7h8J9k0';
  assert.equal(redact(`a tailnet key ${['tskey', 'auth', `k${tail}`, tail].join('-')} here`), 'a tailnet key [redacted] here', 'to the end of the token, not just its prefix');
  assert.equal(redact(`keys: ${['pk', 'sk', 'rk'].map(kind => `${kind}_test_51${tail}`).join('')}.`), 'keys: [redacted][redacted].', 'keys pasted end to end');
  assert.equal(redact(`a cloudflare token ${['cf', 'ut_', tail, tail].join('')} for dns`), 'a cloudflare token [redacted] for dns');
});

test('a slash command reads as it was typed; its output is dropped', async () => {
  const claude = async lines => (await readClaude(lines.map(line => JSON.stringify({ type: 'user', timestamp: '2026-09-30T00:00:00Z', message: { role: 'user', content: line } })).join('\n'))).entries.map(entry => entry.text);
  assert.deepEqual(await claude([
    '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m check the build</command-args>',
    '<local-command-stdout>Set model to opus</local-command-stdout>',
    '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
  ]), ['/loop 5m check the build', '/clear']);
});

test('gathering: raw kept, and the day made from it, stamped with the commit, secrets out', async () => {
  const w = await world();
  try {
    const result = await w.run();
    assert.equal(result.taken, 3, 'the Claude and Pi sessions and the probe; not the worker, not the one still being written');
    assert.deepEqual(await readdir(join(w.dir, 'days')), ['2026-09-30.md']);
    assert.deepEqual((await readdir(w.dir)).filter(name => name.endsWith('.md')), ['recent.md'], 'no file per session');
    const text = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.deepEqual(text.match(/^## .*$/gm), ['## 00:00–00:31 laptop claude c1a0de00', '## 01:00–01:03 laptop pi 0000beef'], 'the probe in /tmp keeps its raw copy only');
    assert.ok(text.startsWith(`# 2026-09-30\n\n## 00:00–00:31 laptop claude c1a0de00\ncwd: /home/noah/.imperfect/data/workspace\nsession: ${CLAUDE_ID}\nraw: raw/laptop/claude/${CLAUDE_ID}.jsonl.gz\ncommit: ${w.first}\nmodel: claude-opus-5-5\nmade: filter\n\n### 00:00 noah\nMake the theme picker only pictures, like this\n[image]\n\n### 00:06 agent\nThe worker finished`), text);
    assert.match(text, new RegExp(`\\n-- commit ${w.second} --\\n\\n### 00:30 noah\\n`), 'the move is marked before the turn it came before');
    assert.match(text, /\nKeep the PC as the one box\.\n\\### 09:99 agent\n\\## 00:31–00:40 laptop claude c1a0de00\n\\-- commit none --\n\n## 01:00/, 'a line that reads like the structure is escaped');
    for (const secret of [SECRET, CREDENTIAL, 'hunter22']) assert.ok(!text.includes(secret), 'redacted');
    assert.match(text, /the box token is \[redacted\] and sudo is \[redacted\]/);
    assert.match(text, new RegExp(`\\n## 01:00–01:03 laptop pi 0000beef\\n[^#]*\\ncommit: ${w.second}\\nmodel: openai-codex/gpt-6.1-sol\\nmade: filter\\n\\n### 01:00 noah\\n`));

    const raw = gunzipSync(await readFile(join(w.dir, 'raw', 'laptop', 'claude', `${CLAUDE_ID}.jsonl.gz`))).toString('utf8');
    assert.equal(raw, await readFile(w.files.claude, 'utf8'), 'the cold copy is the log itself');
    assert.ok((await stat(join(w.dir, 'raw', 'laptop', 'claude', 'b0b0b0b0-1111-4222-8333-444455556666.jsonl.gz'))).isFile());
    assert.equal((await stat(w.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(w.dir, 'days', '2026-09-30.md'))).mode & 0o777, 0o600);
    const done = JSON.parse(await readFile(join(w.dir, '.done.json'), 'utf8'));
    assert.deepEqual(Object.keys(done[`laptop:${w.files.claude}`]), ['size', 'mtime', 'raw']);
    const { logs, sessions, replays, rawBytes, memoryBytes } = (await sizes({ dir: w.dir })).computers.laptop;
    assert.deepEqual({ logs, sessions, replays }, { logs: 3, sessions: 2, replays: 0 });
    assert.ok(rawBytes > memoryBytes && memoryBytes > 0);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('calls are over: no recording is copied any more, and the ones memory kept stay as they are and are still counted', async () => {
  const w = await world();
  try {
    // A recording left on this computer from when there were calls.
    const calls = join(w.prefix, 'data', 'state', 'calls');
    await mkdir(calls, { recursive: true });
    const sound = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x80, 0x42]);
    const left = join(calls, '2026-09-30T00-10-00.webm');
    await writeFile(left, sound);
    await writeFile(join(calls, '2026-09-30T00-10-00.jsonl'), '{"t":0,"type":"call.started"}\n');
    await utimes(left, at('2026-09-30T02:00:00Z'), at('2026-09-30T02:00:00Z'));
    // And one memory already took, with its line in .done.json.
    const kept = join(w.dir, 'raw', 'laptop', 'calls', '2026-09-29T20-00-00.webm');
    await mkdir(dirname(kept), { recursive: true });
    await writeFile(kept, sound);
    await writeFile(join(w.dir, '.done.json'), JSON.stringify({ 'laptop:/old/data/state/calls/2026-09-29T20-00-00.webm': { size: sound.length, mtime: 1, raw: 'raw/laptop/calls/2026-09-29T20-00-00.webm' } }));
    const result = await w.run();
    assert.equal(result.taken, 3, 'the three logs, and no recording');
    assert.deepEqual(await readdir(dirname(kept)), ['2026-09-29T20-00-00.webm'], 'nothing new beside what was kept');
    assert.deepEqual(await readFile(kept), sound, 'what was kept, byte for byte');
    assert.deepEqual(await readFile(left), sound, 'the recording on the computer is not touched');
    const { logs, calls: recorded, callBytes } = (await sizes({ dir: w.dir })).computers.laptop;
    assert.deepEqual({ logs, recorded, callBytes }, { logs: 3, recorded: 1, callBytes: sound.length });
    assert.deepEqual((await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8')).match(/^## .*$/gm), ['## 00:00–00:31 laptop claude c1a0de00', '## 01:00–01:03 laptop pi 0000beef'], 'the days are the sessions');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a session is taken once, again when it was resumed, and one still being written waits', async () => {
  const w = await world();
  try {
    const day = join(w.dir, 'days', '2026-09-30.md');
    await w.run();
    const before = await readFile(day, 'utf8');
    assert.equal((await w.run()).taken, 0, 'nothing changed');
    assert.equal(await readFile(day, 'utf8'), before);
    await appendFile(w.files.pi, `${JSON.stringify({ type: 'message', id: 'e11', parentId: 'e10', timestamp: '2026-09-30T02:10:00.000Z', message: { role: 'user', content: 'one more thing: louder', timestamp: 0 } })}\n${JSON.stringify({ type: 'message', id: 'e12', parentId: 'e11', timestamp: '2026-09-30T02:11:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Louder now.' }], stopReason: 'stop', timestamp: 0 } })}\n`);
    await utimes(w.files.pi, at('2026-09-30T02:11:00Z'), at('2026-09-30T02:11:00Z'));
    assert.equal((await w.run()).taken, 1, 'the resumed one again, the busy one still waiting');
    const after = await readFile(day, 'utf8');
    assert.ok(after.startsWith(before.split('\n## 01:00')[0]));
    assert.match(after, /\n## 01:00–02:11 laptop pi 0000beef\n/);
    assert.match(after, /\n### 02:10 noah\none more thing: louder\n\n### 02:11 agent\nLouder now\.\n$/);
    assert.equal((await w.run(Date.parse('2026-09-30T04:00:00Z'))).taken, 1, 'the busy one, once it has been still for half an hour');
    assert.match(await readFile(day, 'utf8'), /\nSTILL TALKING/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('every run makes the days again from raw/ and the kept reflog alone', async () => {
  const w = await world();
  try {
    const day = join(w.dir, 'days', '2026-09-30.md');
    await w.run();
    const before = await readFile(day, 'utf8');
    await rm(join(w.home, '.claude'), { recursive: true });
    await rm(join(w.home, 'imperfect'), { recursive: true });
    await writeFile(day, 'scribbled over');
    await writeFile(join(w.dir, 'days', '2001-01-01.md'), 'a day from an older filter');
    assert.equal((await w.run()).taken, 0);
    assert.deepEqual(await readdir(join(w.dir, 'days')), ['2026-09-30.md']);
    assert.equal(await readFile(day, 'utf8'), before, 'the same day, commit stamps and all');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('days: a session is split at midnight, a day in the order of first turns, a replay only its heading', async () => {
  const w = await world();
  try {
    const late = 'aa000000-1111-4222-8333-444455556666';
    await addLog(w, late, [
      ['2026-09-29T23:50:00Z', 'noah', 'start the overnight render of the film'],
      ['2026-09-29T23:52:00Z', 'agent', 'Started the render.'],
      ['2026-09-29T23:59:00Z', 'noah', 'tell me when the render finishes'],
      ['2026-09-30T00:10:00Z', 'agent', 'The render finished just after midnight.'],
    ]);
    const probe = "what's trending on X about Opus 5.5 this week?";
    await addLog(w, 'bb000000-1111-4222-8333-444455556666', [['2026-09-30T02:00:00Z', 'noah', probe], ['2026-09-30T02:01:00Z', 'agent', 'Outliers, first try.']]);
    await addLog(w, 'cc000000-1111-4222-8333-444455556666', [['2026-09-30T02:05:00Z', 'noah', probe], ['2026-09-30T02:05:30Z', 'agent', 'Outliers, second try.'], ['2026-09-30T02:06:00Z', 'noah', 'yes'], ['2026-09-30T02:06:30Z', 'agent', 'Posted.']]);
    await addLog(w, 'dd000000-1111-4222-8333-444455556666', [['2026-09-30T02:10:00Z', 'noah', probe], ['2026-09-30T02:11:00Z', 'agent', 'Outliers, third try.'], ['2026-09-30T02:12:00Z', 'noah', 'now chart the top five of them']]);
    const result = await w.run();
    assert.deepEqual([result.days, result.sessions, result.replays], [2, 6, 1]);
    assert.equal(await readFile(join(w.dir, 'days', '2026-09-29.md'), 'utf8'),
      `# 2026-09-29\n\n## 23:50–23:59 laptop claude aa000000\ncwd: /home/noah/.imperfect/data/workspace\nsession: ${late}\nraw: raw/laptop/claude/${late}.jsonl.gz\ncommit: ${w.first}\nmodel: claude-opus-5-5\nmade: filter\n\n### 23:50 noah\nstart the overnight render of the film\n\n### 23:52 agent\nStarted the render.\n\n### 23:59 noah\ntell me when the render finishes\n`);
    const day = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.deepEqual(day.match(/^## .*$/gm), [
      '## 00:00–00:31 laptop claude c1a0de00',
      '## 00:10–00:10 laptop claude aa000000',
      '## 01:00–01:03 laptop pi 0000beef',
      '## 02:00–02:01 laptop claude bb000000',
      '## 02:05–02:06 laptop claude cc000000 · replay of bb000000 (02:00)',
      '## 02:10–02:12 laptop claude dd000000',
    ], 'the late session sits by its first turn that day, not by when it began');
    assert.match(day, /\n## 00:10–00:10 laptop claude aa000000\n[^#]*\ncontinues from 2026-09-29\n\n### 00:10 agent\nThe render finished just after midnight\.\n\n## 01:00/);
    assert.match(day, /\n## 02:05–02:06 laptop claude cc000000 · replay of bb000000 \(02:00\)\n\n## 02:10/, 'a replay has no body: "yes" is not distinctive');
    assert.ok(!day.includes('second try'));
    assert.match(day, /third try/, 'something new said keeps a session its own');

    const [hit] = await search('render finishes', { dir: w.dir, repo: w.repo });
    assert.equal(hit.time, '2026-09-29T23:59+00:00');
    assert.deepEqual(hit.neighbour, { who: 'agent', time: '2026-09-30T00:10+00:00', text: 'The render finished just after midnight.' }, 'the answer after midnight, from the next day');
    assert.equal(hit.path, join(w.dir, 'days', '2026-09-29.md'));
    assert.deepEqual((await search('trending', { dir: w.dir, repo: w.repo })).map(hit => hit.session), ['dd000000', 'bb000000'], 'a replay is not searched');
    assert.equal((await sizes({ dir: w.dir })).computers.laptop.replays, 1);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test("recent.md: Noah's words from the last 48 hours, newest first, a line each, the replies and replays left out", async () => {
  const w = await world();
  try {
    await addLog(w, 'ee000000-1111-4222-8333-444455556666', [['2026-09-27T12:00:00Z', 'noah', 'something from three days ago'], ['2026-09-27T12:01:00Z', 'agent', 'Old.']]);
    await addLog(w, 'aa000000-1111-4222-8333-444455556666', [
      ['2026-09-29T23:50:00Z', 'noah', 'start the overnight render of the film'],
      ['2026-09-29T23:59:00Z', 'noah', 'tell me when the render finishes'],
      ['2026-09-30T00:10:00Z', 'agent', 'The render finished just after midnight.'],
    ]);
    const probe = "what's trending on X about Opus 5.5 this week?";
    await addLog(w, 'bb000000-1111-4222-8333-444455556666', [['2026-09-30T02:00:00Z', 'noah', probe], ['2026-09-30T02:01:00Z', 'agent', 'Outliers, first try.']]);
    await addLog(w, 'cc000000-1111-4222-8333-444455556666', [['2026-09-30T02:05:00Z', 'noah', probe], ['2026-09-30T02:05:30Z', 'agent', 'Outliers, second try.']]);
    const longer = `make the film\n\nlonger, ${'and longer '.repeat(70)}`;
    await addLog(w, 'ff000000-1111-4222-8333-444455556666', [['2026-09-30T02:20:00Z', 'noah', longer], ['2026-09-30T02:21:00Z', 'agent', 'Made it longer.'], ['2026-09-30T02:22:00Z', 'noah', `and ${longer}`]]);
    const result = await w.run();
    const path = join(w.dir, 'recent.md'), text = await readFile(path, 'utf8');
    assert.equal(result.recentBytes, Buffer.byteLength(text));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(text.startsWith('# recent: what happened in the last 48 hours, newest first (made 2026-09-30 03:00)\n\n'), text);
    assert.ok(text.includes(`${w.dir}/days/YYYY-MM-DD.md, and the recall tool searches it.`), 'it says where the whole record is');
    assert.ok(!text.includes('Left out'), 'everything fits');
    assert.deepEqual(text.match(/^#{2,3} .*$/gm), [
      '## 2026-09-30',
      '### 02:20–02:22 laptop claude ff000000 · ~/.imperfect/data/workspace',
      '### 02:00–02:01 laptop claude bb000000 · ~/.imperfect/data/workspace',
      '### 01:00–01:03 laptop pi 0000beef · ~/.imperfect/data/workspace',
      '### 00:00–00:31 laptop claude c1a0de00 · ~/.imperfect/data/workspace',
      '## 2026-09-29',
      '### 23:50–23:59 laptop claude aa000000 · ~/.imperfect/data/workspace',
    ], 'most recently active first, by day, headed as in the day file; not the replay, not the reply after midnight, not three days ago');
    assert.match(text, /\n### 00:00–00:31 laptop claude c1a0de00 · [^\n]*\n- 00:00 Make the theme picker only pictures, like this \[image\]\n- 00:30 \[pasted text: Handoff notes from the laptop\] what do you think\? the box token is \[redacted\] and sudo is \[redacted\]\n\n## 2026-09-29\n/);
    assert.match(text, /\n- 23:50 start the overnight render of the film\n- 23:59 tell me when the render finishes\n$/);
    const said = text.split('\n').filter(line => / 02:2\d /.test(line)), line = `make the film longer, ${'and longer '.repeat(70)}`;
    assert.deepEqual(said, [`- 02:20 ${line.slice(0, 600)}…`, `- 02:22 ${`and ${line}`.slice(0, 200)}…`], 'one line, cut to its first 200 characters; the first, which sets the session going, to 600');
    for (const gone of ['worker finished', 'Outliers', 'render finished', 'Made it longer', 'three days ago', CREDENTIAL]) assert.ok(!text.includes(gone), gone);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('recent.md stays under 24 KB: the oldest sessions are left out whole, and the top says how much', async () => {
  const words = n => `${n} ${'all of this is what Noah said '.repeat(10)}`;
  const w = await world();
  try {
    for (let i = 0; i < 60; i++) {
      const at = new Date(Date.parse('2026-09-29T04:00:00Z') + i * 20 * 60_000).toISOString();
      await addLog(w, `${String(i).padStart(4, '0')}0000-1111-4222-8333-444455556666`, [0, 1].map(j => [at.replace(/:00\.000Z$/, `:0${j}.000Z`), 'noah', words(`${i}.${j}`)]));
    }
    const result = await w.run();
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.ok(result.recentBytes <= RECENT_BYTES && result.recentBytes > RECENT_BYTES - 1024, String(result.recentBytes));
    const kept = text.match(/^### .*$/gm);
    assert.equal(kept[0], '### 01:00–01:03 laptop pi 0000beef · ~/.imperfect/data/workspace', 'the newest is kept');
    const left = 62 - kept.length;
    assert.match(text, new RegExp(`\\nLeft out to keep this short: ${left} older sessions \\(${left * 2} lines\\), back to 2026-09-29 04:00\\. They are in days/\\.\\n`));
    const heading = i => `### ${localTime(Date.parse('2026-09-29T04:00:00Z') + i * 20 * 60_000).slice(11, 16).replace(/.*/, '$&–$&')} laptop claude ${String(i).padStart(4, '0')}0000 · ~/.imperfect/data/workspace`;
    assert.deepEqual(kept.slice(2), Array.from({ length: kept.length - 2 }, (_, k) => heading(59 - k)), 'the oldest went first');
  } finally { await rm(w.home, { recursive: true, force: true }); }

  const v = await world();
  try { // the newest session alone is over: its first messages go
    await addLog(v, 'ab000000-1111-4222-8333-444455556666', Array.from({ length: 200 }, (_, i) => [new Date(Date.parse('2026-09-30T01:05:00Z') + i * 30_000).toISOString(), 'noah', words(i)]));
    const result = await v.run();
    const text = await readFile(join(v.dir, 'recent.md'), 'utf8');
    assert.ok(result.recentBytes <= RECENT_BYTES);
    assert.deepEqual(text.match(/^### .*$/gm), ['### 01:05–02:44 laptop claude ab000000 · ~/.imperfect/data/workspace']);
    const cut = 200 - text.split('\n').filter(line => line.startsWith('- ')).length;
    assert.ok(cut > 0);
    assert.match(text, new RegExp(`\\nLeft out to keep this short: 2 older sessions \\(4 lines\\), back to 2026-09-30 00:00\\. They are in days/\\.\\n\\nLeft out of the newest session: its first ${cut} lines\\.\\n`));
    assert.match(text, /\n- 02:44 199 all of this[^\n]*\n$/, 'the last message is kept');
  } finally { await rm(v.home, { recursive: true, force: true }); }
});

test('a log is streamed into raw/, never held: one cut off is not kept, and is taken whole next run', async () => {
  const w = await world();
  try {
    const real = here({ ...process.env, HOME: w.home }), into = [], said = [];
    let broken = true;
    const run = (command, file) => {
      if (!command.startsWith('gzip ')) return real(command);
      into.push(file);
      return real(broken ? `${command} | head -c 100; exit 3` : command, file);
    };
    const pass = () => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: [{ name: 'laptop', run }], now: NOW, log: line => said.push(line) });
    assert.equal((await pass()).taken, 0);
    assert.equal(said.length, 3, said.join('\n'));
    assert.ok(into.length && into.every(file => file.endsWith('.part')), 'each written into a file as it comes');
    const left = await readdir(join(w.dir, 'raw'), { recursive: true });
    assert.deepEqual(left.filter(name => /\.(gz|part)$/.test(name)), [], 'nothing cut off is kept');
    broken = false;
    assert.equal((await pass()).taken, 3);
    assert.equal(gunzipSync(await readFile(join(w.dir, 'raw', 'laptop', 'pi', `${basename(w.files.pi)}.gz`))).toString('utf8'), await readFile(w.files.pi, 'utf8'));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a computer that does not answer is skipped and caught up next run', async () => {
  const w = await world();
  try {
    const said = [];
    const result = await gather({ prefix: w.prefix, dir: w.dir, now: NOW, log: line => said.push(line), from: [{ name: 'away', run: async () => { throw new Error('ssh: connect timed out'); } }] });
    assert.equal(result.taken, 0);
    assert.match(said[0], /^away: not reachable/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('search: Noah first, newest first, with the neighbour and the commit; recall reaches the PC', async () => {
  const w = await world();
  let server;
  try {
    await w.run();
    const hits = await search('picker', { dir: w.dir, repo: w.repo });
    assert.deepEqual(hits.map(hit => hit.who), ['noah', 'agent']);
    assert.equal(hits[0].text, 'Make the theme picker only pictures, like this\n[image]');
    assert.match(hits[0].neighbour.text, /^The worker finished/);
    assert.equal(hits[0].time, '2026-09-30T00:00+00:00');
    assert.deepEqual([hits[0].computer, hits[0].harness, hits[0].session], ['laptop', 'claude', 'c1a0de00']);
    assert.equal(hits[0].path, join(w.dir, 'days', '2026-09-30.md'));
    assert.equal(hits[0].commit, w.first);
    assert.equal(hits[0].ancestor, true);
    assert.equal(hits[1].neighbour.who, 'noah', 'an answer brings its question');

    const the = await search('the', { dir: w.dir, repo: w.repo });
    assert.deepEqual(the.filter(hit => hit.who === 'noah').map(hit => `${hit.harness} ${hit.time.slice(11, 16)}`), ['pi 01:00', 'claude 00:30', 'claude 00:00'], 'newest first');
    assert.equal(the.findIndex(hit => hit.who === 'agent'), the.filter(hit => hit.who === 'noah').length, "Noah's lines rank first");
    assert.equal((await search('"one box"', { dir: w.dir, repo: w.repo }))[0].commit, w.second);
    assert.equal((await search('"### 09:99 agent"', { dir: w.dir, repo: w.repo }))[0].who, 'agent', 'an escaped line reads as it was said');
    assert.deepEqual(await search('nothing-like-this', { dir: w.dir }), []);

    // Another computer asks the PC.
    const route = createMemoryRoute({ dir: w.dir });
    server = createServer(async (req, res) => { if (!await route(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    const answer = await runRecall({ query: 'picker' }, { locate: async () => url });
    assert.match(answer, /^2 things said holding "picker"/);
    assert.match(answer, /1\. noah, 2026-09-30 00:00 on laptop \(claude c1a0de00\), commit [0-9a-f]{12}/);
    assert.match(answer, /\/days\/2026-09-30\.md\n/);
    assert.match(answer, /noah 00:00: Make the theme picker/);
    assert.match(answer, /agent 00:06: The worker finished/);
    const refused = await fetch(`${url}/memory`, { method: 'POST', body: '{"query":"picker"}' });
    assert.equal(refused.status, 403, 'an exact origin is required');
    await assert.rejects(runRecall({ query: 'picker' }, { locate: async () => '' }), /cannot reach it/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(w.home, { recursive: true, force: true });
  }
});

test('memory lives on the authority, or here when this computer follows none', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'memory-home-'));
  try {
    const status = id => async () => (id ? { Self: { ID: id, DNSName: 'desk.example.ts.net.' } } : null);
    assert.equal(await memoryHome(prefix, status('')), 0, 'no machine.json: this computer is its own');
    await writeFile(join(prefix, 'machine.json'), JSON.stringify({ authority: { id: 'pcNODE1', name: 'desktop' } }));
    assert.equal(await memoryHome(prefix, status('pcNODE1')), 0);
    assert.equal(await memoryHome(prefix, status('laptopNODE2')), 1);
    assert.equal(await memoryHome(prefix, status('')), 2, 'no tailnet answer: cannot tell');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

// The model, played by a function: each piece answered with a summary and a
// turn each for Noah, Vaita and the agent at the stretch's first minute; the
// list of what is open (asked with its own prompt) by open.
function model(answer = from => `summary:\n- what happened from ${from}\n\n### ${from} noah\nhis words from ${from}\n\n### ${from} vaita\nVaita said hello\n\n### ${from} agent\nThe agent did it.\n`, open = () => 'none') {
  const asked = [], opened = [];
  const ask = async (input, prompt) => {
    if (prompt?.endsWith('memory-open-prompt.md')) { opened.push(input); return open(input); }
    asked.push(input);
    return answer(/^This stretch: \S+, (\d\d:\d\d)–/m.exec(input)[1], input);
  };
  return { asked, opened, ask };
}

test('the model writes the entries: an episode at a time, a summary and the turns, from a transcript with the tool calls, asked once', async () => {
  const w = await world();
  try {
    const { asked, ask } = model();
    const result = await w.run(NOW, ask);
    assert.deepEqual([result.pieces, result.derived, result.derivedNow, result.waiting], [3, 3, 3, 0], 'the Claude session is two episodes: it went quiet for 24 minutes after the agent answered');
    assert.equal(asked.length, 3);
    assert.match(asked[0], /This stretch: 2026-09-30, 01:00/, 'newest first');
    const claude = asked.find(input => input.includes(CLAUDE_ID) && input.includes('This stretch: 2026-09-30, 00:00'));
    assert.match(claude, /^Known projects \(name and where\): imperfect \(~\/imperfect\)\.\n\nSession c1a0de00-[^\n]* on laptop, harness claude, in \/home\/noah\/\.imperfect\/data\/workspace; the agent's model: claude-opus-5-5\.\nThis stretch: 2026-09-30, 00:00–00:06, local time\.\nProjects its paths point to: none\.\n\nTranscript:\n/);
    assert.match(asked.find(input => input.includes(CLAUDE_ID) && input.includes('This stretch: 2026-09-30, 00:30')), /\nEarlier in this session, Noah said \(context only\):\n- 2026-09-30 00:00 Make the theme picker/, 'the next episode has the first as context');
    assert.match(claude, /\n\[00:00\] NOAH:\nMake the theme picker only pictures, like this\n\[image\]\n/);
    assert.match(claude, /\n\[00:00\] · Bash\(command=[^\n]*\)\n {4}→ /, 'a tool call is a line, its result cut short beneath');
    assert.match(claude, /\n\[00:05\] \(note\) /, 'a worker finishing is a note');
    for (const secret of [SECRET, CREDENTIAL, 'hunter22']) assert.ok(!asked.join('').includes(secret), 'redacted before it goes to the model');

    const text = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.ok(text.includes(`commit: ${w.first}\nmodel: claude-opus-5-5\nmade: gpt-6.1-sol high\n\nsummary:\n- what happened from 00:00\n- what happened from 00:30\n\n### 00:00 noah\nhis words from 00:00\n\n### 00:00 vaita\nVaita said hello\n\n### 00:00 agent\nThe agent did it.\n`), text);
    assert.ok(!text.includes('Make the theme picker'), "the model's turns, not the filter's");
    const recent = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.match(recent, /\n### 00:00–00:31 laptop claude c1a0de00 · [^\n]*\n- what happened from 00:00\n/, 'recent.md has the summary');
    const [hit] = await search('Vaita said hello', { dir: w.dir, repo: w.repo });
    assert.equal(hit.who, 'vaita');

    assert.equal((await w.run(NOW, ask)).derivedNow, 0);
    assert.equal(asked.length, 3, 'an answer is kept: nothing is asked twice');
    assert.equal(await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8'), text);
    assert.equal((await readdir(join(w.dir, 'derived'))).length, 3);
    assert.ok((await w.run()).derived === 3, 'a run without the model still uses its answers');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test("when Pi cannot answer the filter's entry stands; an unusable answer is tried three times", async () => {
  const w = await world();
  try {
    const down = model(() => { throw new Error('pi: not signed in'); });
    assert.equal((await w.run(NOW, down.ask)).derived, 0);
    assert.match(await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8'), /\nmade: filter\n\n### 00:00 noah\nMake the theme picker/);
    assert.deepEqual(await readdir(join(w.dir, 'derived')), [], 'Pi being down is not the piece\'s fault');
    const garbled = model(() => 'I could not do this.');
    for (let i = 0; i < 4; i++) await w.run(NOW, garbled.ask);
    assert.equal(garbled.asked.length, 9, 'each episode three times, then left to the filter');
    assert.equal((await w.run(NOW, model().ask)).derivedNow, 0);
    const lost = { from: Date.parse('2026-09-30T01:00:00Z'), to: Date.parse('2026-09-30T01:03:00Z') };
    assert.throws(() => parseAnswer('summary:\n- x\n\n### 05:00 agent\nlost its place', lost), error => error.answer === true);
    assert.equal(parseAnswer('summary:\n- x\n\n### 01:04 agent\na minute late is fine', lost).turns[0].time, '01:04');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a secret the model reports is redacted from then on everywhere, the filter too, and kept only as a hash; a plain word is not taken', async () => {
  const w = await world();
  const secret = ['IG', 'pass-', 'w0rd9'].join('');
  try {
    await addLog(w, 'ab000000-1111-4222-8333-444455556666', [['2026-09-30T02:00:00Z', 'noah', `log in as locusrifle with ${secret} please`], ['2026-09-30T02:01:00Z', 'agent', 'Logged in.']]);
    const { asked, ask } = model((from, input) => {
      if (input.includes('log in as')) throw new Error('pi: busy');
      return `summary:\n- signed in\n\n### ${from} noah\nthe password is [redacted]\n\n### ${from} agent\nSigned in.\n\n=== secrets\n${secret}\nlocusrifle\n`;
    });
    await w.run(NOW, ask);
    const day = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8'), recent = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.match(day, /\nmade: filter\n\n### 02:00 noah\nlog in as locusrifle with \[redacted\] please\n/, "the filter's entry of another session");
    assert.match(recent, /- 02:00 log in as locusrifle with \[redacted\] please/);
    assert.ok(!day.includes('=== secrets') && !day.includes(secret) && !recent.includes(secret));
    const kept = await readFile(join(w.dir, '.secrets'), 'utf8');
    assert.equal(kept, `${createHash('sha256').update(secret).digest('hex')}\n`);
    const again = model();
    await rm(join(w.dir, 'derived'), { recursive: true });
    await w.run(NOW, again.ask);
    assert.ok(again.asked.some(input => input.includes('log in as locusrifle with [redacted] please')) && !again.asked.join('').includes(secret), 'nor does it go to the model again');
    assert.ok(asked.length >= 2);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a resumed session goes to the model again only for its new episode; a long one is cut where Noah speaks', async () => {
  const w = await world();
  try {
    const id = 'ac000000-1111-4222-8333-444455556666';
    const turn = (n, minute) => [[`2026-09-30T02:${minute}:00Z`, 'noah', `step ${n}`], ...Array.from({ length: 8 }, (_, i) => [`2026-09-30T02:${minute}:${String(i + 1).padStart(2, '0')}Z`, 'agent', `${n}.${i} ${'busy work '.repeat(700)}`])];
    await addLog(w, id, [...turn(1, 10), ...turn(2, 11), ...turn(3, 12)]);
    const { asked, ask } = model();
    const first = await w.run(NOW, ask);
    assert.equal(first.pieces, 6, 'the long session is three episodes, cut where Noah speaks: more than the model reads at once');
    await addLog(w, id, [...turn(1, 10), ...turn(2, 11), ...turn(3, 12), ...turn(4, 13)]);
    const second = await w.run(NOW, ask);
    assert.deepEqual([second.taken, second.pieces, second.derivedNow], [1, 7, 1], 'only the new episode');
    assert.equal(asked.length, 7);
    assert.equal((await readdir(join(w.dir, 'derived'))).length, 7);
    const text = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.match(text, /\n## 02:10–02:13 laptop claude ac000000\n[^#]*made: gpt-6\.1-sol high\n\nsummary:\n- what happened from 02:10\n- what happened from 02:11\n- what happened from 02:12\n- what happened from 02:13\n/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('secrets: a password said the other way round, and one the model learned', () => {
  const redact = redactor([], new Set([createHash('sha256').update('Zz9-learned').digest('hex')]));
  assert.equal(redact('locusrifle is the username trAWup-x5Q is the password'), 'locusrifle is the username [redacted] is the password');
  assert.equal(redact('what is the password'), 'what is the password');
  assert.equal(redact('it was Zz9-learned. Then Zz9-learnedly'), 'it was [redacted]. Then Zz9-learnedly');
});

test("a log on this computer still being written is read where it is: in the days at once, never copied, and the model waits for its last episode", async () => {
  const w = await world();
  try {
    const { asked, ask } = model();
    const local = [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }), local: true }];
    const result = await gather({ prefix: w.prefix, dir: w.dir, from: local, now: NOW, log: () => {}, ask });
    assert.deepEqual([result.taken, result.live], [3, 1], 'the finished logs copied, the busy one read in place');
    assert.ok(!(await readdir(join(w.dir, 'raw', 'laptop', 'claude'))).some(name => name.startsWith('d0d0d0d0')), 'not copied while it is written');
    assert.ok(!Object.keys(JSON.parse(await readFile(join(w.dir, '.done.json'), 'utf8'))).some(key => key.includes('d0d0d0d0')));
    const day = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.match(day, new RegExp(`\\nraw: ${w.files.busy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(being written\\)\\n[^#]*made: gpt-6\\.1-sol high, and the filter for 00:30–00:31\\n`));
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /\n### 00:00–00:31 laptop claude c1a0de00 · ~\/\.imperfect\/data\/workspace · still being written\n- what happened from 00:00\n- 00:30 \[pasted text/, 'the episode that ended as the model wrote it, the one going on as the filter does');
    assert.equal(asked.length, 4, "the finished sessions' three episodes, and the first of the one being written, which has ended; its last waits");
    assert.ok(asked.some(input => input.includes('STILL TALKING')) && !asked.some(input => input.includes('d0d0d0d0') && input.includes('This stretch: 2026-09-30, 00:30')));
    const later = Date.parse('2026-09-30T04:00:00Z');
    const still = await gather({ prefix: w.prefix, dir: w.dir, from: local, now: later, log: () => {}, ask });
    assert.deepEqual([still.taken, still.live, asked.length], [1, 0, 5], 'once still it is copied, and its last episode goes to the model; the first is not asked again');
    assert.match(await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8'), /\nraw: raw\/laptop\/claude\/d0d0d0d0-[^\n]*\.jsonl\.gz\n/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a log of large pictures, copied into raw/ and read where it is being written, reaches neither the days nor the model as bytes', async () => {
  const w = await world();
  try {
    const picture = `iVBORw0KGgo${'PICTUREBYTES'.repeat(200_000)}`;
    const log = (id, minute) => [
      { type: 'session', id, cwd: '/home/noah/imperfect', timestamp: `2026-09-30T01:${minute}:00Z` },
      ...[`paint me a pink square at ${minute}`, `and a purple one at ${minute}`].flatMap((words, i) => [
        { type: 'message', id: `u${i}`, timestamp: `2026-09-30T01:${minute}:0${i}Z`, message: { role: 'user', content: [{ type: 'text', text: words }, { type: 'image', data: picture }] } },
        { type: 'message', id: `c${i}`, timestamp: `2026-09-30T01:${minute}:1${i}Z`, message: { role: 'assistant', content: [{ type: 'toolCall', id: `k${i}`, name: 'paint', arguments: { prompt: words } }] } },
        { type: 'message', id: `r${i}`, timestamp: `2026-09-30T01:${minute}:2${i}Z`, message: { role: 'toolResult', toolCallId: `k${i}`, content: [{ type: 'image', data: picture }, { type: 'text', text: `data:image/png;base64,${picture}` }] } },
        { type: 'message', id: `a${i}`, timestamp: `2026-09-30T01:${minute}:3${i}Z`, message: { role: 'assistant', content: [{ type: 'text', text: `Painted: ![square](data:image/png;base64,${picture})` }] } },
      ]),
    ].map(line => JSON.stringify(line)).join('\n');
    const sessions = join(w.prefix, 'data', 'state', 'sessions');
    const still = join(sessions, '2026-09-30T01-10-00-000Z_01a0cccc-0000-7000-8000-00000000beef.jsonl');
    const busy = join(sessions, '2026-09-30T01-20-00-000Z_01a0dddd-0000-7000-8000-00000000beef.jsonl');
    await writeFile(still, log('01a0cccc-0000-7000-8000-00000000beef', 10));
    await writeFile(busy, log('01a0dddd-0000-7000-8000-00000000beef', 20));
    assert.ok((await stat(still)).size > 10 * 2 ** 20, 'pictures of megabytes, a line each');
    await utimes(still, at('2026-09-30T02:00:00Z'), at('2026-09-30T02:00:00Z'));
    await utimes(busy, at('2026-09-30T02:45:00Z'), at('2026-09-30T02:45:00Z'));
    const { asked, ask } = model(from => `summary:\n- painted from ${from}\n\n### ${from} noah\npaint\n`);
    const said = [];
    const local = [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }), local: true }];
    const result = await gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: local, now: NOW, log: line => said.push(line), ask });
    assert.deepEqual(said, [], 'every log read');
    assert.equal(result.live, 2, 'the busy picture log and the busy Claude one, read where they are');
    const raw = join(w.dir, 'raw', 'laptop', 'pi', `${basename(still)}.gz`);
    assert.equal(gunzipSync(await readFile(raw)).toString('utf8'), await readFile(still, 'utf8'), 'copied into raw/ whole');
    const painted = asked.filter(input => input.includes('paint me a pink square'));
    assert.equal(painted.length, 2, 'both picture sessions went to the model');
    for (const input of painted) assert.match(input, /\[image\][\s\S]*· paint\(prompt=paint me a pink square at \d\d\)\n {4}→ \[image\] \[data\][\s\S]*AGENT: Painted: !\[square\]\(\[data\]\)/);
    const written = [...asked, await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8'), await readFile(join(w.dir, 'recent.md'), 'utf8')].join('\n');
    assert.ok(!written.includes('PICTUREBYTES'), 'no picture bytes, to the model or in memory');
    assert.match(written, /made: gpt-6\.1-sol high\n/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a fresh pass reads only the logs written to since a day, and makes again only the days from then on', async () => {
  const w = await world();
  try {
    const old = 'ee000000-1111-4222-8333-444455556666';
    await addLog(w, old, [['2026-09-27T12:00:00Z', 'noah', 'something from three days ago'], ['2026-09-27T12:01:00Z', 'agent', 'Old.']]);
    const file = join(w.home, '.claude', 'projects', '-home-noah--imperfect-data-workspace', `${old}.jsonl`);
    await utimes(file, at('2026-09-27T12:01:00Z'), at('2026-09-27T12:01:00Z'));
    await w.run();
    assert.deepEqual(await readdir(join(w.dir, 'days')), ['2026-09-27.md', '2026-09-30.md']);
    for (const name of ['2026-09-27.md', '2026-09-30.md']) await writeFile(join(w.dir, 'days', name), 'scribbled over');
    const fresh = await gather({ prefix: w.prefix, dir: w.dir, from: [], now: NOW, since: Date.parse('2026-09-28T00:00:00Z'), log: () => {} });
    assert.equal(fresh.sessions, 2, 'not the session from three days ago');
    assert.equal(await readFile(join(w.dir, 'days', '2026-09-27.md'), 'utf8'), 'scribbled over', 'a day before since stands as it was');
    assert.match(await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8'), /^# 2026-09-30\n\n## 00:00–00:31 laptop claude c1a0de00\n/);
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /\n### 01:00–01:03 laptop pi 0000beef /);
    await w.run();
    assert.match(await readFile(join(w.dir, 'days', '2026-09-27.md'), 'utf8'), /something from three days ago/, 'a whole pass makes every day again');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('what is open: the model lists it atop recent.md from recent.md and its last list, is asked again only when that changed, and a list that is not one leaves the last', async () => {
  const w = await world();
  const said = [];
  try {
    let list = '- 2026-09-30 c1a0de00: Noah to choose the picker\'s colours\n- 2026-09-30 0000beef: try the headset again';
    const { opened, ask } = model(undefined, () => list);
    await gather({ prefix: w.prefix, dir: w.dir, from: [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }) }], now: NOW, log: line => said.push(line), ask });
    const recent = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.match(recent, /\n\n## Open \(listed 2026-09-30 03:00\)\n\n- 2026-09-30 c1a0de00: Noah to choose the picker's colours\n- 2026-09-30 0000beef: try the headset again\n\n## 2026-09-30\n/);
    assert.equal(opened.length, 1);
    assert.ok(!opened[0].startsWith('# recent') && opened[0].includes('### 00:00–00:31 laptop claude c1a0de00'), 'recent.md as an agent reads it, but for when it was made');
    await w.run(NOW, ask);
    assert.equal(opened.length, 1, 'nothing changed: not asked again');
    await addLog(w, 'ab000000-1111-4222-8333-444455556666', [['2026-09-30T02:30:00Z', 'noah', 'the headset works now'], ['2026-09-30T02:31:00Z', 'agent', 'Good.']]);
    list = '- 2026-09-30 c1a0de00: Noah to choose the picker\'s colours';
    await w.run(NOW + 60_000, ask);
    assert.equal(opened.length, 1, 'a new episode, but the list was written less than half an hour ago');
    await w.run(NOW + 31 * 60_000, ask);
    assert.equal(opened.length, 2);
    assert.match(opened[1], /\n## Open \(listed 2026-09-30 03:00\)\n\n- 2026-09-30 c1a0de00: [^\n]*\n- 2026-09-30 0000beef: try the headset again\n/, 'its last list, at the top');
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /\n## Open \(listed 2026-09-30 03:31\)\n\n- 2026-09-30 c1a0de00: [^\n]*\n\n## /);
    list = 'I could not tell.';
    await addLog(w, 'ac000000-1111-4222-8333-444455556666', [['2026-09-30T02:40:00Z', 'noah', 'one more thing'], ['2026-09-30T02:41:00Z', 'agent', 'Done.']]);
    await gather({ prefix: w.prefix, dir: w.dir, from: [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }) }], now: NOW + 62 * 60_000, log: line => said.push(line), ask });
    assert.equal(opened.length, 3);
    assert.ok(said.includes('open: the answer is not a list'));
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /\n## Open \(listed 2026-09-30 03:31\)\n\n- 2026-09-30 c1a0de00: /, 'the last list stands, in a pass without the model too');
    assert.deepEqual(parseOpen('none'), []);
    assert.deepEqual(parseOpen('Open:\n- 2026-09-30 c1a0de00: a\n'), ['- 2026-09-30 c1a0de00: a'], 'what is not an item is left out');
    assert.equal(parseOpen(Array.from({ length: 40 }, (_, i) => `- 2026-09-30 c1a0de00: item ${i} ${'x'.repeat(60)}`).join('\n')).join('\n').length < 1536, true, 'well under 2 KB');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('one pass at a time, per memory folder; a pass that ends lets go', async () => {
  const one = await mkdtemp(join(tmpdir(), 'memory-lock-')), two = await mkdtemp(join(tmpdir(), 'memory-lock-'));
  try {
    const release = await lock(one);
    assert.ok(release);
    assert.equal(await lock(one), null, 'held');
    const other = await lock(two);
    assert.ok(other, 'another folder is another lock');
    await release();
    await other();
    const again = await lock(one);
    assert.ok(again, 'free again');
    await again();
  } finally { await rm(one, { recursive: true, force: true }); await rm(two, { recursive: true, force: true }); }
});

test('episodes: one ends ten minutes after the agent finished a turn, is asked as soon as it has, and a session that goes on adds new ones', async () => {
  const w = await world();
  try {
    const id = 'e1000000-1111-4222-8333-444455556666';
    const said = [
      ['2026-09-30T02:10:00Z', 'noah', 'first ask'],
      ['2026-09-30T02:11:00Z', 'agent', 'first answer'],
      ['2026-09-30T02:15:00Z', 'noah', 'a follow-up four minutes later'],
      ['2026-09-30T02:16:00Z', 'Bash', 'npm run build'],
      ['2026-09-30T02:29:00Z', 'agent', 'Built, after a long build.'],
      ['2026-09-30T02:45:00Z', 'noah', 'back after a break'],
      ['2026-09-30T02:46:00Z', 'agent', 'second answer'],
    ];
    await addLog(w, id, said, { mtime: '2026-09-30T02:56:00Z' });
    const { asked, ask } = model();
    const local = [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }), local: true }];
    const pass = now => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: local, now: Date.parse(now), log: () => {}, ask });
    const mine = () => asked.filter(input => input.includes(`Session ${id}`));

    await pass('2026-09-30T03:00:00Z');
    assert.equal(mine().length, 1, 'the first episode has ended; the second is four minutes quiet');
    assert.match(mine()[0], /\nThis stretch: 2026-09-30, 02:10–02:29, local time\.\n/, 'a long tool call is not the end of a turn, nor four minutes between turns');
    assert.match(mine()[0], /npm run build/);
    assert.ok(!mine()[0].includes('back after a break'));

    await pass('2026-09-30T03:07:00Z');
    assert.equal(mine().length, 2, 'ten minutes after the agent answered, the next pass asks for it');
    assert.match(mine()[1], /\nThis stretch: 2026-09-30, 02:45–02:46, local time\.\n[^]*Earlier in this session, Noah said \(context only\):\n- 2026-09-30 02:10 first ask\n/);

    await addLog(w, id, [...said, ['2026-09-30T03:30:00Z', 'noah', 'and one more thing'], ['2026-09-30T03:31:00Z', 'agent', 'Done.']], { mtime: '2026-09-30T03:31:00Z' });
    await pass('2026-09-30T03:36:00Z');
    assert.equal(mine().length, 2, 'five minutes quiet: still going');
    const result = await pass('2026-09-30T03:42:00Z');
    assert.equal(mine().length, 3, 'the session went on: one new episode, from where the last stopped; the others are not asked again');
    assert.match(mine()[2], /\nThis stretch: 2026-09-30, 03:30–03:31, local time\.\n/);
    assert.equal(result.derivedNow, 1);
    const day = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.match(day, /\n## 02:10–03:31 laptop claude e1000000\n[^#]*made: gpt-6\.1-sol high\n\nsummary:\n- what happened from 02:10\n- what happened from 02:45\n- what happened from 03:30\n/, 'one session in the day, its episodes in order');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('an episode that ends on Noah, or on a tool call, waits half an hour before it counts as ended', async () => {
  const w = await world();
  try {
    const id = 'e4000000-1111-4222-8333-444455556666';
    await addLog(w, id, [['2026-09-30T02:00:00Z', 'noah', 'run the long job'], ['2026-09-30T02:01:00Z', 'Bash', 'make long-job']], { mtime: '2026-09-30T02:01:00Z' });
    const { asked, ask } = model();
    const local = [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }), local: true }];
    const pass = now => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: local, now: Date.parse(now), log: () => {}, ask });
    await pass('2026-09-30T02:20:00Z');
    assert.ok(!asked.some(input => input.includes(`Session ${id}`)), 'the job may still be running');
    await pass('2026-09-30T02:40:00Z');
    assert.ok(asked.some(input => input.includes(`Session ${id}`)), 'still for half an hour: copied into raw/, and ended');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('projects: named from the paths an episode touched, out of the folders there are; the model names them, or none', async () => {
  assert.deepEqual(projectsIn('cd ~/imperfect && git -C /home/noah/projects/dacre log; open /home/noah/workbench/kids-city/index.html; ls ~/archive/old-film; read ~/notes/garden.md.'),
    ['imperfect', 'dacre', 'kids-city', 'old-film', 'garden']);
  assert.deepEqual(projectsIn('open ~/workbench/making/companion/index.html; ls ~/workbench/done/ ~/workbench/inspo; cp ~/workbench/archive/trailer.mp4 .'),
    ['companion', 'trailer.mp4'], 'an older session\'s stage is never a project, only the piece in it');
  assert.deepEqual(projectsIn('not ~/.imperfect/data, ~/imperfect.computer, ~/imperfect-dev, /srv/projects/x or ~/projects/'), [], 'only those folders');
  assert.deepEqual(projectsIn('cd "/home/noah/projects/Dacre Site"'), ['dacre'], 'a name is a file name: to the first space, lower case');

  const w = await world();
  try {
    await mkdir(join(w.home, 'projects', 'dacre'), { recursive: true });
    await mkdir(join(w.home, 'workbench', 'kids-city'), { recursive: true });
    await mkdir(join(w.home, 'workbench', 'making', 'left-behind'), { recursive: true });
    await mkdir(join(w.home, 'archive', 'old-film'), { recursive: true });
    await mkdir(join(w.home, 'notes'), { recursive: true });
    await writeFile(join(w.home, 'notes', 'garden.md'), '# garden\n');
    await writeFile(join(w.home, 'notes', '.hidden.md'), '');
    assert.deepEqual(await knownProjects(w.home), ['dacre (~/projects/dacre)', 'garden (~/notes/garden.md)', 'imperfect (~/imperfect)', 'kids-city (~/workbench/kids-city)', 'old-film (~/archive/old-film)']);

    await addLog(w, 'e2000000-1111-4222-8333-444455556666', [['2026-09-30T02:10:00Z', 'noah', 'deploy the dacre site'], ['2026-09-30T02:11:00Z', 'Bash', 'cd /home/noah/projects/dacre && git -C /home/noah/imperfect log -1'], ['2026-09-30T02:12:00Z', 'agent', 'Deployed.']], { cwd: '/home/noah/projects/dacre' });
    await addLog(w, 'e3000000-1111-4222-8333-444455556666', [['2026-09-30T02:20:00Z', 'noah', 'what is the weather'], ['2026-09-30T02:21:00Z', 'agent', 'Sunny.']], { cwd: '/home/noah/projects/dacre' });
    const { asked, ask } = model((from, input) => `${input.includes('weather') ? 'projects: none\n' : ''}summary:\n- x\n\n### ${from} agent\nDone.\n`);
    await w.run(NOW, ask);
    const dacre = asked.find(input => input.includes('deploy the dacre site'));
    assert.match(dacre, /^Known projects \(name and where\): dacre \(~\/projects\/dacre\), garden \(~\/notes\/garden\.md\), imperfect \(~\/imperfect\), kids-city \(~\/workbench\/kids-city\), old-film \(~\/archive\/old-film\)\.\n/);
    assert.match(dacre, /\nProjects its paths point to: dacre, imperfect\.\n/);
    const day = await readFile(join(w.dir, 'days', '2026-09-30.md'), 'utf8');
    assert.match(day, /\n## 02:10–02:12 laptop claude e2000000\n[^#]*\nmade: gpt-6\.1-sol high\nprojects: dacre, imperfect\n/, 'no projects line in the answer: the paths name them');
    assert.match(day, /\n## 02:20–02:21 laptop claude e3000000\n[^#]*\nmade: gpt-6\.1-sol high\n\nsummary:/, 'none: general, though it ran in the folder');
    assert.deepEqual(parseAnswer('projects: Dacre, Kids City, none\nsummary:\n- x\n\n### 01:00 agent\nDone.', { from: Date.parse('2026-09-30T01:00:00Z'), to: Date.parse('2026-09-30T01:00:00Z') }).projects, ['dacre', 'kids-city']);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

// A world with a project: two episodes of a session in ~/projects/dacre, and
// one general session between them; the model names the projects from the
// paths, and its summary and turns carry Noah's words.
async function projectWorld() {
  const w = await world();
  await mkdir(join(w.home, 'projects', 'dacre'), { recursive: true });
  await mkdir(join(w.home, 'notes'), { recursive: true });
  await writeFile(join(w.home, 'notes', 'dacre.md'), `# dacre\n\nThe site deploys to Netlify. The box token is ${CREDENTIAL}.\n`);
  await addLog(w, 'e2000000-1111-4222-8333-444455556666', [
    ['2026-09-30T02:10:00Z', 'noah', 'deploy the dacre site to cloudflare instead of netlify'],
    ['2026-09-30T02:11:00Z', 'Bash', 'cd /home/noah/projects/dacre && npx wrangler pages deploy'],
    ['2026-09-30T02:12:00Z', 'agent', 'Moved to Cloudflare Pages.'],
    ['2026-09-30T02:40:00Z', 'noah', 'did the deploy finish?'],
    ['2026-09-30T02:41:00Z', 'agent', 'Yes.'],
  ], { cwd: '/home/noah/projects/dacre' });
  await addLog(w, 'e3000000-1111-4222-8333-444455556666', [['2026-09-30T02:20:00Z', 'noah', 'how do I deploy anything at all'], ['2026-09-30T02:21:00Z', 'agent', 'With a script.']], { cwd: '/home/noah' });
  const brain = model((from, input) => {
    const noah = /NOAH:\n(.*)/.exec(input)?.[1] ?? 'nothing said';
    return `projects: ${/^Projects its paths point to: (.*)\.$/m.exec(input)[1]}\nsummary:\n- worked on: ${noah}\n\n### ${from} noah\n${noah}\n\n### ${from} agent\nThe agent did it.\n`;
  });
  return { ...w, ...brain };
}

test('views: projects/<name>.md and index.json are made from the episodes by code, and made again without the model', async () => {
  const w = await projectWorld();
  try {
    await w.run(NOW, w.ask);
    const project = await readFile(join(w.dir, 'projects', 'dacre.md'), 'utf8');
    assert.deepEqual(await readdir(join(w.dir, 'projects')), ['dacre.md'], 'a project for what was worked on; none for general work');
    assert.ok(project.startsWith('# dacre: every episode that touched it, newest first\n\n'));
    assert.deepEqual(project.match(/^## .*$/gm), ['## 2026-09-30 02:40–02:41 laptop claude e2000000', '## 2026-09-30 02:10–02:12 laptop claude e2000000'], 'newest first, with the day and session');
    assert.match(project, /\n## 2026-09-30 02:10–02:12 laptop claude e2000000\nsession: e2000000-1111-4222-8333-444455556666 · ~\/projects\/dacre\n- worked on: deploy the dacre site to cloudflare instead of netlify\n/);
    const index = JSON.parse(await readFile(join(w.dir, 'index.json'), 'utf8'));
    assert.equal(index.projects.dacre.length, 2);
    assert.deepEqual(index.projects.dacre.map(key => index.episodes[key].from), ['2026-09-30T02:40:00+00:00', '2026-09-30T02:10:00+00:00']);
    assert.deepEqual(index.episodes[index.projects.dacre[0]], { day: '2026-09-30', from: '2026-09-30T02:40:00+00:00', to: '2026-09-30T02:41:00+00:00', computer: 'laptop', harness: 'claude',
      session: 'e2000000-1111-4222-8333-444455556666', short: 'e2000000', cwd: '~/projects/dacre', projects: ['dacre'], file: 'days/2026-09-30.md' });
    assert.equal(index.days['2026-09-30'].length, 6, 'every episode of the day: the fixtures three, dacre two, the general one');
    assert.ok(index.days['2026-09-30'].every(key => index.episodes[key]));

    const before = {};
    for (const name of ['projects/dacre.md', 'index.json', 'days/2026-09-30.md', 'recent.md']) before[name] = await readFile(join(w.dir, name), 'utf8');
    for (const name of ['projects', 'index.json', 'days', 'recent.md']) await rm(join(w.dir, name), { recursive: true, force: true });
    const asked = w.asked.length;
    await w.run(NOW);
    assert.equal(w.asked.length, asked, 'no model');
    for (const [name, text] of Object.entries(before)) assert.equal(await readFile(join(w.dir, name), 'utf8'), text, `${name} made again the same`);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('recall: by project, the episodes that worked on it, their summaries searched too', async () => {
  const w = await projectWorld();
  let server;
  try {
    await w.run(NOW, w.ask);
    const all = await search('deploy', { dir: w.dir, repo: w.repo });
    assert.deepEqual(all.map(hit => `${hit.who} ${hit.time.slice(11, 16)}`), ['noah 02:40', 'noah 02:20', 'noah 02:10', 'summary 02:40', 'summary 02:20', 'summary 02:10'], 'Noah first, then the summaries, newest first');
    const hits = await search('deploy', { dir: w.dir, repo: w.repo, project: 'Dacre' });
    assert.deepEqual(hits.map(hit => `${hit.who} ${hit.time.slice(11, 16)}`), ['noah 02:40', 'noah 02:10', 'summary 02:40', 'summary 02:10'], 'not the general session');
    assert.equal(hits[2].path, join(w.dir, 'projects', 'dacre.md'));
    assert.deepEqual(hits[2].projects, ['dacre']);
    const latest = await search('', { dir: w.dir, project: 'dacre' });
    assert.deepEqual(latest.map(hit => hit.who), ['summary', 'summary'], 'a project alone: its episodes');
    assert.deepEqual(await search('deploy', { dir: w.dir, project: 'nowhere' }), []);

    const route = createMemoryRoute({ dir: w.dir });
    server = createServer(async (req, res) => { if (!await route(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const answer = await runRecall({ project: 'dacre' }, { locate: async () => `http://127.0.0.1:${server.address().port}` });
    assert.match(answer, /^2 things said in the episodes of dacre/);
    assert.match(answer, /\n1\. summary of an episode, 2026-09-30 02:40–02:41 on laptop \(claude e2000000\), projects: dacre\n {3}[^\n]*\/projects\/dacre\.md\n {3}- worked on: did the deploy finish\?/);
    assert.match(await runRecall({ query: 'weather', project: 'dacre' }, { locate: async () => null, find: (query, options) => search(query, { ...options, dir: w.dir }) }), /^Nothing said in past sessions holding "weather" in the episodes of dacre/);
    await assert.rejects(runRecall({}, { locate: async () => null }), /words to look for, a project, or both/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(w.home, { recursive: true, force: true });
  }
});


// The nightly review, with imperfect's /sessions/open played by a function.
function opener() {
  const opened = [];
  return { opened, open: async args => { opened.push(args); return { id: `tab-${opened.length}` }; } };
}

// These cases step gather's explicit now. Its elapsed-work clock must stay
// still too: CPU contention is not a simulated second or a nightly boundary.
test('once a night, at 04:00, memory opens a nightly review session on Pi about the day before; a night without episodes has none', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const w = await projectWorld();
  try {
    const { opened, open } = opener(), said = [];
    const run = (now, more = {}) => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: [], now: Date.parse(now), log: line => said.push(line), ask: w.ask, open, ...more });
    await w.run(NOW, w.ask);
    await run('2026-09-30T22:00:00Z');
    assert.equal(opened.length, 0, 'never in the evening, even on its first night');
    await run('2026-10-01T03:59:00Z');
    assert.equal(opened.length, 0, 'not before four');
    await run('2026-10-01T04:01:00Z');
    assert.equal(opened.length, 1);
    const [review] = opened;
    assert.deepEqual([review.agent, review.cwd, review.name, review.model, review.thinking], ['pi', w.home, 'nightly review 2026-09-30', 'openai-codex/gpt-6.1-sol', 'high'], "on Pi, on memory's model, Pi's settings naming none");
    assert.match(review.prompt, /^Nightly review of 2026-09-30\.\n\nMemory opened this session/);
    assert.ok(review.prompt.includes(`${w.dir}/days/2026-09-30.md`) && !review.prompt.includes('{{'), 'the day and where memory is, filled in');
    assert.match(review.prompt, /AskUserQuestion/);
    assert.match(review.prompt, /Check the already-authorized Pi and Claude Code updates in every review/);
    await assert.rejects(readFile(join(w.dir, 'open', 'upgrade.md')), { code: 'ENOENT' }, 'update check does not require a raised failure');
    assert.match(review.prompt, /"cloud sessions" section of ~\/notes\/computers\.md/);
    const state = JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8'));
    assert.deepEqual(state, { reviews: [{ day: '2026-09-30', opened: '2026-10-01T04:01:00+00:00', id: 'tab-1' }], checked: '2026-10-01' });
    await run('2026-10-01T04:30:00Z');
    assert.equal(opened.length, 1, 'once a night');
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /\n## Open[^\n]*\n\n[^#]*\nThe nightly review of 2026-09-30 waits on Noah's answers: the Pi session "nightly review 2026-09-30" in imperfect, opened 2026-10-01 04:01\.\n/, 'the open list says it waits');

    const fresh = await projectWorld();
    try {
      await mkdir(join(fresh.prefix, 'data', 'agent'), { recursive: true });
      await writeFile(join(fresh.prefix, 'data', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5' }));
      const chosen = opener();
      await fresh.run(NOW, fresh.ask);
      await gather({ prefix: fresh.prefix, dir: fresh.dir, home: fresh.home, from: [], now: Date.parse('2026-10-01T04:30:00Z'), log: () => {}, ask: fresh.ask, open: chosen.open });
      assert.equal(chosen.opened[0].model, undefined, "Pi's settings name a model: the session takes it");
      assert.equal(chosen.opened[0].thinking, 'high', 'and memory\'s thinking level, which they do not name');
      const quiet = opener();
      await gather({ prefix: fresh.prefix, dir: fresh.dir, home: fresh.home, from: [], now: Date.parse('2026-10-02T04:30:00Z'), log: () => {}, ask: fresh.ask, open: quiet.open });
      assert.equal(quiet.opened.length, 0, 'nothing happened on 2026-10-01');
      assert.equal(JSON.parse(await readFile(join(fresh.dir, 'nightly.json'), 'utf8')).checked, '2026-10-02');
    } finally { await rm(fresh.home, { recursive: true, force: true }); }
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test("unanswered review gets repair-only maintenance without losing its record; an answer lets the next review open", async t => {
  t.mock.method(Date, 'now', () => NOW);
  const w = await projectWorld();
  try {
    const { opened, open } = opener(), said = [];
    const run = now => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }) }], now: Date.parse(now), log: line => said.push(line), ask: w.ask, open });
    await run('2026-09-30T04:00:00Z');
    await run('2026-10-01T04:05:00Z');
    assert.equal(opened.length, 1);
    // The review's session: the prompt, the write-up, and its questions, not answered yet.
    const id = 'ab100000-1111-4222-8333-444455556666';
    const log = [['2026-10-01T04:05:00Z', 'noah', opened[0].prompt], ['2026-10-01T04:09:00Z', 'agent', 'Three things from yesterday.'], ['2026-10-01T04:10:00Z', 'AskUserQuestion', 'which?']];
    await addLog(w, id, log, { cwd: '/home/noah', mtime: '2026-10-01T04:10:00Z' });
    await addLog(w, 'e5000000-1111-4222-8333-444455556666', [['2026-10-01T12:00:00Z', 'noah', 'more work on dacre in ~/projects/dacre'], ['2026-10-01T12:01:00Z', 'agent', 'Done.']], { cwd: '/home/noah/projects/dacre', mtime: '2026-10-01T12:01:00Z' });
    await run('2026-10-02T04:05:00Z');
    assert.equal(opened.length, 2, 'unanswered decisions do not block maintenance');
    assert.equal(opened[1].name, 'nightly repair 2026-10-01');
    assert.match(opened[1].prompt, /REPAIR-ONLY maintenance/);
    assert.match(opened[1].prompt, /prior unanswered review is "nightly review 2026-09-30" \(session tab-1\)/);
    assert.match(opened[1].prompt, /do not duplicate questions or act on pending decisions/);
    assert.match(opened[1].prompt, /Check the already-authorized Pi and Claude Code updates in every review/);
    await assert.rejects(readFile(join(w.dir, 'open', 'upgrade.md')), { code: 'ENOENT' }, 'repair-only update check does not require a raised failure');
    const state = JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8'));
    assert.deepEqual(state.reviews, [{ day: '2026-09-30', opened: '2026-10-01T04:05:00+00:00', id: 'tab-1' }]);
    assert.equal(state.checked, '2026-10-02');
    await run('2026-10-02T04:30:00Z');
    assert.equal(opened.length, 2, 'repair-only also opens only once a day');
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /nightly review of 2026-09-30 waits/, 'original unanswered review still shown');

    // Noah answers its questions in the morning; the next night opens again.
    const file = await addLog(w, id, log, { cwd: '/home/noah', mtime: '2026-10-02T08:00:00Z' });
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.push(JSON.stringify({ type: 'user', uuid: `${id}-answer`, sessionId: id, cwd: '/home/noah', timestamp: '2026-10-02T08:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'User has answered your questions: "which?"="the first"' }] } }));
    await writeFile(file, lines.join('\n'));
    await utimes(file, at('2026-10-02T08:00:00Z'), at('2026-10-02T08:00:00Z'));
    await addLog(w, 'e6000000-1111-4222-8333-444455556666', [['2026-10-02T12:00:00Z', 'noah', 'and again on dacre'], ['2026-10-02T12:01:00Z', 'agent', 'Done.']], { cwd: '/home/noah/projects/dacre', mtime: '2026-10-02T12:01:00Z' });
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /nightly review of 2026-09-30 waits/, 'until a pass reads the answer');
    await run('2026-10-03T04:05:00Z');
    assert.equal(opened.length, 3, 'answered: the next night has its review');
    assert.equal(opened[2].name, 'nightly review 2026-10-02');
    assert.ok(!opened[2].prompt.includes('REPAIR-ONLY maintenance'));
    assert.ok(!(await readFile(join(w.dir, 'recent.md'), 'utf8')).includes('nightly review of 2026-09-30'), 'the answered one no longer waits');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('nightly prompt authorizes bounded evidence-led repairs before questions, not new decisions or unsafe activation', async () => {
  const prompt = await readFile(new URL('../../../system/memory-nightly-prompt.md', import.meta.url), 'utf8');
  for (const text of [
    'Noah authorizes', 'already-settled intended experience, BEFORE asking questions',
    '{{memory}}/recent.md', '{{memory}}/open/', 'open/upgrade.md',
    'reproduce the defect before editing', 'At most 3 repair attempts and one test rerun per candidate',
    'Never weaken or skip tests', 'preserve failures', 'independent `systemd-run --user` units',
    'No `npm install` or `npm ci` in the live checkout', 'never install live dependencies under running agents',
    'updates in every review, including REPAIR-ONLY', 'even without a raised upgrade failure or any needed repair',
    "Inspect the existing two-hour updater's status/results first", 'if an update is already running',
    'follow its results instead of starting another', 'If blocked by a defect, retry only after proven repairs',
    '`system/upgrade.mjs`', 'normal isolated-copy tests and idle activation safeguards', 'No forced activation',
    'interrupting or restarting working agents', 'Never delete personal data, use sudo, handle secrets, buy, post or send externally',
    'ambiguous intent', 'large migrations/redesigns', 'security-sensitive actions', 'new spend',
    'Settled stale note corrections', 'commit those separately', 'what remains unverified or deferred',
    'ask no duplicate questions', 'never act on its pending decisions',
  ]) assert.ok(prompt.includes(text), `missing authority or guardrail: ${text}`);
  assert.ok(!prompt.includes('until then, change nothing'));
});

test('no-episode raised upgrade failure opens repair-only at four, retries failed opens, and preserves unanswered review', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const w = await projectWorld();
  try {
    await w.run(NOW, w.ask);
    await mkdir(join(w.dir, 'open'), { recursive: true });
    await writeFile(join(w.dir, 'open', 'upgrade.md'), '- upgrade: regression tests failed; not taken\n');
    const prior = { day: '2026-09-30', opened: '2026-10-01T04:00:00+00:00', id: 'original' };
    await writeFile(join(w.dir, 'nightly.json'), JSON.stringify({ reviews: [prior], checked: '2026-10-01' }));
    const opened = [];
    let fail = true;
    const run = now => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: [], now: Date.parse(now), log: () => {}, ask: w.ask,
      open: async args => { opened.push(args); if (fail) throw new Error('opening failed'); return { id: 'repair' }; } });
    await run('2026-10-02T03:59:00Z');
    assert.equal(opened.length, 0);
    await run('2026-10-02T04:00:00Z');
    assert.equal(JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8')).checked, '2026-10-01', 'failure leaves next pass free to retry');
    fail = false;
    await run('2026-10-02T04:02:00Z');
    assert.equal(opened.length, 2);
    assert.equal(opened[1].name, 'nightly repair 2026-10-01');
    assert.match(opened[1].prompt, /REPAIR-ONLY maintenance/);
    assert.match(opened[1].prompt, /prior unanswered review is "nightly review 2026-09-30"/);
    assert.deepEqual(JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8')).reviews, [prior]);
    await run('2026-10-02T04:30:00Z');
    assert.equal(opened.length, 2);
    // No unanswered review: still repair-only, not a new decision review.
    await writeFile(join(w.dir, 'nightly.json'), JSON.stringify({ reviews: [] }));
    await run('2026-10-03T05:00:00Z');
    assert.equal(opened.length, 2, 'outside four never opens');
    await run('2026-10-04T04:01:00Z');
    assert.equal(opened.length, 3);
    assert.match(opened[2].prompt, /No episodes yesterday; inspect the raised upgrade failure/);
    assert.deepEqual(JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8')).reviews, []);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test("the nightly review is opened through imperfect's /sessions/open, with the session token, and tried again when imperfect does not answer", async t => {
  t.mock.method(Date, 'now', () => NOW);
  const prefix = await mkdtemp(join(tmpdir(), 'memory-open-'));
  try {
    await writeFile(join(prefix, 'session-token'), 'secret-token\n');
    await writeFile(join(prefix, 'machine.json'), JSON.stringify({ port: 5099 }));
    const sent = [];
    const answer = await openSessionHere(prefix, async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ id: 'tab-9' }), { status: 200 }); })({ agent: 'pi', cwd: '/home/noah', name: 'nightly review 2026-09-30', prompt: 'p' });
    assert.deepEqual(answer, { id: 'tab-9' });
    assert.equal(sent[0].url, 'http://127.0.0.1:5099/sessions/open');
    assert.equal(sent[0].init.headers.authorization, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(sent[0].init.body), { agent: 'pi', cwd: '/home/noah', name: 'nightly review 2026-09-30', prompt: 'p' });
    await assert.rejects(openSessionHere(prefix, async () => new Response('', { status: 403 }))({ cwd: '/', name: 'n', prompt: 'p' }), /imperfect said 403/);
  } finally { await rm(prefix, { recursive: true, force: true }); }

  const w = await projectWorld();
  try {
    let up = false;
    const tries = [];
    const open = async args => { tries.push(args); if (!up) throw new Error('imperfect said 502'); return { id: 'tab-1' }; };
    const run = now => gather({ prefix: w.prefix, dir: w.dir, home: w.home, from: [], now: Date.parse(now), log: () => {}, ask: w.ask, open });
    await w.run(NOW, w.ask);
    await run('2026-10-01T04:00:00Z');
    assert.ok(!JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8').catch(() => '{}')).checked, 'not decided');
    up = true;
    await run('2026-10-01T04:02:00Z');
    assert.equal(tries.length, 2, 'the next pass tries again');
    assert.equal(JSON.parse(await readFile(join(w.dir, 'nightly.json'), 'utf8')).reviews.length, 1);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});
