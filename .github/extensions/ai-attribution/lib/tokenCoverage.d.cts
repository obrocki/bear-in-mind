export type TokenField = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens';

export interface ReportingCoverage {
  reportedCalls: number;
  share: number | null;
}

export class TokenTally {
  add(values: Partial<Record<TokenField, unknown>>): void;
  totals(): Record<TokenField, number | null>;
  coverage(calls: number): Record<TokenField, ReportingCoverage>;
  ratioCoverage(calls: number): ReportingCoverage;
  cacheReadRatio(): number | null;
}
