# Contributing

Run `npm ci`, then press `F5` for an Extension Development Host.

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
| `src/otelParse.ts`, `src/otelSummary.ts` | Pure parsing, aggregation and dashboard snapshots. |
| `src/*View.ts`, `media/` | Webview messaging and rendering. |

Watchers → meter/summary → snapshots → webviews. Renderers format data; they do
not decide accounting. Tests bundle TypeScript with a small VS Code stub and use
Node's test runner; feed tests use temporary files and renderer tests use a DOM shim.

## Accounting invariants

- Reconcile cumulative watcher totals with `max()` per dimension, never by
  summing the sources. Manual reports add separately; credits come from transcripts.
- Promotion estimates overlap from up to 1,024 transcript observations within five
  minutes. Validate/prune on load and append. There is no shared request ID:
  unrelated usage can be absorbed, and recovery is not guaranteed.
- Adopt pre-existing history without charging it. Transcript snapshots replay
  history; reused slots and restarted metric counters must preserve earlier usage.
- Tie feed offsets and missing-file observations to their path. Keep the initial
  backlog boundary fixed while catching up; a partial final record must not wedge
  seeding. Charge it once completed. Bound reads and skip oversized records.
- Cumulative exports are snapshots, not increments. Preserve high-water marks
  across eviction and rebuild the rollup after restart without recharging history.
- Drop known content-bearing attributes at the parser boundary. Feed spans can
  serialize as `{}`; use the read-only trace store for exact timings.
- Quality falls back to documented log events per instrument only when metrics
  have no measurements. Keep compact event totals beyond the recent-event cap;
  ignore branch-changed survival samples and never add events to matching metrics.

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
| `ci.yml` | Tests and VSIX builds on Linux, Windows and macOS; PR artifact on Linux. |
| `build-vsix.yml` | Build artifact and rolling `dev` release on merge or manual run. |
| `release.yml` | Tagged release; Marketplace publication when `VSCE_PAT` is configured. |

For a release, run `npm version patch --no-git-tag-version` (or the intended
version), update `CHANGELOG.md`, commit, and tag `vX.Y.Z`. Keep `package.json` and
`package-lock.json` in sync.

## Pull requests and bugs

Keep changes focused. Use two-space indentation, single quotes and semicolons.
Run the relevant tests, docs check and VSIX build; include screenshots for UI work.
Record changes under `Unreleased` unless bumping a release version.

For metering bugs, include **Iceberg: Telemetry Diagnostics**, usage stats and
relevant **Iceberg** output. Do not attach raw chat transcripts or captured content.
