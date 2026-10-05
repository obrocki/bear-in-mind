'use strict';

/** Bundles inline separate stubs; share settings through the test process global. */
function current() {
  return globalThis.__BEAR_SETTINGS__ || {};
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => { this.listeners = this.listeners.filter((listener) => listener !== fn); } };
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
        const settings = current();
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
  authentication: {
    getSession: (...args) => globalThis.__BEAR_AUTH_SESSION__?.(...args),
    onDidChangeSessions: (listener) => globalThis.__BEAR_AUTH_EVENTS__?.event(listener) ?? { dispose() {} }
  },
  lm: { selectChatModels: async () => [] }
};
