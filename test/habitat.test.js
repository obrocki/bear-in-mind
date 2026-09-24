'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { it } = require('node:test');
const { createScene } = require('../tools/scene-harness');
const { TokenMeter } = require(path.join(process.env.BEAR_TEST_BUILD, 'tokenMeter.js'));

it('keeps the habitat percentage and token fraction on the same basis', () => {
  const m = new TokenMeter({ get: () => undefined, update: () => Promise.resolve() });
  const scene = createScene(path.resolve(__dirname, '..'), 330, 300);
  try {
    m.observe('transcripts', 2000000, 100000, 1, 293.2);
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '58%');
    assert.equal(scene.els.tokens.textContent, 'Counted 2,100,000 / target 5,000,000 tokens');
    assert.equal(scene.els.basis.textContent, 'local budget remaining');

    m.setContext({ used: 136600, limit: 1000000, model: 'gpt-5.6-sol', atMs: Date.now() });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '86%');
    assert.equal(scene.els.tokens.textContent, 'Prompt used 136,600 / limit 1,000,000 tokens');
    assert.equal(scene.els.basis.textContent, 'latest prompt free');
    assert.match(scene.els.source.textContent, /any session/);
    assert.match(scene.els.split.textContent, /local in 2\.0M/);

    m.setContext({ used: 136600, limit: 1000000, model: null, atMs: Date.now() - 3600000 });
    scene.setState(m.snapshot());
    assert.equal(scene.els.pct.textContent, '58%');
    assert.equal(scene.els.tokens.textContent, 'Counted 2,100,000 / target 5,000,000 tokens');
    assert.equal(scene.els.basis.textContent, 'local budget remaining');
  } finally {
    m.dispose();
  }
});
