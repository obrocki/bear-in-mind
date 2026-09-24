'use strict';

/**
 * Minimal `vscode` stand-in, so the accounting in `src/tokenMeter.ts` can be
 * tested with plain Node.
 *
 * Only the handful of surfaces the meter actually touches are implemented. It
 * is the riskiest file in the project and the one place a mistake silently
 * charges the wrong number, so leaving it uncovered because it imports `vscode`
 * was not a good enough reason.
 */

let settings = {};

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const fn of this.listeners.slice()) fn(value);
  }
  dispose() {
    this.listeners.length = 0;
  }
}

const workspace = {
  getConfiguration(section) {
    return {
      get(key, fallback) {
        const full = section ? `${section}.${key}` : key;
        return Object.prototype.hasOwnProperty.call(settings, full) ? settings[full] : fallback;
      }
    };
  },
  onDidChangeConfiguration() {
    return { dispose: () => {} };
  }
};

module.exports = {
  EventEmitter,
  workspace,
  lm: { selectChatModels: async () => [] },
  /** Test helper: replace the backing settings map. */
  __setSettings(next) {
    settings = next || {};
  }
};
