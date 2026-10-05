'use strict';

// Shared by the typed extension and the build-free canvas; tokenCoverage.d.cts supplies its contract.
class TokenTally {
  constructor() {
    this.fields = Object.fromEntries(
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
        .map((key) => [key, { total: 0, calls: 0 }]),
    );
    this.pairedInput = 0;
    this.pairedCache = 0;
    this.pairedCalls = 0;
  }
  add(values) {
    const reported = {};
    for (const [key, field] of Object.entries(this.fields)) {
      let value = values[key];
      if (typeof value === 'bigint') value = Number(value);
      if (typeof value === 'string') value = value.trim() === '' ? NaN : Number(value);
      reported[key] = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      if (reported[key] !== null) {
        field.total += reported[key];
        field.calls += 1;
      }
    }
    const { inputTokens: input, cacheReadTokens: cached } = reported;
    if (input !== null && cached !== null && cached <= input) {
      this.pairedInput += input;
      this.pairedCache += cached;
      this.pairedCalls += 1;
    }
  }
  totals() {
    return Object.fromEntries(Object.entries(this.fields).map(([key, field]) => [
      key, field.calls ? field.total : null,
    ]));
  }
  coverage(calls) {
    return Object.fromEntries(Object.entries(this.fields).map(([key, field]) => [
      key, { reportedCalls: field.calls, share: calls > 0 ? field.calls / calls : null },
    ]));
  }
  ratioCoverage(calls) {
    return { reportedCalls: this.pairedCalls, share: calls > 0 ? this.pairedCalls / calls : null };
  }
  cacheReadRatio() {
    return this.pairedInput > 0 ? this.pairedCache / this.pairedInput : null;
  }
}

module.exports = { TokenTally };
