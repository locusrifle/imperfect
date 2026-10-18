import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createGueyServer } from '../../../system/server.mjs';
import * as controls from '../native/code-control.mjs';
const { SESSION_TOOL, openSession, provideSessions, runSessionTool } = controls;

test('outside imperfect, code_session says it cannot', async () => {
  provideSessions(undefined);
  await assert.rejects(runSessionTool({ prompt: 'hi' }), /not running inside imperfect/);
});

test('code_session advertises only explicitly requested interactive work', async () => {
  assert.equal(Object.hasOwn(SESSION_TOOL.parameters.properties, 'headless'), false);
  assert.match(SESSION_TOOL.description, /only when the person explicitly requests/);
  assert.match(SESSION_TOOL.description, /Not for delegation: use subagent process tools instead/);
  assert.doesNotMatch(JSON.stringify(SESSION_TOOL), /headless|session_message|hand a task to another agent/);
  assert.equal(Object.hasOwn(controls, 'MESSAGE_TOOL'), false);
  assert.equal(Object.hasOwn(controls, 'runSessionMessage'), false);
  const { TOOLS } = await import('../native/tools.mjs');
  assert.equal(TOOLS.some(([tool]) => tool.name === 'session_message'), false);
});

test('stale headless requests fail with subagent guidance before invoking the opener', async () => {
  const opened = [];
  provideSessions(args => { opened.push(args); return { id: 'unexpected' }; });
  try {
    for (const headless of [true, 'true']) {
      await assert.rejects(runSessionTool({ headless, prompt: 'delegate this' }), /Use subagent process tools/);
      assert.throws(() => openSession({ headless }), /Use subagent process tools/);
    }
    assert.deepEqual(opened, []);
  } finally { provideSessions(undefined); }
});

test('code_session opens a named session in a folder, sends its first message, and puts its page beside it in every window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-'));
  const asked = [];
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command(c, selected) {
      asked.push([c, selected]);
      return c.type === 'tab-new' ? { id: 'tab-2' } : {};
    },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime });
  try {
    const { port } = await app.listen();
    const window = new WebSocket(`ws://127.0.0.1:${port}/pi`);
    await new Promise(resolve => window.once('open', resolve));
    const said = await runSessionTool({ cwd: root, agent: 'claude', name: 'screensaver', prompt: 'make it glow' });
    assert.match(said, /Opened a Claude Code session named "screensaver"/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(asked.map(([c, selected]) => [c.type, selected ?? null]), [['tab-new', null], ['name', 'tab-2'], ['prompt', 'tab-2']]);
    assert.equal(asked[0][0].cwd, root);
    assert.equal(asked[0][0].agent, 'claude');
    assert.equal(Object.hasOwn(asked[0][0], 'headless'), false);
    assert.equal(asked[2][0].text, 'make it glow');
    window.close();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const synchronous of [true, false]) test(`code_session catches ${synchronous ? 'synchronous' : 'asynchronous'} first-prompt failures without rejecting the opener`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-failure-'));
  const logged = [];
  t.mock.method(console, 'error', text => logged.push(text));
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, messages: [], tabs: [] }),
    command(c) {
      if (c.type !== 'prompt') return Promise.resolve(c.type === 'tab-new' ? { id: 'tab-2' } : {});
      if (synchronous) throw new Error('prompt refused');
      return Promise.reject(new Error('prompt refused'));
    },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime });
  try {
    await app.listen();
    assert.match(await runSessionTool({ name: 'separate work', prompt: 'hello' }), /Opened a Pi session/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(logged, ['code_session: first message: prompt refused']);
  } finally {
    await app.close();
    provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// Memory's nightly review: opened with the session token, on Pi, with a model
// and thinking level of its own that leave the person's defaults alone.
test('/sessions/open takes a Pi session\'s own model and thinking level, without making them the default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-model-'));
  const asked = [];
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command(c, selected) { asked.push([c, selected]); return c.type === 'tab-new' ? { id: 'tab-3' } : {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, sessionToken: 'tok' });
  try {
    const { port } = await app.listen();
    const open = (body, token = 'tok') => fetch(`http://127.0.0.1:${port}/sessions/open`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await open({ agent: 'pi' }, 'nope')).status, 403);
    const res = await open({ agent: 'pi', cwd: root, name: 'nightly review 2026-09-30', prompt: 'look back', model: 'openai-codex/gpt-6.1-sol', thinking: 'high' });
    assert.deepEqual(await res.json(), { id: 'tab-3' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(asked.map(([c, selected]) => [c.type, selected ?? null]), [['tab-new', null], ['name', 'tab-3'], ['model', 'tab-3'], ['thinking', 'tab-3'], ['prompt', 'tab-3']]);
    assert.deepEqual(asked[2][0], { type: 'model', provider: 'openai-codex', modelId: 'gpt-6.1-sol', persist: false });
    assert.deepEqual(asked[3][0], { type: 'thinking', level: 'high' });
  } finally {
    await app.close();
    provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('/sessions/open answers when a harness cannot start, and imperfect keeps running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-blocked-'));
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command(c) { if (c.type === 'tab-new') throw new Error('Sign in to Claude Code in imperfect to use your Claude subscription on this machine'); return {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, sessionToken: 'tok' });
  try {
    const { port } = await app.listen();
    const res = await fetch(`http://127.0.0.1:${port}/sessions/open`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', cwd: root, prompt: 'draft a reply' }) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Sign in to Claude Code/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await app.close();
    provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});
