/**
 * Model climate: the habitat's weather shows the pace of the model in use, in
 * credits. Pure — no `vscode`, no I/O — so the mapping is testable.
 *
 * The ice (allowance) is unaffected. Weight comes only from reported credits
 * per call; a model without enough reported calls has no climate, which the
 * renderer draws as today's neutral scene rather than as a small model.
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

export type ClimateBand = 'snowy' | 'mild' | 'thawing';

export interface Climate {
  model: string;
  /** Average reported credits per credit-reporting call of this model. */
  creditsPerCall: number;
  /** Calls that reported credits; calls without credits are excluded, not zero. */
  sampleCalls: number;
  /** 0 (lightest pace) .. 1 (heaviest pace). */
  weight: number;
  band: ClimateBand;
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

export function climateBand(weight: number): ClimateBand {
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

/**
 * The climate for the latest model call, weighted by that model's reported
 * credits across retained calls. Undefined (neutral) when the call is missing,
 * stale or from the future, the model is unknown, or too few calls reported credits.
 */
export function climateFor(call: LatestCall | undefined, byModel: readonly CallTally[], nowMs: number = Date.now()): Climate | undefined {
  if (!call || !call.model || !Number.isFinite(call.atMs) || call.atMs > nowMs || nowMs - call.atMs > CLIMATE_STALE_MS) {
    return undefined;
  }
  const tally = byModel.find((row) => row.key === call.model);
  if (!tally || tally.creditCalls < CLIMATE_MIN_CREDIT_CALLS || !Number.isFinite(tally.credits) || tally.credits < 0) {
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
