import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotDraft } from '../public/js/screenshot-draft.js';

test('capture fences the desktop peer draft, preserves text, never sends, and attaches once', async () => {
  let selected = 'desktop/session-one', window;
  const drafts = new Map([['desktop/session-one', { text: 'keep this', images: [] }]]);
  const flow = screenshotDraft({ target: () => selected, focused: () => true,
    claim: async (_, id) => { window = id; return true; }, load: async name => name,
    attach: async (image, key) => drafts.get(key).images.push(image), pending: () => assert.fail('unexpected pending'),
  });
  await flow.begin('one'); selected = 'laptop/session-two';
  const shot = { capture: 'one', window, name: 'shot.png' };
  await flow.taken(shot); await flow.taken(shot);
  assert.deepEqual(drafts.get('desktop/session-one'), { text: 'keep this', images: ['shot.png'] });
  assert.equal(await flow.taken({ ...shot, window: 'another-window' }), false);
});

test('closed original session or offline retrieval stays pending, never attaches to new session', async () => {
  let window; const pending = [];
  const flow = screenshotDraft({ target: () => 'desktop/closed', focused: () => true,
    claim: async (_, id) => { window = id; return true; },
    load: async () => { throw new Error('offline'); }, attach: () => assert.fail('must not attach'),
    pending: (...args) => pending.push(args),
  });
  await flow.begin('one'); await flow.taken({ capture: 'one', window, name: 'saved.png' });
  assert.deepEqual(pending, [['saved.png', 'offline']]);
});

test('unfocused window and history events never claim or autoattach', async () => {
  const flow = screenshotDraft({ target: () => 'session', focused: () => false,
    claim: () => assert.fail('unfocused'), load: () => assert.fail('history is explicit'), attach() {}, pending() {},
  });
  await flow.begin('one'); assert.equal(await flow.taken({ name: 'history.png' }), false);
});
