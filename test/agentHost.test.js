'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { agentHostDbKeepsExporter, agentHostTracesDbPath } = require(path.join(process.env.BEAR_TEST_BUILD, 'agentHost.js'));

it('locates the Agent Host trace store under VS Code user data, from extension global storage', () => {
  const userData = path.resolve('/portable/user-data');
  const expected = path.join(userData, 'agent-host', 'otel', 'agent-host-traces.db');
  assert.equal(agentHostTracesDbPath(path.join(userData, 'User', 'globalStorage', 'obrocki.bear-in-mind')), expected);
  assert.equal(
    agentHostTracesDbPath(path.join(userData, 'User', 'profiles', '-6f2a1c', 'globalStorage', 'obrocki.bear-in-mind')),
    expected,
    'a named profile shares the user-data Agent Host store'
  );
});

it('turns on Agent Host DB mode only where an external trace destination keeps receiving traces', () => {
  assert.equal(agentHostDbKeepsExporter({}), true, 'no collector, nothing to lose');
  assert.equal(agentHostDbKeepsExporter({ endpoint: '  ' }), true);
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://localhost:4318' }), true, 'OTLP/HTTP JSON is forwarded by default');
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://c:4318', exporterType: 'otlp-http', protocol: 'http/json' }), true);
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://c:4318', protocol: 'http/protobuf' }), false);
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://c:4317', exporterType: 'otlp-grpc' }), false);
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://c:4317', protocol: 'GRPC' }), false);
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://c:4318', exporterType: 'file' }), true);
  assert.equal(agentHostDbKeepsExporter({ endpoint: 'http://c:4318', exporterType: 'console' }), true);
});
