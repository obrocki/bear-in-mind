/**
 * Model climate: the habitat's weather shows the pace of the model in use, in
 * credits. Pure — no `vscode`, no I/O — so the mapping is testable.
 *
 * The ice (allowance) is unaffected. Weight comes only from reported credits
 * per call; a model without enough reported calls has no climate, which the
 * renderer draws as today's neutral scene rather than as a small model.
 *
 * A call whose reported endpoint is on this machine (or a host the user lists
 * as local) leaves the credit scale: the habitat gets a clear aurora night and
 * a happy bear. Locality comes only from the reported `server.address`, never
 * from zero credits, model names or bring-your-own-key status.
 */

import type { CallTally, LatestCall } from './otelSummary';

/** A latest call older than this no longer describes the model in use. */
export const CLIMATE_STALE_MS = 30 * 60 * 1000;
/** Credit-reporting calls needed before one model's average is trusted. */
export const CLIMATE_MIN_CREDIT_CALLS = 3;
/**
 * Fixed log-scale anchors in AI credits per call, so a model always gets the
 * same weather. Calibrated against retained Copilot Chat traces (October 2026):
 * gpt-4o-mini 0, gpt-5.6-luna ~0.1, gpt-5.3-codex ~0.6, gpt-5.6-sol ~8 and
 * claude-opus-5.5 ~19 credits per call. Per-call credits also grow with the
 * prompt, so this is the model's pace as used, not a price list.
 */
export const CREDITS_PER_CALL_LOW = 0.05;
export const CREDITS_PER_CALL_HIGH = 25;
/** Prompt limits mapped to the context level: 32k tokens -> 0, 1M -> 1. */
const CONTEXT_LOW = 32_000;
const CONTEXT_HIGH = 1_000_000;

export type ClimateBand = 'snowy' | 'mild' | 'thawing' | 'aurora';

/** `loopback`: this machine. `configured`: a host listed in `iceberg.climate.localHosts`. */
export type LocalEndpoint = 'loopback' | 'configured';

export interface Climate {
  model: string;
  /**
   * Average reported credits per credit-reporting call of this model. For a
   * local endpoint with no credit-reporting calls this is 0 with `sampleCalls` 0.
   */
  creditsPerCall: number;
  /** Calls that reported credits; calls without credits are excluded, not zero. */
  sampleCalls: number;
  /** 0 (lightest pace) .. 1 (heaviest pace); 0 for a local endpoint. */
  weight: number;
  band: ClimateBand;
  /** Present only when the latest call went to a local endpoint (band `aurora`). */
  local?: LocalEndpoint;
  /** That local endpoint's host name; never set for other endpoints. */
  host?: string;
  effort?: string;
  /** 0..1, absent when the effort is unreported or unrecognised. */
  effortLevel?: number;
  contextLimit?: number;
  /** 0..1, absent when the prompt limit is unreported. */
  contextLevel?: number;
  atMs: number;
  sessionId?: string;
}

const EFFORT_LEVELS: Record<string, number> = {
  none: 0, minimal: 0, low: 0.2, medium: 0.5, high: 0.8, xhigh: 0.9, max: 1
};

/** Maps credits per call onto 0..1 between the fixed anchors. */
export function creditWeight(creditsPerCall: number): number {
  if (!(creditsPerCall > CREDITS_PER_CALL_LOW)) {
    return 0;
  }
  if (creditsPerCall >= CREDITS_PER_CALL_HIGH) {
    return 1;
  }
  return Math.log(creditsPerCall / CREDITS_PER_CALL_LOW) / Math.log(CREDITS_PER_CALL_HIGH / CREDITS_PER_CALL_LOW);
}

export function climateBand(weight: number): Exclude<ClimateBand, 'aurora'> {
  return weight < 1 / 3 ? 'snowy' : weight < 2 / 3 ? 'mild' : 'thawing';
}

export function effortLevel(effort: string | undefined): number | undefined {
  return effort !== undefined && Object.prototype.hasOwnProperty.call(EFFORT_LEVELS, effort)
    ? EFFORT_LEVELS[effort] : undefined;
}

export function contextLevel(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  const level = Math.log(limit / CONTEXT_LOW) / Math.log(CONTEXT_HIGH / CONTEXT_LOW);
  return Math.min(1, Math.max(0, level));
}

function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/** The eight 16-bit groups of an IPv6 address, which may end in dotted IPv4; undefined if malformed. */
function ipv6Groups(host: string): number[] | undefined {
  let h = host;
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((octet) => octet > 255)) {
      return undefined;
    }
    h = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  if (!h.includes(':') || !/^[0-9a-f:]+$/.test(h)) {
    return undefined;
  }
  const halves = h.split('::');
  const groups = (s: string) => (s ? s.split(':') : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (halves.length > 2 || (halves.length === 2 && head.length + tail.length > 7)) {
    return undefined;
  }
  const all = halves.length === 2 ? [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head;
  return all.length === 8 && all.every((g) => g.length > 0 && g.length <= 4) ? all.map((g) => parseInt(g, 16)) : undefined;
}

/**
 * `::1`, or 127.0.0.0/8 mapped into IPv6, in any spelling: `0::1`,
 * `::ffff:127.0.0.1`, or `::ffff:7f00:1` as URL parsing serialises it.
 */
function isIpv6Loopback(host: string): boolean {
  const g = ipv6Groups(host);
  if (!g) {
    return false;
  }
  const zeros = (n: number) => g.slice(0, n).every((group) => group === 0);
  return (zeros(7) && g[7] === 1) || (zeros(5) && g[5] === 0xffff && g[6] >> 8 === 0x7f);
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 (also IPv4-mapped) and `::1`: this machine. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (typeof host !== 'string') {
    return false;
  }
  const h = normalHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true;
  }
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return v4 ? v4.slice(1).every((octet) => Number(octet) <= 255) : isIpv6Loopback(h);
}

/**
 * Whether a model endpoint is local: a loopback host, or an exact,
 * case-insensitive match for a host the user listed. No suffix or wildcard
 * matching, so listing `gpu-box.lan` never makes `a.gpu-box.lan` local.
 */
export function localEndpoint(host: string | undefined, localHosts: readonly unknown[] = []): LocalEndpoint | undefined {
  if (typeof host !== 'string' || host.trim() === '') {
    return undefined;
  }
  if (isLoopbackHost(host)) {
    return 'loopback';
  }
  const h = normalHost(host);
  return localHosts.some((entry) => typeof entry === 'string' && entry.trim() !== '' && normalHost(entry) === h)
    ? 'configured' : undefined;
}

/**
 * The climate for the latest model call, weighted by that model's reported
 * credits across retained calls. Undefined (neutral) when the call is missing,
 * stale or from the future, the model is unknown, or too few calls reported credits.
 * A call to a local endpoint is the `aurora` band instead and needs no credits.
 */
export function climateFor(
  call: LatestCall | undefined,
  byModel: readonly CallTally[],
  nowMs: number = Date.now(),
  localHosts: readonly unknown[] = []
): Climate | undefined {
  if (!call || !call.model || !Number.isFinite(call.atMs) || call.atMs > nowMs || nowMs - call.atMs > CLIMATE_STALE_MS) {
    return undefined;
  }
  const tally = byModel.find((row) => row.key === call.model);
  const reported = !!tally && Number.isFinite(tally.credits) && tally.credits >= 0;
  const local = localEndpoint(call.host, localHosts);
  if (local) {
    const sampleCalls = reported ? tally.creditCalls : 0;
    return {
      model: call.model,
      creditsPerCall: sampleCalls > 0 ? tally!.credits / sampleCalls : 0,
      sampleCalls,
      weight: 0,
      band: 'aurora',
      local,
      host: normalHost(call.host!),
      effort: call.effort,
      effortLevel: effortLevel(call.effort),
      contextLimit: call.promptLimit,
      contextLevel: contextLevel(call.promptLimit),
      atMs: call.atMs,
      sessionId: call.sessionId
    };
  }
  if (!reported || tally.creditCalls < CLIMATE_MIN_CREDIT_CALLS) {
    return undefined;
  }
  const creditsPerCall = tally.credits / tally.creditCalls;
  const weight = creditWeight(creditsPerCall);
  return {
    model: call.model,
    creditsPerCall,
    sampleCalls: tally.creditCalls,
    weight,
    band: climateBand(weight),
    effort: call.effort,
    effortLevel: effortLevel(call.effort),
    contextLimit: call.promptLimit,
    contextLevel: contextLevel(call.promptLimit),
    atMs: call.atMs,
    sessionId: call.sessionId
  };
}
