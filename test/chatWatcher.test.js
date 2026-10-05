'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const { ChatUsageWatcher, applyLine, newParserState, sessionUsage, chatSessionIndex } = require(
  path.join(process.env.BEAR_TEST_BUILD, 'chatWatcher.js')
);

function replay(records) {
  const state = newParserState();
  for (const record of records) assert.equal(applyLine(JSON.stringify(record, null, 0), state), true);
  return state;
}
const set = (index, field, v) => ({ kind: 1, k: ['requests', index, field], v });

it('replays transcript mutations but retains only model and credit metadata', () => {
  const state = replay([
    { kind: 0, v: { sessionId: 's', requests: [{ requestId: 'r', modelId: 'gpt-test', promptTokens: 90000, completionTokens: 20, copilotCredits: 2 }] } },
    set(0, 'promptTokens', 95000), set(0, 'promptTokens', 5000),
    set(0, 'completionTokens', 50), set(0, 'copilotCredits', 3),
    set(0, 'outputBuffer', 32000)
  ]);
  const session = sessionUsage(state, 'fallback', 1);
  assert.equal(session.credits, 3);
  assert.equal(session.model, 'gpt-test');
  assert.equal(session.sessionId, 's');
  assert.doesNotMatch(JSON.stringify(state), /requestId|promptTokens|completionTokens|outputBuffer/);
});

it('carries the name the user gave the session and drops derived transcript titles', () => {
  const state = replay([
    { kind: 0, v: { sessionId: 's', customTitle: '  Rate limiter\n rewrite ', title: 'Fix the flaky login test', requests: [] } }
  ]);
  assert.equal(sessionUsage(state, 'fallback', 1).title, 'Rate limiter rewrite');
  assert.doesNotMatch(JSON.stringify(state), /flaky login/);
  applyLine(JSON.stringify({ kind: 1, k: ['customTitle'], v: 'Renamed' }), state);
  assert.equal(sessionUsage(state, 'fallback', 1).title, 'Renamed');
  applyLine(JSON.stringify({ kind: 3, k: ['customTitle'] }), state);
  assert.equal(sessionUsage(state, 'fallback', 1).title, undefined);
  applyLine(JSON.stringify({ kind: 1, k: ['customTitle'], v: 'x'.repeat(200) }), state);
  assert.equal(sessionUsage(state, 'fallback', 1).title.length, 200);
  applyLine(JSON.stringify({ kind: 1, k: ['customTitle'], v: 42 }), state);
  assert.equal(sessionUsage(state, 'fallback', 1).title, undefined);
});

it('projects VS Code history titles and activity timestamps without retaining prompt or response content', () => {
  const sessions = chatSessionIndex({ version: 1, entries: {
    s: { sessionId: 's', title: 'Business canvas feasibility', lastMessageDate: 1234, response: 'private' },
    renamed: { sessionId: 'renamed', title: 'DAWID TESTING', lastMessageDate: 5678, message: 'private' }
  } });
  assert.equal(sessions[0].title, 'Business canvas feasibility');
  assert.equal(sessions[1].title, 'DAWID TESTING');
  assert.equal(sessions[1].updatedAt, 5678);
  assert.doesNotMatch(JSON.stringify(sessions), /private|response|message/);
  assert.throws(() => chatSessionIndex({ version: 2, entries: {} }), /Unsupported/);
});

it('uses the same titles as chat history, including renames without a transcript change and legacy JSON', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-chat-index-'));
  const workspace = path.join(dir, 'workspaceStorage', 'w');
  const chat = path.join(workspace, 'chatSessions');
  fs.mkdirSync(chat, { recursive: true });
  const db = new DatabaseSync(path.join(workspace, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const writeIndex = (title) => db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run(
    'chat.ChatSessionStore.index', JSON.stringify({ version: 1, entries: {
      s: { sessionId: 's', title, lastMessageDate: 5000 },
      legacy: { sessionId: 'legacy', title: 'Repository cleanup', lastMessageDate: 1000 },
      indexed: { sessionId: 'indexed', title: 'Metadata-only chat', lastMessageDate: 2000 }
    } })
  );
  writeIndex('DAWID TESTING');
  fs.writeFileSync(path.join(chat, 's.jsonl'), JSON.stringify({ kind: 0, v: {
    sessionId: 's', customTitle: 'Stale transcript name', requests: [{ copilotCredits: 10 }]
  } }) + '\n');
  fs.writeFileSync(path.join(chat, 's.json'), JSON.stringify({ sessionId: 's', requests: [{ copilotCredits: 999 }] }));
  fs.writeFileSync(path.join(chat, 'legacy.json'), JSON.stringify({ sessionId: 'legacy', requests: [{ copilotCredits: 5 }] }));
  const deltas = [];
  const service = new ChatUsageWatcher({
    globalStorageUri: { fsPath: path.join(dir, 'profiles', 'custom', 'globalStorage', 'bear') },
    globalState: { get: () => undefined, update: async () => {} }
  }, (delta) => deltas.push(delta));
  t.after(() => { service.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  service.scan();
  assert.deepEqual(service.sessions.map((s) => s.title), ['DAWID TESTING', 'Metadata-only chat', 'Repository cleanup']);
  assert.equal(service.sessions[0].credits, 10, 'JSONL supersedes the stale flat JSON copy');
  assert.equal(service.sessions[0].updatedAt, 5000, 'chat activity, not transcript filesystem time');
  assert.equal(service.sessions[2].credits, 5);
  writeIndex('Renamed in chat');
  service.scan();
  assert.equal(service.sessions[0].title, 'Renamed in chat');
  assert.deepEqual(deltas, [], 'discovering and renaming histories never charges them');
  fs.writeFileSync(path.join(chat, 'indexed.jsonl'), JSON.stringify({ kind: 0, v: {
    sessionId: 'indexed', requests: [{ copilotCredits: 50 }]
  } }) + '\n');
  service.scan();
  assert.deepEqual(deltas, [], 'a transcript discovered after its index entry is still a history baseline');
  fs.writeFileSync(path.join(chat, 'legacy.json'), JSON.stringify({ sessionId: 'legacy', requests: [{ copilotCredits: 7 }] }));
  service.scan();
  assert.deepEqual(deltas, [2]);
});

it('counts the first reported credits for an already observed empty legacy JSON session', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-legacy-empty-'));
  const chat = path.join(dir, 'globalStorage', 'emptyWindowChatSessions');
  fs.mkdirSync(chat, { recursive: true });
  const file = path.join(chat, 's.json');
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's', requests: [] }));
  const deltas = [];
  const service = new ChatUsageWatcher({
    globalStorageUri: { fsPath: path.join(dir, 'globalStorage', 'bear') },
    globalState: { get: () => undefined, update: async () => {} }
  }, (delta) => deltas.push(delta));
  t.after(() => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  service.scan();
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's', requests: [{ copilotCredits: 3 }] }));
  service.scan();
  assert.deepEqual(deltas, [3]);
});

it('matches VS Code Session Cost including backend totals, missing and zero credits', () => {
  const state = replay([{ kind: 0, v: { requests: [
    { copilotCredits: 30, sessionCopilotCredits: 293.2 },
    { copilotCredits: 50 }, { copilotCredits: 0 }, {}
  ] } }]);
  assert.equal(sessionUsage(state, 's', 1).credits, 293.2);
  applyLine(JSON.stringify(set(1, 'copilotCredits', 300)), state);
  assert.equal(sessionUsage(state, 's', 1).credits, 330);
  assert.equal(sessionUsage(replay([{ kind: 0, v: { requests: [{}] } }]), 's', 0).credits, undefined);
  assert.equal(sessionUsage(replay([{ kind: 0, v: { requests: [{ copilotCredits: 0 }] } }]), 's', 0).credits, 0);
});

it('honors replacement, splice indices and delete records instead of retiring removed requests', () => {
  const state = replay([
    { kind: 0, v: { requests: [{ copilotCredits: 10 }, { copilotCredits: 20 }] } },
    { kind: 2, k: ['requests'], i: 1, v: [{ copilotCredits: 3 }] },
    { kind: 2, k: ['requests'], v: [{ copilotCredits: 4 }] },
    { kind: 3, k: ['requests', 0, 'copilotCredits'] }
  ]);
  assert.equal(sessionUsage(state, 's', 0).credits, 7);
  applyLine(JSON.stringify({ kind: 2, k: ['requests'], i: 1 }), state);
  assert.equal(sessionUsage(state, 's', 0).credits, undefined);
  applyLine(JSON.stringify({ kind: 1, k: ['requests'], v: [{ copilotCredits: 2 }] }), state);
  assert.equal(sessionUsage(state, 's', 0).credits, 2);
});

it('does not retain transcript content or treat unknown numeric fields as credits', () => {
  const state = replay([{ kind: 0, v: { requests: [{ message: 'private', response: ['private'], promptTokens: 12 }] } },
    set(0, 'cachedTokens', 500), set(0, 'copilotCredits', -1)]);
  assert.equal(sessionUsage(state, 's', 0).credits, undefined);
  assert.doesNotMatch(JSON.stringify(state), /private|cachedTokens/);
  assert.equal(applyLine('{', state), false);
});

it('reconstructs full session cost across restart, partial append and snapshot rewrite', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-transcripts-'));
  const chat = path.join(dir, 'workspaceStorage', 'w', 'chatSessions');
  fs.mkdirSync(chat, { recursive: true });
  const file = path.join(chat, 's.jsonl');
  const initial = JSON.stringify({ kind: 0, v: { sessionId: 's', requests: [{ requestId: 'r', promptTokens: 90000, copilotCredits: 10 }] } }) + '\n';
  fs.writeFileSync(file, initial);
  const store = new Map();
  const context = {
    globalStorageUri: { fsPath: path.join(dir, 'globalStorage', 'bear') },
    globalState: { get: (key) => store.get(key), update: async (key, v) => store.set(key, structuredClone(v)) }
  };
  const deltas = [];
  const first = new ChatUsageWatcher(context, (delta) => deltas.push(delta));
  const second = new ChatUsageWatcher(context, (delta) => deltas.push(delta));
  t.after(() => { first.dispose(); second.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  first.scan();
  assert.equal(first.sessions[0].credits, 10);
  assert.deepEqual(deltas, []);
  const update = JSON.stringify(set(0, 'copilotCredits', 12)) + '\n';
  fs.appendFileSync(file, update.slice(0, -2));
  first.scan();
  assert.equal(first.sessions[0].credits, 10);
  fs.appendFileSync(file, update.slice(-2));
  first.scan();
  assert.equal(deltas[0], 2);
  first.dispose();
  const restarted = new ChatUsageWatcher(context, (delta) => deltas.push(delta));
  t.after(() => restarted.dispose());
  restarted.scan();
  assert.equal(restarted.sessions[0].credits, 12);
  assert.equal(deltas.length, 1);
  fs.appendFileSync(file, JSON.stringify(set(0, 'copilotCredits', 13)) + '\n');
  restarted.scan();
  assert.equal(deltas[1], 1);
  fs.writeFileSync(file, initial);
  restarted.scan();
  assert.equal(restarted.sessions[0].credits, 10);
  assert.equal(deltas.length, 2);
});
