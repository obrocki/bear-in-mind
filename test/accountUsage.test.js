'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { it } = require('node:test');
const { ACCOUNT_CONNECTION_KEY, AccountUsageWatcher, parseAccountQuota, requestAccountQuota } = require(path.join(process.env.BEAR_TEST_BUILD, 'accountUsage.js'));
const { RESET_KEY, SealableMemento } = require(path.join(process.env.BEAR_TEST_BUILD, 'restore.js'));

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    keys: () => [...values.keys()],
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    }
  };
}

function response(snapshot = {}, data = {}) {
  return {
    copilot_plan: 'pro',
    token_based_billing: true,
    quota_reset_date: '2026-11-01',
    quota_snapshots: {
      premium_interactions: { entitlement: '1000', percent_remaining: 75, unlimited: false, ...snapshot }
    },
    ...data
  };
}

function watcher(t, api = {}, connected = true) {
  const logs = [];
  const inner = memory(connected ? { [ACCOUNT_CONNECTION_KEY]: { resetAt: 0 } } : {});
  const memento = new SealableMemento(inner, RESET_KEY);
  const service = new AccountUsageWatcher((line) => logs.push(line), memento, {
    session: async () => ({ accessToken: 'secret-token', account: { label: 'octocat' } }),
    request: async () => response(),
    ...api
  });
  t.after(() => { service.dispose(); delete globalThis.__BEAR_SETTINGS__; });
  return { service, logs, inner, memento };
}

it('reads the reported plan and allowance, not a hard-coded plan table or transcript sum', () => {
  const quota = parseAccountQuota(response(), 'octocat', 1234);
  assert.equal(quota.plan, 'pro');
  assert.equal(quota.allowance, 1000);
  assert.equal(quota.used, 250);
  assert.equal(quota.percentRemaining, 75);
  assert.equal(quota.unit, 'credits');
  assert.equal(quota.approximate, true);
  assert.equal(quota.fetchedAtMs, 1234);
  assert.equal(quota.resetAtMs, Date.parse('2026-11-01'));
});

it('uses quota_remaining on the entitlement basis, never credits_used as its numerator', () => {
  const quota = parseAccountQuota(response({
    quota_remaining: 800, percent_remaining: 80, credits_used: 92345
  }), 'octocat');
  assert.equal(quota.used, 200);
  assert.equal(quota.approximate, false);
  assert.equal(quota.creditsUsed, undefined);
});

it('preserves legacy premium-request and free-chat units instead of relabeling them credits', () => {
  assert.equal(parseAccountQuota(response({}, { token_based_billing: false }), 'o').unit, 'premium requests');
  const free = parseAccountQuota({
    copilot_plan: 'free',
    quota_snapshots: {
      premium_interactions: { entitlement: 0, unlimited: false },
      chat: { entitlement: 50, percent_remaining: 40, unlimited: false }
    }
  }, 'o');
  assert.equal(free.unit, 'chat requests');
  assert.equal(free.allowance, 50);
  assert.equal(free.used, 30);
});

it('keeps pooled and unlimited plans denominator-free, including exhaustion', () => {
  const quota = parseAccountQuota(response({
    entitlement: '-1', unlimited: true, credits_used: 456.7, has_quota: false
  }), 'o');
  assert.equal(quota.unlimited, true);
  assert.equal(quota.hasQuota, false);
  assert.equal(quota.creditsUsed, 456.7);
  assert.equal(quota.allowance, undefined);
  assert.equal(quota.used, undefined);
});

it('prefers the category reset timestamp and leaves missing allowance counts unknown', () => {
  const quota = parseAccountQuota(response({
    quota_reset_at: 1800000000, entitlement: undefined
  }), 'o');
  assert.equal(quota.resetAtMs, 1800000000000);
  assert.equal(quota.allowance, undefined);
  assert.equal(quota.used, undefined);
  assert.equal(quota.percentRemaining, 75);
});

it('rejects malformed API schemas and invalid numbers without inventing a free allowance', () => {
  for (const raw of [null, {}, response({ percent_remaining: NaN }), response({ unlimited: 'false' }),
    response({ percent_remaining: Infinity }), response({}, { quota_reset_date: 'not a date' })]) {
    assert.throws(() => parseAccountQuota(raw, 'o'), /GitHub/);
  }
  assert.equal(parseAccountQuota(response({ percent_remaining: 0 }), 'o').used, 1000);
  assert.equal(parseAccountQuota(response({ percent_remaining: -1 }), 'o').percentRemaining, 0);
});

it('rejects finite reset timestamps outside the Date range and seconds-to-milliseconds overflow', () => {
  for (const quota_reset_at of [8640000000001, Number.MAX_VALUE, '8640000000001']) {
    assert.throws(() => parseAccountQuota(response({ quota_reset_at }), 'o'), /invalid Copilot allowance reset date/);
  }
  const quota = parseAccountQuota(response({ quota_reset_at: 8640000000000 }), 'o');
  assert.equal(quota.resetAtMs, 8640000000000000);
  assert.doesNotThrow(() => new Date(quota.resetAtMs).toISOString());
});

it('only uses an authorized session and keeps account usage out of persisted local ledgers', async (t) => {
  let interactive;
  const { service, logs } = watcher(t, {
    session: async (value) => { interactive = value; return { accessToken: 'secret-token', account: { label: 'o' } }; },
    request: async (token, signal) => {
      assert.equal(token, 'secret-token');
      assert.equal(signal.aborted, false);
      return response();
    }
  });
  await service.refresh(true);
  assert.equal(interactive, true);
  assert.equal(service.snapshot.status, 'ready');
  assert.equal(service.snapshot.quota.login, 'o');
  assert.doesNotMatch(JSON.stringify({ logs, state: service.snapshot }), /secret-token/);
});

it('does not make network requests without sign-in or when disabled', async (t) => {
  let calls = 0;
  const { service } = watcher(t, { session: async () => undefined, request: async () => { calls++; } });
  await service.refresh();
  assert.equal(service.snapshot.status, 'signedOut');
  globalThis.__BEAR_SETTINGS__ = { 'iceberg.accountUsage.enabled': false };
  await service.refresh();
  assert.equal(service.snapshot.status, 'disabled');
  assert.equal(calls, 0);
});

it('surfaces failures, clears old account figures, and never logs arbitrary error contents', async (t) => {
  let fail = false;
  const { service, logs } = watcher(t, {
    request: async () => {
      if (fail) throw new Error('Authorization: secret-token; private server body');
      return response();
    }
  });
  await service.refresh();
  fail = true;
  await service.refresh();
  assert.equal(service.snapshot.status, 'error');
  assert.equal(service.snapshot.quota, undefined);
  assert.match(service.snapshot.message, /failed/);
  assert.doesNotMatch(JSON.stringify(logs), /secret-token|private server body/);
});

it('prevents an obsolete in-flight response from overwriting a new refresh or disposal', async (t) => {
  let finish;
  let calls = 0;
  const { service } = watcher(t, {
    request: async () => ++calls === 1 ? new Promise((resolve) => { finish = resolve; }) : response({ percent_remaining: 40 })
  });
  const first = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await service.refresh(true);
  finish(response({ percent_remaining: 99 }));
  await first;
  assert.equal(service.snapshot.quota.percentRemaining, 40);
  service.dispose();
  await service.refresh();
  assert.equal(calls, 2);
});

it('checks existing GitHub sign-in silently without prompting during background refresh', async (t) => {
  const calls = [];
  globalThis.__BEAR_AUTH_SESSION__ = async (_, scopes, options) => {
    calls.push({ scopes, options });
    return options.createIfNone ? { accessToken: 'secret-token', account: { label: 'o' } } : undefined;
  };
  const memento = new SealableMemento(memory({ [ACCOUNT_CONNECTION_KEY]: { resetAt: 0 } }), RESET_KEY);
  const service = new AccountUsageWatcher(() => {}, memento);
  t.after(() => { service.dispose(); delete globalThis.__BEAR_AUTH_SESSION__; });
  await service.refresh();
  assert.equal(service.snapshot.status, 'signedOut');
  assert.ok(calls.every((call) => call.options.silent));
});

it('requires an explicit connection on first use even with an existing GitHub grant, then polls that connection', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [];
  let requests = 0;
  const { service, inner } = watcher(t, {
    session: async (interactive) => {
      sessions.push(interactive);
      return { accessToken: 'secret-token', account: { label: 'existing-account' } };
    },
    request: async () => { requests++; return response(); }
  }, false);
  service.start();
  t.mock.timers.tick(120000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.snapshot.status, 'signedOut');
  assert.deepEqual(sessions, []);
  assert.equal(requests, 0);
  assert.equal(inner.get(ACCOUNT_CONNECTION_KEY), undefined);

  await service.refresh(true);
  assert.equal(service.snapshot.status, 'ready');
  assert.deepEqual(inner.get(ACCOUNT_CONNECTION_KEY), { resetAt: 0 });
  t.mock.timers.tick(60000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sessions, [true, false]);
  assert.equal(requests, 2);
});

it('enabling does not opt in, while disabling cancels pending work and preserves an explicit connection for re-enabling', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let requests = 0;
  let finish;
  let pendingSignal;
  const { service, inner } = watcher(t, {
    request: async (_, signal) => {
      requests++;
      if (requests === 2) {
        pendingSignal = signal;
        return new Promise((resolve) => { finish = resolve; });
      }
      return response();
    }
  }, false);
  globalThis.__BEAR_SETTINGS__ = { 'iceberg.accountUsage.enabled': false };
  service.start();
  await service.refresh(true);
  assert.equal(service.snapshot.status, 'disabled');
  assert.equal(inner.get(ACCOUNT_CONNECTION_KEY), undefined);
  assert.equal(requests, 0);

  globalThis.__BEAR_SETTINGS__ = { 'iceberg.accountUsage.enabled': true };
  service.start();
  assert.equal(service.snapshot.status, 'signedOut');
  assert.equal(requests, 0);
  await service.refresh(true);
  assert.equal(service.snapshot.status, 'ready');
  const pending = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.__BEAR_SETTINGS__ = { 'iceberg.accountUsage.enabled': false };
  service.start();
  assert.equal(pendingSignal.aborted, true);
  assert.equal(service.snapshot.status, 'disabled');
  assert.equal(service.snapshot.quota, undefined);
  finish(response({ percent_remaining: 99 }));
  await pending;
  t.mock.timers.tick(120000);
  assert.equal(requests, 2);
  assert.deepEqual(inner.get(ACCOUNT_CONNECTION_KEY), { resetAt: 0 });

  globalThis.__BEAR_SETTINGS__ = { 'iceberg.accountUsage.enabled': true };
  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.snapshot.status, 'ready');
  assert.equal(service.snapshot.quota.percentRemaining, 75);
  assert.equal(requests, 3);
});

it('does not store an opt-in when an explicit sign-in is dismissed', async (t) => {
  const { service, inner } = watcher(t, { session: async () => undefined }, false);
  await service.refresh(true);
  assert.equal(service.snapshot.status, 'signedOut');
  assert.equal(inner.get(ACCOUNT_CONNECTION_KEY), undefined);
});

it('remembers explicit consent across reloads but invalidates it when a reset keeps other stored data', async (t) => {
  let sessions = 0;
  const api = {
    session: async () => {
      sessions++;
      return { accessToken: 'secret-token', account: { label: 'existing-account' } };
    },
    request: async () => response()
  };
  const { service, inner, memento } = watcher(t, api, false);
  await service.refresh(true);
  service.dispose();
  const reloaded = new AccountUsageWatcher(() => {}, new SealableMemento(inner, RESET_KEY), api);
  t.after(() => reloaded.dispose());
  await reloaded.refresh();
  assert.equal(reloaded.snapshot.status, 'ready');
  assert.equal(sessions, 2, 'the saved opt-in permits automatic refresh after an ordinary reload');

  await memento.seal(42);
  await reloaded.refresh();
  assert.equal(reloaded.snapshot.status, 'signedOut');
  assert.equal(reloaded.snapshot.quota, undefined, 'another window clears its ready quota when it observes the reset');
  assert.deepEqual(inner.get(ACCOUNT_CONNECTION_KEY), { resetAt: 0 }, 'failed restores can keep stored data for retry');
  const afterReset = new AccountUsageWatcher(() => {}, new SealableMemento(inner, RESET_KEY), api);
  t.after(() => afterReset.dispose());
  await afterReset.refresh();
  assert.equal(afterReset.snapshot.status, 'signedOut');
  assert.equal(sessions, 2, 'retained opt-in from the old reset generation must not reconnect');
});

it('drops a sign-in that completes after the shared store is sealed by a reset', async (t) => {
  let finish;
  let requests = 0;
  const { service, inner, memento } = watcher(t, {
    session: async () => new Promise((resolve) => { finish = resolve; }),
    request: async () => { requests++; return response(); }
  }, false);
  const pending = service.refresh(true);
  await memento.seal(42);
  finish({ accessToken: 'secret-token', account: { label: 'existing-account' } });
  await pending;
  assert.equal(service.snapshot.status, 'signedOut');
  assert.equal(inner.get(ACCOUNT_CONNECTION_KEY), undefined);
  assert.equal(requests, 0);
  await service.refresh(true);
  assert.equal(requests, 0, 'a sealed window must reload before reconnecting');
});

it('a delayed opt-in write cannot authorize a reloaded window after a reset', async (t) => {
  const { service, inner, memento } = watcher(t, {}, false);
  let finish;
  const update = inner.update;
  inner.update = (key, value) => key === ACCOUNT_CONNECTION_KEY && value !== undefined
    ? new Promise((resolve) => { finish = async () => { await update(key, value); resolve(); }; })
    : update(key, value);
  const pending = service.refresh(true);
  await new Promise((resolve) => setImmediate(resolve));
  await memento.clear(42);
  await finish();
  await pending;
  assert.equal(service.snapshot.status, 'signedOut');
  assert.deepEqual(inner.get(ACCOUNT_CONNECTION_KEY), { resetAt: 0 }, 'simulate a stale write finishing after the deletion');
  const reloaded = new AccountUsageWatcher(() => {}, new SealableMemento(inner, RESET_KEY), {
    session: async () => assert.fail('the old reset epoch is not a current connection'),
    request: async () => assert.fail('a restored window must not request account usage')
  });
  t.after(() => reloaded.dispose());
  await reloaded.refresh();
  assert.equal(reloaded.snapshot.status, 'signedOut');
});

function authEvents(t) {
  const emitter = new EventEmitter();
  globalThis.__BEAR_AUTH_EVENTS__ = { event: (listener) => {
    emitter.on('change', listener);
    return { dispose: () => emitter.removeListener('change', listener) };
  } };
  t.after(() => delete globalThis.__BEAR_AUTH_EVENTS__);
  return () => emitter.emit('change', { provider: { id: 'github' } });
}

it('does not cancel an explicit sign-in when creating its session emits an authentication event', async (t) => {
  const changed = authEvents(t);
  let calls = 0;
  const { service } = watcher(t, {
    session: async (interactive) => {
      calls++;
      if (!interactive) return undefined;
      changed();
      return { accessToken: 'secret-token', account: { label: 'new-account' } };
    }
  });
  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  await service.refresh(true);
  assert.equal(service.snapshot.status, 'ready');
  assert.equal(service.snapshot.quota.login, 'new-account');
  assert.equal(calls, 2, 'the sign-in event must not start a competing silent refresh');
});

it('invalidates old account data on account changes and ignores the old in-flight response', async (t) => {
  const changed = authEvents(t);
  let login = 'old-account';
  let finish;
  let requests = 0;
  const { service } = watcher(t, {
    session: async () => ({ accessToken: 'secret-token', account: { label: login } }),
    request: async () => ++requests === 1 ? new Promise((resolve) => { finish = resolve; }) : response()
  });
  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  login = 'new-account';
  changed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.snapshot.quota.login, 'new-account');
  finish(response({ percent_remaining: 99 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.snapshot.quota.login, 'new-account');
  assert.equal(service.snapshot.quota.percentRemaining, 75);
  service.stop();
  changed();
  assert.equal(requests, 2, 'a stopped watcher must not restart on authentication events');
});

function transport(t, status, chunks = [], neverEnd = false) {
  const req = new EventEmitter();
  req.destroy = (error) => { if (error) req.emit('error', error); req.emit('close'); };
  const res = new EventEmitter();
  res.statusCode = status;
  res.resume = () => queueMicrotask(() => req.emit('close'));
  t.mock.method(https, 'get', (url, options, callback) => {
    assert.equal(url, 'https://api.github.com/copilot_internal/user');
    assert.equal(options.headers.Authorization, 'token test-secret');
    assert.ok(options.signal);
    queueMicrotask(() => {
      callback(res);
      if (status === 200) {
        for (const chunk of chunks) res.emit('data', Buffer.from(chunk));
        if (!neverEnd) {
          res.emit('end');
          req.emit('close');
        }
      }
    });
    return req;
  });
  return req;
}

it('reads only the fixed GitHub quota origin and accepts a bounded successful response', async (t) => {
  transport(t, 200, [JSON.stringify(response())]);
  const raw = await requestAccountQuota('test-secret', new AbortController().signal);
  assert.equal(raw.copilot_plan, 'pro');
});

it('reports HTTP failures without consuming/logging bodies or following redirects', async (t) => {
  for (const status of [401, 403, 404, 302, 429]) {
    transport(t, status);
    await assert.rejects(requestAccountQuota('test-secret', new AbortController().signal), new RegExp(`HTTP ${status}`));
  }
});

it('rejects oversized and malformed quota responses explicitly', async (t) => {
  transport(t, 200, ['x'.repeat(1024 * 1024 + 1)]);
  await assert.rejects(requestAccountQuota('test-secret', new AbortController().signal), /reading limit/);
  transport(t, 200, ['{"private": invalid secret']);
  await assert.rejects(requestAccountQuota('test-secret', new AbortController().signal), /malformed quota data/);
});

it('enforces an absolute request deadline, not just a socket inactivity timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  transport(t, 200, ['{'], true);
  const result = requestAccountQuota('test-secret', new AbortController().signal);
  const rejection = assert.rejects(result, /timed out/);
  t.mock.timers.tick(10001);
  await rejection;
});
