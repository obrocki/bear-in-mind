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

function indexFixture(t, wal = false) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-chat-cache-'));
  const workspace = path.join(dir, 'workspaceStorage', 'w');
  const chat = path.join(workspace, 'chatSessions');
  fs.mkdirSync(chat, { recursive: true });
  const file = path.join(workspace, 'state.vscdb');
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const writeRaw = (value) => db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run(
    'chat.ChatSessionStore.index', value
  );
  const writeTitle = (title) => writeRaw(JSON.stringify({ version: 1, entries: {
    s: { sessionId: 's', title, lastMessageDate: 5000 }
  } }));
  writeTitle('History title');
  const deltas = [];
  const warnings = [];
  const service = new ChatUsageWatcher({
    globalStorageUri: { fsPath: path.join(dir, 'globalStorage', 'bear') },
    globalState: { get: () => undefined, update: async () => {} }
  }, (delta) => deltas.push(delta), (warning) => warnings.push(warning));
  let closed = false;
  const closeDatabase = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  t.after(() => { service.dispose(); closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { DatabaseSync, dir, workspace, chat, file, db, writeRaw, writeTitle, closeDatabase, service, deltas, warnings };
}

function indexReads(t) {
  const sqlite = require('node:sqlite');
  const { DatabaseSync } = sqlite;
  const reads = { opens: 0, queries: 0, closes: 0, statements: [], options: [], error: undefined };
  t.mock.method(sqlite, 'DatabaseSync', function(file, options) {
    reads.opens++;
    reads.options.push(options);
    const db = new DatabaseSync(file, options);
    return {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          all(...params) {
            reads.queries++;
            reads.statements.push({ sql, params });
            if (reads.error) throw reads.error;
            return statement.all(...params);
          }
        };
      },
      close() {
        reads.closes++;
        db.close();
      }
    };
  });
  return reads;
}

function modificationState(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs, ino: stat.ino };
}

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

it('skips SQLite opens and index queries for unchanged historical workspaces, including empty indexes', (t) => {
  const fixture = indexFixture(t);
  const { service, chat, deltas } = fixture;
  fixture.writeRaw(JSON.stringify({ version: 1, entries: {
    s: { sessionId: 's', title: 'Index title', lastMessageDate: 5000 },
    delayed: { sessionId: 'delayed', title: 'Delayed history', lastMessageDate: 1000 }
  } }));
  fs.writeFileSync(path.join(chat, 's.jsonl'), JSON.stringify({ kind: 0, v: {
    sessionId: 's', customTitle: 'Stale transcript title', requests: [{ copilotCredits: 10 }]
  } }) + '\n');
  const emptyWorkspace = path.join(fixture.dir, 'workspaceStorage', 'empty');
  fs.mkdirSync(emptyWorkspace);
  const empty = new fixture.DatabaseSync(path.join(emptyWorkspace, 'state.vscdb'));
  empty.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  empty.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('unrelated.state', 'private');
  empty.close();
  const reads = indexReads(t);
  service.scan();
  for (let i = 0; i < 3; i++) service.scan();
  assert.equal(reads.opens, 2, 'each database is opened only on its initial scan');
  assert.equal(reads.queries, 2, 'a missing index key is a cacheable successful read');
  assert.equal(service.sessions[0].title, 'Index title');
  fs.writeFileSync(path.join(chat, 'delayed.jsonl'), JSON.stringify({ kind: 0, v: {
    sessionId: 'delayed', requests: [{ copilotCredits: 50 }]
  } }) + '\n');
  service.scan();
  assert.deepEqual(deltas, [], 'delayed discovery still establishes a transcript credit baseline');
  fs.appendFileSync(path.join(chat, 's.jsonl'), JSON.stringify(set(0, 'copilotCredits', 12)) + '\n');
  service.scan();
  assert.deepEqual(deltas, [2], 'transcript credit increments are independent of the index cache');
  assert.equal(reads.opens, 2);
  assert.equal(reads.queries, 2);
  assert.equal(reads.closes, 2);
  assert.ok(reads.options.every((options) => options.readOnly === true));
  assert.ok(reads.statements.every(({ sql, params }) =>
    sql === 'SELECT value FROM ItemTable WHERE key = ?' && params.length === 1 && params[0] === 'chat.ChatSessionStore.index'));
});

it('refreshes WAL-only renames and same-size WAL reuse, checkpoints and WAL removal', (t) => {
  const fixture = indexFixture(t, true);
  const { service, db, file } = fixture;
  const wal = `${file}-wal`;
  const reads = indexReads(t);
  service.scan();
  service.scan();
  assert.equal(reads.opens, 1);
  const databaseBefore = modificationState(file);
  fixture.writeTitle('WAL-only rename');
  assert.deepEqual(modificationState(file), databaseBefore, 'the database itself did not change');
  service.scan();
  assert.equal(service.sessions[0].title, 'WAL-only rename');
  assert.equal(reads.queries, 2);
  service.scan();
  assert.equal(reads.queries, 2);

  db.exec('PRAGMA wal_checkpoint(RESTART)');
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(wal, fixedTime, fixedTime);
  service.scan();
  assert.equal(reads.queries, 3, 'checkpoint transitions invalidate the index cache');
  const reusedBefore = modificationState(wal);
  const checkpointedDatabase = modificationState(file);
  fixture.writeTitle('Reused WAL name');
  fs.utimesSync(wal, fixedTime, fixedTime);
  const reusedAfter = modificationState(wal);
  assert.equal(reusedAfter.size, reusedBefore.size);
  assert.equal(reusedAfter.mtime, reusedBefore.mtime);
  assert.notEqual(reusedAfter.ctime, reusedBefore.ctime, 'WAL reuse remains observable when size and mtime match');
  assert.deepEqual(modificationState(file), checkpointedDatabase);
  service.scan();
  assert.equal(service.sessions[0].title, 'Reused WAL name');
  assert.equal(reads.queries, 4);
  service.scan();
  assert.equal(reads.queries, 4);

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(fs.statSync(wal).size, 0);
  service.scan();
  assert.equal(reads.queries, 5);
  fixture.closeDatabase();
  assert.equal(fs.existsSync(wal), false);
  service.scan();
  assert.equal(reads.queries, 6, 'removing the WAL also refreshes the projected metadata');
  assert.equal(fs.statSync(wal).size, 0, 'the read-only SQLite connection recreates an empty WAL');
  service.scan();
  assert.equal(reads.queries, 7, 'the reader-created WAL gets one stable refresh');
  service.scan();
  assert.equal(reads.queries, 7, 'subsequent unchanged scans skip SQLite again');
  assert.equal(service.sessions[0].title, 'Reused WAL name');
});

it('refreshes a replaced database even when its size and mtime are unchanged', (t) => {
  const fixture = indexFixture(t);
  const { service, file } = fixture;
  fixture.closeDatabase();
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, fixedTime, fixedTime);
  const reads = indexReads(t);
  service.scan();
  service.scan();
  assert.equal(reads.queries, 1);
  const before = modificationState(file);
  const replacement = path.join(fixture.dir, 'replacement.vscdb');
  const db = new fixture.DatabaseSync(replacement);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', JSON.stringify({ version: 1, entries: {
    s: { sessionId: 's', title: 'Renamed title', lastMessageDate: 5000 }
  } }));
  db.close();
  fs.renameSync(replacement, file);
  fs.utimesSync(file, fixedTime, fixedTime);
  const after = modificationState(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtime, before.mtime);
  assert.notEqual(after.ino, before.ino);
  service.scan();
  assert.equal(service.sessions[0].title, 'Renamed title');
  assert.equal(reads.queries, 2);
  service.scan();
  assert.equal(reads.queries, 2);
});

it('invalidates deleted index entries and missing databases without retaining deleted sessions', (t) => {
  const fixture = indexFixture(t);
  const { service, db, file } = fixture;
  const reads = indexReads(t);
  service.scan();
  db.prepare('DELETE FROM ItemTable WHERE key = ?').run('chat.ChatSessionStore.index');
  service.scan();
  assert.deepEqual(service.sessions, []);
  assert.equal(reads.queries, 2);
  service.scan();
  assert.equal(reads.queries, 2);
  fixture.writeTitle('Recreated history');
  service.scan();
  assert.equal(service.sessions[0].title, 'Recreated history');
  assert.equal(reads.queries, 3);
  fixture.closeDatabase();
  const backup = path.join(fixture.dir, 'saved.vscdb');
  fs.copyFileSync(file, backup);
  fs.unlinkSync(file);
  service.scan();
  service.scan();
  assert.deepEqual(service.sessions, []);
  assert.equal(reads.queries, 3);
  fs.copyFileSync(backup, file);
  service.scan();
  assert.equal(service.sessions[0].title, 'Recreated history');
  assert.equal(reads.queries, 4);
  service.scan();
  assert.equal(reads.queries, 4);
});

it('evicts cached indexes when a whole workspace directory disappears', (t) => {
  const fixture = indexFixture(t);
  const { service, workspace } = fixture;
  fixture.closeDatabase();
  const reads = indexReads(t);
  service.scan();
  assert.equal(reads.opens, 1);
  const archived = path.join(fixture.dir, 'archived-workspace');
  fs.renameSync(workspace, archived);
  service.scan();
  assert.deepEqual(service.sessions, []);
  assert.equal(reads.opens, 1);
  fs.renameSync(archived, workspace);
  service.scan();
  assert.equal(reads.opens, 2, 'restoring the same files must not reuse an evicted workspace cache');
  assert.equal(service.sessions[0].title, 'History title');
  fs.rmSync(workspace, { recursive: true });
  service.scan();
  assert.deepEqual(service.sessions, []);
});

it('retries malformed indexes and unsupported schemas instead of caching failures', (t) => {
  const fixture = indexFixture(t);
  const { service, warnings, db } = fixture;
  const reads = indexReads(t);
  service.scan();
  fixture.writeRaw(JSON.stringify({ version: 2, entries: {} }));
  service.scan();
  service.scan();
  assert.deepEqual(service.sessions, []);
  assert.equal(reads.opens, 3);
  assert.equal(warnings.length, 1, 'unsupported schema warnings remain deduplicated');
  assert.match(warnings[0], /Unsupported chat-history index/);
  fixture.writeRaw('{');
  service.scan();
  service.scan();
  assert.equal(reads.opens, 5);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /Malformed chat-history index/);
  db.exec('DROP TABLE ItemTable');
  service.scan();
  service.scan();
  assert.equal(reads.opens, 7, 'SQLite schema errors are retried too');
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /no such table/);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  fixture.writeTitle('Recovered history');
  service.scan();
  service.scan();
  assert.equal(service.sessions[0].title, 'Recovered history');
  assert.equal(reads.opens, 8);
  assert.equal(reads.closes, reads.opens);
});

it('retries SQLite and filesystem I/O failures and does not display stale cached metadata', (t) => {
  const fixture = indexFixture(t);
  const { service, file, warnings } = fixture;
  const reads = indexReads(t);
  service.scan();
  fixture.writeTitle('Updated history');
  reads.error = new Error('Index temporarily unreadable');
  service.scan();
  service.scan();
  assert.deepEqual(service.sessions, []);
  assert.equal(reads.opens, 3);
  assert.equal(warnings.length, 1);
  reads.error = undefined;
  service.scan();
  service.scan();
  assert.equal(service.sessions[0].title, 'Updated history');
  assert.equal(reads.opens, 4);
  const statSync = fs.statSync;
  let denied = true;
  t.mock.method(fs, 'statSync', function(candidate, ...options) {
    if (candidate === file && denied) throw Object.assign(new Error('Index stat denied'), { code: 'EACCES' });
    return statSync.call(this, candidate, ...options);
  });
  service.scan();
  service.scan();
  assert.deepEqual(service.sessions, []);
  assert.equal(warnings.length, 2, 'filesystem warnings also remain deduplicated');
  assert.equal(reads.opens, 4);
  denied = false;
  service.scan();
  service.scan();
  assert.equal(service.sessions[0].title, 'Updated history');
  assert.equal(reads.opens, 5, 'a stat error invalidates the previously successful cached read');
  assert.equal(reads.closes, reads.opens);
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
