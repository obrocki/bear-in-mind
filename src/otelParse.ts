/**
 * Pure OTel parsing; otelWatcher owns I/O. The JSONL feed mixes cumulative
 * metric snapshots, log events and empty SDK v2 spans (private fields do not
 * stringify). Keep each metric series' newest value, not the sum of exports.
 * Exact span details come from the trace store.
 */

/** Seconds/nanoseconds pair, as the OTel SDK serialises timestamps. */
export type HrTime = [number, number];

export type RecordKind = 'metrics' | 'log' | 'span' | 'unknown';

export interface LogEvent {
  /** `event.name` when present, else the record body. */
  name: string;
  timeMs: number;
  attributes: Record<string, unknown>;
}

export interface HistogramValue {
  min?: number;
  max?: number;
  sum: number;
  count: number;
  boundaries: number[];
  counts: number[];
}

/** Counts of each record shape seen, so a format change is visible not silent. */
export interface FeedStats {
  metrics: number;
  logs: number;
  spans: number;
  unknown: number;
  malformed: number;
  lastRecordAtMs: number;
  lastTokenUsageAtMs: number;
}

export function emptyStats(): FeedStats {
  return { metrics: 0, logs: 0, spans: 0, unknown: 0, malformed: 0, lastRecordAtMs: 0, lastTokenUsageAtMs: 0 };
}

// ------------------------------------------------------------------ parsing --

export function hrToMs(hr: unknown): number {
  if (Array.isArray(hr) && hr.length >= 2) {
    const s = Number(hr[0]);
    const ns = Number(hr[1]);
    if (Number.isFinite(s) && Number.isFinite(ns)) {
      return s * 1000 + ns / 1e6;
    }
  }
  return 0;
}

export function classify(record: unknown): RecordKind {
  if (!record || typeof record !== 'object') {
    return 'unknown';
  }
  const r = record as Record<string, unknown>;
  if (Array.isArray(r.scopeMetrics)) {
    return 'metrics';
  }
  // A span serialises to `{}` under SDK v2. Anything else with no recognisable
  // payload is genuinely unknown, so only the empty case counts as a span.
  if (Object.keys(r).length === 0) {
    return 'span';
  }
  if (r.attributes !== undefined || r._body !== undefined || r.body !== undefined) {
    return 'log';
  }
  return 'unknown';
}

/** Resource attributes, which the SDK serialises as `[[key, value], …]`. */
export function resourceAttributes(record: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = (record as { resource?: { _rawAttributes?: unknown; attributes?: unknown } })?.resource;
  if (!raw) {
    return out;
  }
  if (Array.isArray(raw._rawAttributes)) {
    for (const pair of raw._rawAttributes) {
      if (Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === 'string') {
        out[pair[0]] = String(pair[1]);
      }
    }
  } else if (raw.attributes && typeof raw.attributes === 'object') {
    for (const [k, v] of Object.entries(raw.attributes as Record<string, unknown>)) {
      out[k] = String(v);
    }
  }
  return out;
}

/** Known captured-content fields must not reach retained events or aggregates. */
const CONTENT_ATTRIBUTES = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result'
]);

/** Nothing this parser needs is a long string; anything that big is content. */
const MAX_ATTRIBUTE_CHARS = 512;

/** The reviver removes content from parsed records; it cannot prevent transient JSON allocations. */
function dropContent(key: string, value: unknown): unknown {
  if (CONTENT_ATTRIBUTES.has(key)) {
    return undefined;
  }
  if (typeof value === 'string' && value.length > MAX_ATTRIBUTE_CHARS) {
    return undefined;
  }
  return value;
}

function scrub(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (CONTENT_ATTRIBUTES.has(key)) {
      continue;
    }
    // Belt and braces: a future content attribute under a name we do not know
    // yet should still not be retained.
    if (typeof value === 'string' && value.length > MAX_ATTRIBUTE_CHARS) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function toLogEvent(record: unknown): LogEvent | undefined {
  const r = record as Record<string, unknown>;
  const raw = (r.attributes && typeof r.attributes === 'object' ? r.attributes : {}) as Record<
    string,
    unknown
  >;
  const body = r._body ?? r.body;
  const named = raw['event.name'];
  const name = typeof named === 'string' ? named : typeof body === 'string' ? body : '';
  if (!name) {
    return undefined;
  }
  const timeMs = hrToMs(r._hrTime ?? r.hrTime ?? r._hrTimeObserved);
  return { name, timeMs, attributes: scrub(raw) };
}

/** Stable key for an attribute set, so the same series lands in the same slot. */
export function attrKey(attributes: Record<string, unknown>): string {
  const keys = Object.keys(attributes).sort();
  return keys.map((k) => `${k}=${String(attributes[k])}`).join('\u0001');
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// -------------------------------------------------------------- aggregation --

/**
 * One cumulative series.
 *
 * `last` is the newest reported value. `retired` banks earlier runs: a
 * cumulative counter only ever grows, so a value going *down* means the
 * producing process restarted and the counter began again from zero. Banking
 * the previous peak keeps that history instead of losing it — the same trick
 * `chatWatcher.ts` uses for reused request slots.
 */
interface Series {
  metric: string;
  attributes: Record<string, unknown>;
  last: number;
  retired: number;
  /** Histogram companions to `last`, tracked the same way. */
  lastCount: number;
  retiredCount: number;
  /**
   * Cumulative amount already represented in the sealed aggregate.
   *
   * Set when a series resumes after its history was sealed. The incoming value
   * is cumulative and still contains that history, so it is discounted here
   * rather than counted in both places.
   */
  rebase: number;
  rebaseCount: number;
  min?: number;
  max?: number;
  boundaries?: number[];
  counts?: number[];
  /** Bucket counts banked from finished runs, so quantiles keep their history. */
  retiredCounts?: number[];
  updatedAtMs: number;
}

function newSeries(metric: string, attributes: Record<string, unknown>, atMs: number): Series {
  return {
    metric,
    attributes,
    last: 0,
    retired: 0,
    lastCount: 0,
    retiredCount: 0,
    rebase: 0,
    rebaseCount: 0,
    updatedAtMs: atMs
  };
}

/** What a series contributes to a total, once sealed history is discounted. */
function contribution(s: Series): number {
  return s.retired + s.last - s.rebase;
}

function contributionCount(s: Series): number {
  return s.retiredCount + s.lastCount - s.rebaseCount;
}

export interface TokenBucket {
  tMs: number;
  input: number;
  output: number;
}

/** Keep memory bounded when a long-lived window accumulates many series. */
const MAX_SERIES = 4000;
/** Evicted series kept aside so a reappearing one can be rebased, not re-added. */
const MAX_FOLDED = 4000;
/**
 * High-water marks kept for series sealed out of `folded`.
 *
 * A key and two numbers each, so tens of thousands cost a couple of megabytes —
 * cheap enough to keep the rebase correct for any realistic feed, capped so it
 * cannot grow for ever.
 */
const MAX_SEALED_MARKS = 50_000;
const MAX_EVENTS = 2000;
const MAX_BUCKETS = 240;

/**
 * Accumulates the feed into queryable rollups.
 *
 * Every series is keyed by `session.id` as well as metric name and attributes.
 * `session.id` is unique per VS Code window, so two windows exporting at once
 * stay separate and their totals add rather than fighting over one slot.
 */
export class OtelRollup {
  readonly stats: FeedStats = emptyStats();

  private readonly series = new Map<string, Series>();
  /**
   * Series evicted under the cap, collapsed and kept out of the live map.
   *
   * They keep their attributes: folding by metric name alone would add an
   * evicted input-token series to the output-token query as well, because
   * `total()` applies its filter to the live series but not to a bare number.
   */
  private readonly folded = new Map<string, Series>();
  /**
   * Compact high-water marks for series folded out of `folded` under
   * `MAX_FOLDED`. Just the banked totals, not the full series (histogram
   * buckets and all), so this can be kept around cheaply and indefinitely —
   * dropping it outright would let a later export for the same key start
   * from zero and have its full cumulative value added again by `total()`.
   */
  /**
   * History sealed out of `folded` under `MAX_FOLDED`, aggregated by metric and
   * attributes so it still answers queries, plus the high-water mark each
   * sealed key had reached.
   *
   * Both halves are needed. Without the aggregate the sealed tokens vanish from
   * `total()` and the feed undercounts; without the per-key mark a later export
   * for that key — cumulative, so it still carries that history — would be
   * added on top of the aggregate and counted twice.
   */
  private readonly sealed = new Map<string, Series>();
  private readonly sealedMarks = new Map<string, { value: number; count: number; aggKey: string }>();
  private readonly events: LogEvent[] = [];
  /** Fixed instrument/outcome keys, independent of the bounded recent-event buffer. */
  private readonly eventSeries = new Map<string, Series>();
  private buckets: TokenBucket[] = [];
  private lastTokenTotals = { input: 0, output: 0 };

  /** Feeds one raw JSONL line in. Returns what the line turned out to be. */
  ingestLine(line: string): RecordKind {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charCodeAt(0) !== 123 /* { */) {
      return 'unknown';
    }
    // Spans are the single most common line and are always exactly `{}`, so
    // recognise them without paying for JSON.parse.
    if (trimmed === '{}') {
      this.stats.spans++;
      return 'span';
    }
    let record: unknown;
    try {
      // The reviver keeps prompts, responses and tool payloads out of the
      // parsed object entirely when content capture is enabled upstream.
      record = JSON.parse(trimmed, dropContent);
    } catch {
      this.stats.malformed++;
      return 'unknown';
    }
    return this.ingest(record);
  }

  ingest(record: unknown): RecordKind {
    const kind = classify(record);
    switch (kind) {
      case 'metrics':
        this.stats.metrics++;
        this.absorbMetrics(record);
        break;
      case 'log': {
        this.stats.logs++;
        const event = toLogEvent(record);
        if (event) {
          this.absorbQualityEvent(event);
          this.events.push(event);
          if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
          }
          this.stats.lastRecordAtMs = Math.max(this.stats.lastRecordAtMs, event.timeMs);
        }
        break;
      }
      case 'span':
        this.stats.spans++;
        break;
      default:
        this.stats.unknown++;
        break;
    }
    return kind;
  }

  private absorbQualityEvent(event: LogEvent): void {
    const a = event.attributes;
    const decision = (outcome: unknown) => {
      if (outcome === 'accepted' || outcome === 'rejected') {
        this.recordEventValue(EDIT_ACCEPTANCE, 1, { 'copilot_chat.edit.outcome': outcome });
      }
    };
    switch (event.name) {
      case 'copilot_chat.edit.feedback':
        decision(a.outcome);
        break;
      case 'copilot_chat.edit.hunk.action':
        decision(a.outcome);
        if (a.outcome === 'accepted') {
          for (const type of ['added', 'removed']) {
            const value = a[`lines_${type}`];
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
              this.recordEventValue(LINES_OF_CODE, value, { type });
            }
          }
        }
        break;
      case 'copilot_chat.inline.done':
        if (a.accepted === true || a.accepted === 'true') {
          decision('accepted');
        } else if (a.accepted === false || a.accepted === 'false') {
          decision('rejected');
        }
        break;
      case 'copilot_chat.edit.survival':
        if (a.did_branch_change === true || a.did_branch_change === 'true') {
          break;
        }
        for (const [attribute, metric] of [
          ['survival_rate_four_gram', SURVIVAL_FOUR_GRAM],
          ['survival_rate_no_revert', SURVIVAL_NO_REVERT]
        ]) {
          const value = a[attribute];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
            this.recordEventValue(metric, value);
          }
        }
        break;
      case 'copilot_chat.user.feedback':
        if (a.rating === 'positive' || a.rating === 'negative') {
          this.recordEventValue(USER_FEEDBACK, 1, { rating: a.rating });
        }
        break;
      case 'copilot_chat.cloud.session.invoke':
        this.recordEventValue(CLOUD_SESSIONS, 1);
        break;
      case 'copilot_chat.tool.call':
        if (a.success === true || a.success === 'true') {
          this.recordEventValue(TOOL_CALL_COUNT, 1, { success: 'true' });
        } else if (a.success === false || a.success === 'false') {
          this.recordEventValue(TOOL_CALL_COUNT, 1, { success: 'false' });
        }
        break;
    }
  }

  private recordEventValue(metric: string, value: number, attributes: Record<string, string> = {}): void {
    const key = `${metric}\u0000${attrKey(attributes)}`;
    let s = this.eventSeries.get(key);
    if (!s) {
      s = newSeries(metric, attributes, 0);
      this.eventSeries.set(key, s);
    }
    s.last += value;
    s.lastCount++;
  }

  private absorbMetrics(record: unknown): void {
    const resource = resourceAttributes(record);
    const sessionId = resource['session.id'] ?? '';
    const scopes = (record as { scopeMetrics?: unknown[] }).scopeMetrics ?? [];
    let newestMs = 0;
    let newestTokenUsageMs = 0;

    for (const scope of scopes) {
      const metrics = (scope as { metrics?: unknown[] })?.metrics ?? [];
      for (const metric of metrics) {
        const m = metric as {
          descriptor?: { name?: unknown };
          dataPoints?: unknown[];
        };
        const name = typeof m.descriptor?.name === 'string' ? m.descriptor.name : '';
        if (!name || !Array.isArray(m.dataPoints)) {
          continue;
        }
        for (const point of m.dataPoints) {
          const p = point as { attributes?: Record<string, unknown>; endTime?: unknown; value?: unknown };
          const attributes = p.attributes && typeof p.attributes === 'object' ? p.attributes : {};
          const endMs = hrToMs(p.endTime);
          newestMs = Math.max(newestMs, endMs);
          if (name === TOKEN_USAGE) {
            newestTokenUsageMs = Math.max(newestTokenUsageMs, endMs);
          }
          this.absorbPoint(sessionId, name, attributes, p.value, endMs);
        }
      }
    }

    if (newestMs > 0) {
      this.stats.lastRecordAtMs = Math.max(this.stats.lastRecordAtMs, newestMs);
    }
    if (newestTokenUsageMs > 0) {
      this.stats.lastTokenUsageAtMs = Math.max(this.stats.lastTokenUsageAtMs, newestTokenUsageMs);
    }
    this.recordTokenBucket(newestMs || Date.now());
  }

  private absorbPoint(
    sessionId: string,
    metric: string,
    attributes: Record<string, unknown>,
    value: unknown,
    atMs: number
  ): void {
    const key = `${sessionId}\u0000${metric}\u0000${attrKey(attributes)}`;
    let s = this.series.get(key);
    if (!s) {
      // A series that was evicted and is now exporting again must resume its
      // banked history, not start beside it: the incoming value is cumulative
      // and already contains everything that was folded away, so leaving the
      // folded copy in place would count that history twice.
      const restored = this.folded.get(key);
      if (restored) {
        this.folded.delete(key);
        s = restored;
      } else {
        if (this.series.size >= MAX_SERIES) {
          this.evictOldest();
        }
        s = newSeries(metric, attributes, atMs);
        // This key's history is already counted in the sealed aggregate. The
        // incoming value is cumulative and still carries it, so discount that
        // much here — otherwise it would be counted in both places.
        const mark = this.sealedMarks.get(key);
        if (mark) {
          s.rebase = mark.value;
          s.rebaseCount = mark.count;
        }
      }
      this.series.set(key, s);
    }

    if (value && typeof value === 'object' && 'sum' in (value as object)) {
      const h = value as Partial<HistogramValue>;
      const sum = num(h.sum);
      const count = num(h.count);
      // A restored series whose first value is already below its sealed mark
      // has restarted while it was away: this is a fresh run on top of the
      // sealed history, not a continuation of it. Discounting the mark would
      // drive the contribution negative and lose the sealed tokens.
      if (s.rebase > 0 && s.retired === 0 && s.last === 0 && sum < s.rebase) {
        s.rebase = 0;
        s.rebaseCount = 0;
      }
      // Cumulative: a drop means the exporting process restarted.
      if (sum < s.last) {
        s.retired += s.last;
        s.retiredCount += s.lastCount;
        // Bank the finished run's buckets too. Without this a restart would
        // erase every pre-restart sample from the quantile estimates while
        // `mean()` went on counting them.
        s.retiredCounts = addCounts(s.retiredCounts, s.counts);
      }
      s.last = sum;
      s.lastCount = count;
      s.min = typeof h.min === 'number' ? h.min : s.min;
      s.max = typeof h.max === 'number' ? h.max : s.max;
      const buckets = (h as { buckets?: { boundaries?: number[]; counts?: number[] } }).buckets;
      if (buckets && Array.isArray(buckets.boundaries) && Array.isArray(buckets.counts)) {
        s.boundaries = buckets.boundaries;
        s.counts = buckets.counts;
      }
    } else {
      const v = num(value);
      // Same restart-while-sealed case as the histogram branch above.
      if (s.rebase > 0 && s.retired === 0 && s.last === 0 && v < s.rebase) {
        s.rebase = 0;
        s.rebaseCount = 0;
      }
      if (v < s.last) {
        s.retired += s.last;
      }
      s.last = v;
      s.lastCount = 1;
    }
    s.updatedAtMs = Math.max(s.updatedAtMs, atMs);
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, s] of this.series) {
      if (s.updatedAtMs < oldestAt) {
        oldestAt = s.updatedAtMs;
        oldestKey = k;
      }
    }
    if (!oldestKey) {
      return;
    }
    // Keep the full key, session id included. Folding several sessions together
    // would make a reappearing series impossible to rebase, and dropping the
    // attributes would let an evicted input-token series be counted in the
    // output-token total.
    this.folded.set(oldestKey, this.series.get(oldestKey)!);
    this.series.delete(oldestKey);

    if (this.folded.size > MAX_FOLDED) {
      const first = this.folded.keys().next();
      if (!first.done) {
        this.seal(first.value, this.folded.get(first.value)!);
        this.folded.delete(first.value);
      }
    }
  }

  /**
   * Moves a folded series into the sealed aggregate and records how far it had
   * got, so the same key can resume later without being counted twice.
   *
   * The aggregate is what keeps the tokens visible to queries; the mark is what
   * lets a returning series discount the portion already represented there.
   * Dropping either one is a bug — one undercounts, the other overcharges.
   */
  private seal(key: string, s: Series): void {
    const value = contribution(s);
    const count = contributionCount(s);
    const aggKey = `${s.metric}\u0000${attrKey(s.attributes)}`;
    const agg = this.sealed.get(aggKey);    if (agg) {
      agg.retired += value;
      agg.retiredCount += count;
      agg.retiredCounts = addCounts(agg.retiredCounts, s.counts);
    } else {
      const fresh = newSeries(s.metric, s.attributes, s.updatedAtMs);
      fresh.retired = value;
      fresh.retiredCount = count;
      fresh.boundaries = s.boundaries;
      fresh.retiredCounts = addCounts(s.retiredCounts ? s.retiredCounts.slice() : undefined, s.counts);
      fresh.counts = fresh.retiredCounts ? new Array(fresh.retiredCounts.length).fill(0) : undefined;
      this.sealed.set(aggKey, fresh);
    }

    const mark = this.sealedMarks.get(key);
    this.sealedMarks.set(key, {
      value: (mark?.value ?? 0) + value,
      count: (mark?.count ?? 0) + count,
      aggKey
    });

    // `sealed` is bounded naturally — it is keyed by metric and attributes with
    // the session dropped, so it converges on the instrument set. `sealedMarks`
    // is per key and would otherwise grow for the life of the extension.
    //
    // Dropping a mark on its own would be worse than the leak: the aggregate
    // keeps that history, the returning series can no longer discount it, and
    // its full cumulative value lands on top — a guaranteed overcharge. So the
    // matching history leaves the aggregate with it. Forgetting the oldest
    // sliver of a long-dead session under-reports by that much and can never
    // double-count, which is the right direction to err.
    if (this.sealedMarks.size > MAX_SEALED_MARKS) {
      const oldest = this.sealedMarks.keys().next();
      if (!oldest.done) {
        this.forgetMark(oldest.value);
      }
    }
  }

  /** Drops a high-water mark and the history it was guarding, together. */
  private forgetMark(key: string): void {
    const mark = this.sealedMarks.get(key);
    this.sealedMarks.delete(key);
    if (!mark) {
      return;
    }
    const agg = this.sealed.get(mark.aggKey);
    if (!agg) {
      return;
    }
    agg.retired -= mark.value;
    agg.retiredCount -= mark.count;
    if (agg.retired <= 0 && agg.retiredCount <= 0) {
      this.sealed.delete(mark.aggKey);
    }
  }

  /** Prefer metrics per instrument; matching log events describe the same traffic. */
  private *allSeries(): Generator<Series> {
    const reported = new Set<string>();
    for (const series of [this.series, this.folded, this.sealed]) {
      for (const s of series.values()) {
        if (contributionCount(s) > 0) {
          reported.add(s.metric);
        }
        yield s;
      }
    }
    for (const s of this.eventSeries.values()) {
      if (!reported.has(s.metric)) {
        yield s;
      }
    }
  }

  // ------------------------------------------------------------- queries ----

  /** Instrument total, with documented event fallback when no metric measurements exist. */
  total(metric: string, where?: Record<string, string>): number {
    let sum = 0;
    for (const s of this.allSeries()) {
      if (s.metric !== metric || !matches(s.attributes, where)) {
        continue;
      }
      sum += contribution(s);
    }
    return sum;
  }

  /** Number of recorded measurements, i.e. a histogram's cumulative `count`. */
  observations(metric: string, where?: Record<string, string>): number {
    let count = 0;
    for (const s of this.allSeries()) {
      if (s.metric !== metric || !matches(s.attributes, where)) {
        continue;
      }
      count += contributionCount(s);
    }
    return count;
  }

  mean(metric: string, where?: Record<string, string>): number | undefined {
    const count = this.observations(metric, where);
    return count > 0 ? this.total(metric, where) / count : undefined;
  }

  /**
   * Quantile estimated from histogram buckets.
   *
   * Bucket boundaries are coarse, so this interpolates within the bucket the
   * quantile falls in. It is an estimate and is labelled as one wherever it is
   * shown; exact percentiles need per-span timings from the SQLite source.
   */
  quantile(metric: string, q: number, where?: Record<string, string>): number | undefined {
    let boundaries: number[] | undefined;
    const merged: number[] = [];
    let total = 0;

    for (const s of this.allSeries()) {
      if (s.metric !== metric || !matches(s.attributes, where) || !s.counts || !s.boundaries) {
        continue;
      }
      if (!boundaries) {
        boundaries = s.boundaries;
        merged.length = s.counts.length;
        merged.fill(0);
      }
      if (s.counts.length !== merged.length) {
        continue;
      }
      for (let i = 0; i < s.counts.length; i++) {
        // Include buckets banked from earlier runs, or a restart would drop
        // every pre-restart sample out of the estimate.
        const n = s.counts[i] + (s.retiredCounts?.[i] ?? 0);
        merged[i] += n;
        total += n;
      }
    }
    if (!boundaries || total === 0) {
      return undefined;
    }

    const target = q * total;
    let seen = 0;
    for (let i = 0; i < merged.length; i++) {
      const next = seen + merged[i];
      if (next >= target && merged[i] > 0) {
        const lo = i === 0 ? 0 : boundaries[i - 1];
        const hi = i < boundaries.length ? boundaries[i] : lo * 2 || lo;
        const within = (target - seen) / merged[i];
        return lo + (hi - lo) * Math.min(1, Math.max(0, within));
      }
      seen = next;
    }
    return boundaries[boundaries.length - 1];
  }

  /** Distinct values of one attribute across a metric's series. */
  groupBy(metric: string, attribute: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.allSeries()) {
      if (s.metric !== metric) {
        continue;
      }
      const key = String(s.attributes[attribute] ?? 'unknown');
      out.set(key, (out.get(key) ?? 0) + contribution(s));
    }
    return out;
  }

  recentEvents(name?: string, limit = 50): LogEvent[] {
    const matched = name ? this.events.filter((e) => e.name === name) : this.events.slice();
    return matched.slice(-limit);
  }

  countEvents(name: string, predicate?: (e: LogEvent) => boolean): number {
    let n = 0;
    for (const e of this.events) {
      if (e.name === name && (!predicate || predicate(e))) {
        n++;
      }
    }
    return n;
  }

  // ----------------------------------------------------------- token view ----

  /** Cumulative prompt/completion tokens, as reported by `gen_ai.client.token.usage`. */
  tokenTotals(): { input: number; output: number } {
    return {
      input: Math.round(this.total(TOKEN_USAGE, { 'gen_ai.token.type': 'input' })),
      output: Math.round(this.total(TOKEN_USAGE, { 'gen_ai.token.type': 'output' }))
    };
  }

  tokensByModel(): Array<{ model: string; input: number; output: number; total: number }> {
    const byModel = new Map<string, { input: number; output: number }>();
    for (const s of this.allSeries()) {
      if (s.metric !== TOKEN_USAGE) {
        continue;
      }
      const model = String(s.attributes['gen_ai.request.model'] ?? s.attributes['gen_ai.response.model'] ?? 'unknown');
      const type = String(s.attributes['gen_ai.token.type'] ?? '');
      const entry = byModel.get(model) ?? { input: 0, output: 0 };
      const value = contribution(s);
      if (type === 'output') {
        entry.output += value;
      } else {
        entry.input += value;
      }
      byModel.set(model, entry);
    }
    return [...byModel.entries()]
      .map(([model, v]) => ({
        model,
        input: Math.round(v.input),
        output: Math.round(v.output),
        total: Math.round(v.input + v.output)
      }))
      .sort((a, b) => b.total - a.total);
  }

  /** Token burn over time, one bucket per metrics export. */
  tokenSeries(): TokenBucket[] {
    return this.buckets.slice();
  }

  private recordTokenBucket(atMs: number): void {
    const totals = this.tokenTotals();
    const dIn = Math.max(0, totals.input - this.lastTokenTotals.input);
    const dOut = Math.max(0, totals.output - this.lastTokenTotals.output);
    this.lastTokenTotals = totals;
    if (dIn === 0 && dOut === 0) {
      return;
    }
    this.buckets.push({ tMs: atMs, input: dIn, output: dOut });
    if (this.buckets.length > MAX_BUCKETS) {
      this.buckets = this.buckets.slice(-MAX_BUCKETS);
    }
  }
}

/** Element-wise addition of two bucket-count arrays, either of which may be absent. */
function addCounts(into: number[] | undefined, add: number[] | undefined): number[] | undefined {
  if (!add) {
    return into;
  }
  if (!into || into.length !== add.length) {
    return add.slice();
  }
  for (let i = 0; i < add.length; i++) {
    into[i] += add[i];
  }
  return into;
}

function matches(attributes: Record<string, unknown>, where?: Record<string, string>): boolean {  if (!where) {
    return true;
  }
  for (const [k, v] of Object.entries(where)) {
    if (String(attributes[k] ?? '') !== v) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------- metric name index --

export const TOKEN_USAGE = 'gen_ai.client.token.usage';
export const OPERATION_DURATION = 'gen_ai.client.operation.duration';
export const AGENT_DURATION = 'copilot_chat.agent.invocation.duration';
export const AGENT_TURNS = 'copilot_chat.agent.turn.count';
export const SESSION_COUNT = 'copilot_chat.session.count';
export const TIME_TO_FIRST_TOKEN = 'copilot_chat.time_to_first_token';
export const TOOL_CALL_COUNT = 'copilot_chat.tool.call.count';
export const TOOL_CALL_DURATION = 'copilot_chat.tool.call.duration';
export const EDIT_ACCEPTANCE = 'copilot_chat.edit.acceptance.count';
export const CHAT_EDIT_OUTCOME = 'copilot_chat.chat_edit.outcome.count';
export const LINES_OF_CODE = 'copilot_chat.lines_of_code.count';
export const SURVIVAL_FOUR_GRAM = 'copilot_chat.edit.survival.four_gram';
export const SURVIVAL_NO_REVERT = 'copilot_chat.edit.survival.no_revert';
export const PULL_REQUESTS = 'copilot_chat.pull_request.count';
export const CLOUD_SESSIONS = 'copilot_chat.cloud.session.count';
export const USER_FEEDBACK = 'copilot_chat.user.feedback.count';
export const USER_ACTIONS = 'copilot_chat.user.action.count';
export const EDIT_RESPONSES = 'copilot_chat.agent.edit_response.count';
export const SUMMARIZATIONS = 'copilot_chat.agent.summarization.count';
