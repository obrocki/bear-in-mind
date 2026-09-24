# Contributing

Use Node 22 (including `node:sqlite` for the trace-store regression), run `npm ci`,
then press `F5` for an Extension Development Host.

| Command | Purpose |
| --- | --- |
| `npm run compile` / `npm run watch` | Bundle once / rebuild on changes. |
| `npm run typecheck` | Check TypeScript. |
| `npm test` | Accounting, API, telemetry and dashboard regressions. |
| `npm run check:docs` | Check fences, relative links and raw HTML. |
| `npm run vsix` | Typecheck, bundle, package and verify the archive. |

## Architecture

| Files | Responsibility |
| --- | --- |
| `src/api.ts`, `src/extension.ts` | Public contract, shared reporting adapter, activation and commands. |
| `src/tokenMeter.ts` | Persisted ledgers, reconciliation and ice health. |
| `src/chatWatcher.ts`, `src/otelWatcher.ts` | Transcript/feed I/O, baselines and trace-store queries. |
| `src/otelParse.ts`, `src/spanUsage.ts`, `src/otelSummary.ts` | Pure metric/span parsing, aggregation, session comparison and dashboard snapshots. |
| `src/*View.ts`, `media/` | Webview messaging and rendering. |

Watchers → meter/summary → snapshots → webviews. Renderers format data; they do
not decide accounting. Tests bundle TypeScript with a small VS Code stub and use
Node's test runner; feed tests use temporary files and renderer tests use a DOM shim.

## Accounting invariants

- Never meter transcript `promptTokens` as consumed input. Replay snapshot, set,
  push/splice and delete records for session credit comparison. Use VS Code's
  `max(sum(turn credits), reported session credits)` formula.
- Reconcile metrics and spans with `max()` per dimension, not addition. No
  promotion/idle rebasing. This is conservative when coverage/baselines differ.
- Deduplicate file/SQLite spans by span ID; count tokens/credits on `chat` only,
  not their enclosing agent totals. Cache/reasoning are subsets. Nano-AIU credits
  divide by 1e9; missing is unknown, including when other calls report zero.
- Adopt existing metric history; meter spans starting after observation began.
  Preserve legacy estimates separately rather than relabeling them as measured.
  Demo and text-tokenizer estimates must not contaminate the real ledger.
- Tie feed offsets and missing-file observations to their path. Keep the initial
  backlog boundary fixed while catching up; a partial final record must not wedge
  seeding. Charge it once completed. Bound reads and skip oversized records.
- Cumulative exports are snapshots, not increments. Preserve high-water marks
  across eviction and rebuild the rollup after restart without recharging history.
- Drop content-bearing attributes; retain only span usage metadata. Support
  current serialized file spans as well as legacy `{}` exports. Use read-only
  SQLite and an attribute allowlist; do not select captured content.
  Extract file spans from the parser's redacted record, never by parsing the raw
  line a second time.
- Quality falls back to documented log events per instrument only when metrics
  have no measurements. Keep compact event totals beyond the recent-event cap;
  ignore branch-changed survival samples and never add events to matching metrics.
- Keep elapsed session duration (idle-inclusive), agent invocation latency and
  model latency separate. Throughput uses output tokens and matching model-call
  time. Turn index is not an LLM round-trip count.
- Keep billing credits, cumulative tokens and prompt occupancy separate. Pin a
  comparison session explicitly; do not imply active-chat detection. Without a
  reported prompt allowance or explicit personal target, render unscaled ice
  and no percentage. Never imply measured emissions or actual ice loss.

Extend regression tests for accounting changes. The OTel fixture was generated
using the SDK and Copilot-compatible exporters; preserve those record shapes.
See [SECURITY.md](SECURITY.md) for the data-handling contract.

## UI changes

Keep rendering at pixel-art resolution and respect disabled animation. Preserve
the seeded iceberg shape and slope-based shading.

Run `npm run media` after artwork changes. The HTML screenshot harness mirrors
webview markup and must stay in sync. `tools/dashboard.html?waiting` previews a
connected feed without quality signals. See [tools/README.md](tools/README.md).

## Packaging and releases

`tools/build-vsix.js` is the shared local/CI build path. It checks required assets,
command registrations and accidental source/dependency leaks in the packaged VSIX.
Use `node tools/build-vsix.js --help` for options.

| Workflow | Result |
| --- | --- |
| `ci.yml` | Tests and VSIX builds on Linux, Windows and macOS using Node 22; PR artifact on Linux; stable release after all main-branch jobs pass. |
| `build-vsix.yml` | Build artifact and rolling `dev` release on merge or manual run. |
| `release.yml` | Reusable post-merge release, also callable manually or by tag; skips published versions; Marketplace publication when `VSCE_PAT` is configured. |

For a release, run `npm version patch --no-git-tag-version` (or the intended
version), update `CHANGELOG.md`, and merge the PR. Keep `package.json` and
`package-lock.json` in sync. After the main-branch CI matrix succeeds, Release
builds and verifies the VSIX, creates `vX.Y.Z` at that exact tested commit, and
publishes the GitHub release. No pre-merge tag or second workflow dispatch is
required. A tag pointing to a different commit fails rather than being moved.

## Pull requests and bugs

Keep changes focused. Use two-space indentation, single quotes and semicolons.
Run the relevant tests, docs check and VSIX build; include screenshots for UI work.
Record changes under `Unreleased` unless bumping a release version.

For metering bugs, include **Iceberg: Telemetry Diagnostics**, usage stats and
relevant **Iceberg** output. Do not attach raw chat transcripts or captured content.
