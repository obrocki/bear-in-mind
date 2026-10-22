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
| `src/agentHost.ts` | Copilot Agent Host harness store location and the connect decision for its DB mode. |
| `src/accountUsage.ts`, `src/sqlite.ts` | Authenticated GitHub quota lookup and shared runtime read-only SQLite support. |
| `src/otelParse.ts`, `src/spanUsage.ts`, `src/otelSummary.ts`, `src/climate.ts` | Pure metric/span parsing, aggregation, session comparison, dashboard snapshots and the habitat's model climate. |
| `.github/extensions/ai-attribution/lib/tokenCoverage.cjs` / `.d.cts` | Shared token reporting/paired-count logic, bundled into the typed extension and used directly by the build-free canvas. |
| `src/*View.ts`, `media/` | Webview messaging and rendering. |
| `.github/extensions/ai-attribution/` | GitHub Copilot app canvas for the attribution research; not packaged. |

Watchers → meter/summary → snapshots → webviews. Renderers format data; they do
not decide accounting. Tests bundle TypeScript with a small VS Code stub and use
Node's test runner; feed tests use temporary files and renderer tests use a DOM shim.

Research on connecting Copilot usage to work and outcomes lives in
[docs/research](docs/research/ai-telemetry-attribution.md). The
[AI attribution canvas](.github/extensions/ai-attribution/README.md) renders it
with live coverage. It is plain ES modules with no build step and no
dependencies; reload extensions in the app after editing. Its tests run with
`npm test`.

## Accounting invariants

- Read displayed titles and activity timestamps from the exact VS Code
  chat-history index key, including generated titles and renames. Support JSON
  and JSONL transcripts, preferring JSONL when both exist; never derive titles
  from prompt text. Keep index titles current even without transcript changes.
  Reuse cached index projections only while both database and WAL modification
  state are unchanged; invalidate them when the index or workspace disappears.
  Read only transcript session metadata and reported credits; ignore token
  snapshots and content. Replay snapshot, set, push/splice and delete records.
  Use VS Code's `max(sum(turn credits), reported session credits)` formula.
- Reconcile metrics and spans with `max()` per dimension, not addition. No
  promotion/idle rebasing. This is conservative when coverage/baselines differ.
- Deduplicate file/SQLite spans by span ID; count tokens/credits on `chat` only,
  not their enclosing agent totals. SDK `github.copilot.nano_aiu` summaries are
  separate, confirmed root-invocation diagnostics: never add them to model-call
  credits, the meter or transcripts; unknown ancestry stays unclassified.
  Cache/reasoning are subsets. Nano-AIU credits
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
  Tool success falls back to `execute_tool` span status only when the feed has no
  tool-call measurements (a measured zero counts). Only OK and ERROR count; UNSET
  is unknown, not a success.
- Retained-trace credit breakdowns (model, repository, user, caller, reasoning effort)
  are diagnostics over the seven-day span window: never add them to the meter or
  to transcript credits. Keep only `owner/name` repository identifiers (no URL
  credentials, no local filesystem paths) and only the effort word from
  `copilot_chat.request.options`. User attribution keys on `user.name` (opt-in
  identity capture) inherited from agent spans; never substitute
  `process.user.name` or `host.name`, which are a device, not an account. Leave
  unlinked calls as *no user identity* rather than guessing.
  Select optional `agent-traces.db` columns defensively; older stores lack them.
- `agent-host-traces.db` (VS Code Copilot Agent Host harness) shares the trace
  store schema but also holds Claude and Codex traces. Read only traces with a
  `github.copilot.*` attribute, merge by span ID with the other sources, and let
  non-GenAI ancestors (the host's session anchor) pass through when classifying
  SDK invocation roots. Calls found only there never reach the Local metric
  feed: meter them in a separate ledger added after the metrics/traces `max()`,
  and keep them out of drift. When a Local copy of such a call appears on a
  later scan, move its charge from that ledger to `traces`. Record a harness
  charge or move only once the meter accepts it, so display-only periods
  neither invent a transfer nor drop a pending one. Read its semantic-convention aliases
  (`gen_ai.usage.cache_write.input_tokens`, reasoning as an attribute) by
  selection, never addition. Never turn on its DB mode where protobuf or gRPC
  traces would stop reaching a collector.
- Repository and actor correlation use time-appropriate session, conversation,
  parent-session or trace context; conflicting native chat IDs cannot inherit
  through a shared weak key. Trace-only links never create sessions.
- Token subtotals retain per-field coverage; measured zero is not missing.
  Cache-read ratios use valid paired input/cache reports. Numeric meter/API
  ledgers stay unchanged. Prefer known database values on duplicate span IDs,
  while preserving file metadata missing from an older database schema.
- SDK analytics pseudonyms and configured resource identities must retain their
  provenance, not masquerade as verified GitHub logins. Content-gated skill
  descriptions/source URIs and executable paths must be redacted.
- Keep canonical first-stream-chunk seconds separate from legacy first-token
  milliseconds. Normalize SDK tool-duration seconds and prefer one overlapping
  metric alias, including a measured zero; filter typed operation histograms so
  agent durations do not become model-call latency.
- Keep elapsed session duration (idle-inclusive), agent invocation latency and
  model latency separate. Throughput uses output tokens and matching model-call
  time. Turn index is not an LLM round-trip count.
- Keep account quota, billing credits, cumulative tokens and prompt occupancy
  separate. No pin means all sessions/account scope, never an implicit latest
  session. Use the reported account percentage and entitlement basis; never add
  local credits or divide pooled `credits_used` by an entitlement. Preserve
  legacy request units. The GitHub quota endpoint is unofficial: expose failures,
  never persist/log credentials or quota bodies, and invalidate expired data.
  Validate reset timestamps against JavaScript's actual Date range, not just
  finite numeric values. Require an explicit saved account-connection opt-in,
  independent of the GitHub authentication grant; restore clears the opt-in
  and published quota without signing out other extensions.
  A pinned chat uses its own reported prompt allowance, never another chat's
  context. Without a usable denominator or explicit personal target, render
  unscaled ice and no percentage. Never imply measured emissions or actual ice loss.
- Model climate (`src/climate.ts`) is weather only and never changes health. It
  weights the latest sessioned, non-auxiliary chat call's model by that model's
  average reported credits per credit-reporting call, on fixed log anchors.
  Missing credits, too few samples, stale calls, the demo or the setting being
  off give no climate, which renders the neutral scene pixel-for-pixel, never a
  "light" model. A pinned chat uses only its own latest call. Describe it as
  credit pace, never as energy, emissions or price.
- The canvas Recipe keys one cycle per repository branch and keeps credits per
  source, never summed. Recorded references keep only numbers of the session's
  own repository and commit IDs; summaries and free text are never read.
  Unknown steps stay unknown until verified. Verification runs only on request,
  sends work identifiers and first-activity times, never selects titles,
  descriptions, commit messages, comments or email fields, passes GitHub values as GraphQL variables and
  keeps Azure DevOps tokens in memory. `lib/convention.mjs` and the
  self-contained `hooks/commit-msg` must parse branches identically.
- Recipe keeps the native consumer (`user.name`), historical/current work-item
  assignee and PR author as separate roles. Native consumption wins over owner
  inference; conflicting owners stay unattributed. Never backdate the current
  assignee. Azure Boards IDs are organization-qualified and link to GitHub only
  through explicit panel-scoped mappings, never matching names or email.
  Per-source measured, inferred and unattributed balances must conserve all
  reported credits, including no-repository usage and cycles outside the display cap.
- Recipe billing is a separate explicit read of one completed UTC day. Preserve
  paying account, user and product filters, API units, model/SKU and retrieval
  time. Compare native consumers only; never promote owner inference to billing.
  Keep gross, discounts and net distinct. No PR/session IDs exist in billing:
  work amounts are estimated shares with an unallocated remainder. Skip allocation
  for a model when captured credits exceed billed credits. Fail on unsupported
  units; failed reads clear old reports and never return raw CLI errors.

Extend regression tests for accounting changes. The OTel fixture was generated
using the SDK and Copilot-compatible exporters; preserve those record shapes.
See [SECURITY.md](SECURITY.md) for the data-handling contract.

## UI changes

Keep rendering at pixel-art resolution and respect disabled animation. Preserve
the seeded iceberg shape and slope-based shading. The neutral (no-climate) path
must not consume extra `Math.random()` calls or change any pixel.

The dashboard uses VS Code semantic tokens and high-contrast borders; its SVG
paints reference CSS variables so live theme changes need no new snapshot.
This does not change the habitat artwork. Dashboard screenshot fixtures emulate
light, dark and both high-contrast modes and check text contrast/live SVG paints.

Run `npm run media` after artwork changes. The HTML screenshot harness mirrors
webview markup and must stay in sync. `tools/dashboard.html?waiting` previews a
connected feed without quality signals. See [tools/README.md](tools/README.md).
Committed screenshots use invented repositories, users and organizations only.
Use plain English for canvas labels and explanations. Keep exact API keys,
settings, commands and internal IDs unchanged in setup or technical details.
Call the VS Code sources **Local harness** and **Copilot Agent Host harness**.
The shared labels live in `ui/format.mjs`; source IDs and settings do not change.
`npm run media:canvas` points store discovery at an empty sandbox and fails if a
source resolves outside its synthetic fixtures; Recipe verification there uses
canned answers, never the network.

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

### Marketplace publication

For an independently owned personal release, use a personally controlled
Microsoft account and personal Marketplace publisher, rather than an
employer-managed work account or an employer's publisher. This is the intended
publishing setup for `obrocki.bear-in-mind`; it is not a Marketplace account-type
requirement.

A publisher account controls uploads; it does not establish intellectual-property
ownership or permission to release code. Confirm the right to distribute the
code under MIT and any applicable third-party or employer release approvals
before publishing. The license notice and independent-project disclaimer do
not resolve an ownership question.

Confirm ownership of the `obrocki` publisher in
[Marketplace management](https://marketplace.visualstudio.com/manage) before
publishing. The existing workflow uses a repository secret named `VSCE_PAT`:
an Azure DevOps personal access token with **Marketplace → Manage** scope and
**All accessible organizations** selected. Never put the token in source,
logs or issues. Manual VSIX upload through Marketplace management is an
alternative that does not require a repository secret.

Adding the secret does not publish a version already released on GitHub:
`release.yml` skips existing non-draft GitHub releases before its Marketplace
step. Prepare a new version for automatic publication, or manually upload the
existing release's VSIX. If Marketplace publication fails after the GitHub
release is created, publish that exact VSIX manually; rerunning the workflow
currently skips it. Do not delete or move an existing release tag to retry.

Marketplace validation/scanning and Microsoft signing happen on publication.
The build script's archive verification is not Marketplace certification.
Verified-publisher status and GitHub build-provenance attestations are separate,
optional trust measures, not prerequisites for ordinary publication. See the
[publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
and [Marketplace protections](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security).

## Pull requests and bugs

Keep changes focused. Use two-space indentation, single quotes and semicolons.
Run the relevant tests, docs check and VSIX build; include screenshots for UI work.
Record changes under `Unreleased` unless bumping a release version.

For metering bugs, include **Iceberg: Telemetry Diagnostics**, usage stats and
relevant **Iceberg** output. Do not attach raw chat transcripts or captured content.
