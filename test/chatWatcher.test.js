'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const { ChatUsageWatcher, applyLine, newParserState, sessionUsage } = require(
  path.join(process.env.BEAR_TEST_BUILD, 'chatWatcher.js')
);

function replay(records) {
  const state = newParserState();
  for (const record of records) assert.equal(applyLine(JSON.stringify(record, null, 0), state), true);
  return state;
}
const set = (index, field, v) => ({ kind: 1, k: ['requests', index, field], v });

it('replays context growth and compaction without banking snapshots as usage', () => {
  const state = replay([
    { kind: 0, v: { sessionId: 's', requests: [{ requestId: 'r', promptTokens: 90000, completionTokens: 20, copilotCredits: 2 }] } },
    set(0, 'promptTokens', 95000), set(0, 'promptTokens', 5000),
    set(0, 'completionTokens', 50), set(0, 'copilotCredits', 3),
    set(0, 'outputBuffer', 32000)
  ]);
  const session = sessionUsage(state, 'fallback', 1);
  assert.equal(session.latestPromptTokens, 5000);
  assert.equal(session.credits, 3);
  assert.equal(session.requests, 1);
  assert.equal(session.sessionId, 's');
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
  assert.equal(sessionUsage(state, 'fallback', 1).title.length, 80);
  applyLine(JSON.stringify({ kind: 1, k: ['customTitle'], v: 42 }), state);
  assert.equal(sessionUsage(state, 'fallback', 1).title, undefined);
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
  assert.equal(deltas[0].credits, 2);
  first.dispose();
  const restarted = new ChatUsageWatcher(context, (delta) => deltas.push(delta));
  t.after(() => restarted.dispose());
  restarted.scan();
  assert.equal(restarted.sessions[0].credits, 12);
  assert.equal(deltas.length, 1);
  fs.appendFileSync(file, JSON.stringify(set(0, 'copilotCredits', 13)) + '\n');
  restarted.scan();
  assert.equal(deltas[1].credits, 1);
  assert.equal(deltas.every((d) => d.input === 0 && d.output === 0), true);
  fs.writeFileSync(file, initial);
  restarted.scan();
  assert.equal(restarted.sessions[0].credits, 10);
  assert.equal(deltas.length, 2);
});
