# Change Log

## Unreleased

## 0.7.2

- **Happy bear on local models:** when the latest chat call goes to a model
  endpoint on this machine (Ollama, Foundry Local, LM Studio or any server on
  `localhost`, `127.0.0.1` or `::1`), the habitat gets a clear aurora night with
  a crescent moon, glinting ice, no meltwater and a happy bear (hearts, a
  wagging tail and rolls in the snow). The ice still shows the plan allowance.
  Locality comes only from the `server.address` Copilot reports on chat spans,
  never from zero credits or model names. List other model servers by exact
  host name in the new `iceberg.climate.localHosts` setting. `getUsage()`
  climates gain the `aurora` band with `local` and `host`; other endpoints'
  hosts are never exposed. README adds a local-model screenshot and GIF, and
  `npm run media:gif` renders it from a fixed seed.

- **Flow-focused setup:** replaced runtime-version advice with work-item ownership,
  issue-linked branch/session and commit/PR conventions, read permissions, paying
  account selection and the conditions for comparing billing with recorded usage.
- **Readable cycle credits:** larger, whole-credit source totals in rounded
  rectangles on the right, with compact individual/owner-estimate details.
  Removed the duplicate middle credit panel; underlying usage is unchanged.
  Missing cloud-review usage stays unknown rather than producing a combined total.
  Shortened the repeated commit step to **Commit**; accounting is unchanged.
- **Experimental-use warning:** every canvas tab has the same footer explaining
  that results may be incomplete or inaccurate and are not a sole basis for
  billing, savings claims or individual performance decisions.
- **Ordered README example:** a generated, synthetic work-to-billing illustration
  with seven chronological delivery steps and a separate final mocked billing
  check. Shared screenshot fixtures now have consistent dates and ordering checks;
  live API behavior is unchanged.
- **Overview at a glance:** mission statement and a hybrid source-to-Recipe map,
  showing people/usage records, delivered work and the separate bill comparison.
  Local measurements follow the map rather than serving as the page's mission.
- **Simple work-link labels:** removed research-only codes from the canvas,
  model, estimated-cost report metadata and documentation. Model schema 2
  uses descriptive link methods instead.
- **Harness names:** consistently distinguish the VS Code Local harness from
  the Copilot Agent Host harness in the canvas, diagnostics, dashboard and docs.
  Source IDs, settings and database names are unchanged.
- **Plain-English canvas:** clearer tab names, account/usage labels and billing
  explanations. Technical field names, commands and API IDs are unchanged.
  A browser check guards against unexplained jargon in the main views.
- **Billing and setup in Recipe:** explicit one-day GitHub AI-credit reports,
  per-source native-user/model comparison and clearly labelled work estimates with
  unmatched balances. The data model now draws the parallel billing lane.
  **Setup & permissions** is the single checklist for stores, identity,
  branch/commit conventions, API access and assumptions.
- **Essentials-only canvas:** shared concepts move into a Surfaces filter;
  duplicated KPI, ingredient, relationship and surface panels are removed.
  Research summarizes findings and limits inline instead of duplicating every
  tab or requiring a download. Estimated work cost uses a plain-language label.
- **Recipe developer attribution:** connects captured `user.name` to work,
  GitHub assignees/PR authors and Azure Boards assignees at first AI activity.
  Filter by developer and source; measured consumption, inferred ownership
  proxies and unattributed credits stay separate. Work-ownership mode includes
  other contributors without calling their usage personal consumption.
  Cross-provider account links are explicit and panel-scoped.

- **AI attribution canvas: Recipe tab.** One AI-assisted delivery cycle per
  repository branch, from work item to merged pull request: ingredients (GitHub
  issue or Azure Boards work item, branch), method (AI sessions, credits,
  commits) and serve (PR, review, merge and work-item closure). A recipe strip,
  convention gauge, ingredient cards and per-cycle timelines show what local
  stores record. **Verify with GitHub & Azure Boards** is an explicit step that
  asks `gh` and Azure DevOps for PR state, reviews, merge and closure using only
  recorded identifiers; titles, descriptions and commit messages are never
  requested. Branches named `prefix/AB123-slug` or `prefix/123-slug` link to
  Azure Boards work item 123 or GitHub issue 123, and an opt-in `commit-msg`
  hook adds the matching `Refs:` trailer. Canvas screenshots now read only
  sandboxed synthetic stores.
- **Tighter attribution tabs:** shorter summaries, compact coverage bars,
  an entity diagram and expandable evidence across the views.
  Recipe keeps its full lifecycle with fewer KPI cards; Research becomes a
  section index. Keyboard controls, narrow layouts and visible-copy budgets
  are checked by the synthetic screenshot harness.

## 0.7.1

- **Model climate:** the habitat's weather now shows the pace of the model in
  use, while the ice still shows remaining allowance. Light models bring slow
  clouds, heavy snow and a pinprick sun; mid models keep today's sky; heavy
  models bring a big low sun, a warm sky and a light thaw. Pace is the model's
  average reported AI credits per call in retained traces, on a fixed scale
  (0.05 to 25 credits per call). Reasoning effort adds turning sun rays and the
  prompt limit widens the halo, clouds and haze. A HUD line names the band,
  model and average. Without enough reported credits, after 30 minutes idle,
  during the demo or with `iceberg.climate.enabled` off, the scene is unchanged.
  `getUsage()` snapshots include the climate when present. README screenshots
  show light, mid and heavy models.

## 0.7.0

- Refreshed the attribution research and canvas model to 19 October 2026:
  per-session cloud agent AI credits (Agent Tasks REST, preview), VS Code's
  Copilot Agent Host harness Agent Host telemetry, managed OTel identity capture, the
  usage-metrics agent undercount, and OTel GenAI metric and token-breakdown
  changes. Local measurements were re-run, and the research preamble is now a
  last-updated date.
- README: Copilot Agent Host harness sessions get identity only through managed
  `telemetry.capture.identity`. The Marketplace listing is live, so the install
  section no longer treats it as pending.
- Copilot Agent Host harness chats (VS Code 1.141+) are now metered. Bear in Mind reads
  the Agent Host trace store (`agent-host-traces.db`), using only Copilot runtime
  traces, merged by span ID. Calls only the Agent Host recorded go to their own
  meter ledger, added to the reconciled Local figure and kept out of drift.
  Their root credits show as SDK root-invocation credits. Cache-write and
  reasoning subtotals are also read under the semantic-convention names that
  store uses.
- **Connect** also turns on the Agent Host trace store
  (`chat.agentHost.otel.dbSpanExporter.enabled`) with the local trace store,
  unless a protobuf or gRPC collector would stop receiving its traces.
  **Restore Defaults** puts it back. Diagnostics show the store's path and
  activity.
- The AI attribution canvas adds a VS Code Copilot Agent Host harness source with
  per-turn credits.

## 0.6.5

- Prepared Marketplace installation instructions alongside the existing VSIX
  route, without claiming the listing is already published.
- Clarified desktop, optional SQLite and identity-capture requirements, the
  independent publisher and the opt-in unofficial account quota API.
- Clarified MIT reuse and modification permissions, retained the existing
  personal copyright notice, and stated that the project is not an official,
  sponsored or endorsed Microsoft or GitHub product. Documented personal
  publisher setup separately from rights and release approvals.
- Documented Marketplace publishing credentials and manual recovery when a
  GitHub release already exists. Distinguished archive verification from
  Marketplace scanning/signing and optional publisher/provenance verification.
- Fixed a dashboard account-refresh menu entry misplaced in the command
  declarations, which produced an invalid-command-title warning in VS Code.

## 0.6.4

- Session picker titles now come from VS Code's chat-history index, including
  generated names and renames, instead of exposing GUIDs when transcript custom
  titles are absent. Support legacy JSON transcripts and custom-profile storage.
  Unchanged history indexes reuse cached projections, including WAL-aware
  invalidation, rather than reopening every historical database on each scan.
- **All sessions** is the default: no implicit latest-session selection.
  Explicitly selected chats retain their own cost and prompt-context comparison.
- Added **Refresh Copilot Account Usage** and a separate, authorized account
  connection to GitHub's unofficial quota API used by VS Code. Combined account
  usage drives the gauge against the reported plan allowance; local tokens and
  credits are never added to account usage, and legacy request units stay separate.
- Account sign-in, API errors, stale/reset quotas and pooled/unlimited plans are
  explicit. No hard-coded allowance or invented per-user denominator; account
  data and credentials are not persisted or logged, and no local chat data is sent.
  Account usage requires a saved explicit connection opt-in; restore clears it
  and the displayed quota immediately without revoking GitHub sign-in.
  Out-of-range reset timestamps are rejected before they reach UI date formatting.
- Updated dashboard, habitat, status/diagnostic text, settings descriptions,
  README and data-handling documentation; added synthetic account-usage screenshots.

## 0.6.3

- VS Code alignment: time-appropriate repository/actor context across native
  session, conversation, parent-session and trace keys, with conflicting native
  chat IDs kept separate and trace-only links never creating sessions.
- Shared token subtotals/reporting coverage and paired input/cache ratios;
  missing values remain unknown and numeric meter ledgers are unchanged.
- SDK root-invocation credit diagnostics with verified retained ancestry,
  separate from per-call VS Code credits, transcript Session Cost and the meter;
  nested totals and request multipliers are never added as money.
- Canonical first-stream-chunk timing, SDK agent/tool metrics with explicit
  second-to-millisecond conversion and alias precedence, and typed operation
  histograms separated from model-call timing.
- Native SDK analytics IDs and configured resource identity retain provenance;
  content-gated skill descriptions/source URIs and executable paths are redacted.
- The packaged dashboard follows VS Code light/dark/high-contrast themes and
  live SVG colors without changing the habitat artwork.
- Research: executive summary of the measurement decision and remaining ROI
  prerequisites; actor field provenance distinguishes native, configured,
  derived and enriched values. Removed the requested introductory scope paragraph.
- AI attribution canvas: time-appropriate repository context and consistent
  trace-only coverage without fabricated sessions; nullable token subtotals,
  per-field coverage and cache-read share over paired reported counts.
- AI attribution canvas: **Intersection** across all five surfaces, excluding
  missing/unverified fields and distinguishing native from conditional
  availability. **App / system**, Light and Dark themes now work without host
  token injection and follow live host/system changes.
- Attribution research/model: current organisation token/customization
  aggregates, self-reported task completion, primary-source CLI/OTel/billing
  verification and explicit gross/discount/net billing reconciliation.
- **User attribution** from VS Code 1.140's OpenTelemetry identity capture:
  `user.name` (the signed-in GitHub account) is read from agent spans in the
  trace store and file feed, inherited by model calls from the time-appropriate
  agent span in the same or parent session, and used to group retained-trace
  credits **by user**. Sessions show their user, or the observed user list after
  an account switch, in the dashboard, the session picker (searchable) and
  diagnostics. Calls without a user stay visible as *no user identity*.
- **Connect Copilot Telemetry** asks separately whether to turn on
  `github.copilot.chat.otel.captureIdentity`, noting when a connected OTLP
  collector would receive the identity too. It writes that setting last and
  skips it if replacing a collector failed, and does not offer it when
  `COPILOT_OTEL_CAPTURE_IDENTITY` overrides it. **Restore Defaults** puts the
  previous value back.
- Telemetry diagnostics report whether identity capture is requested and how
  many retained calls are attributed to a user.
- AI attribution canvas: VS Code coverage resolves `user.name` from agent spans
  and adds a **By user** breakdown and an **Actor coverage** metric (share of
  credits attributed to a user). The research and model spec record identity
  capture as opt-in VS Code actor data and the `user.name` ↔ `user_login` join.
- **Restore defaults and disconnect**: the last option in the connect picker, a
  dashboard footer button and menu entry, and the **Iceberg: Restore Defaults and
  Disconnect…** command. After confirming a listed plan, it returns the Copilot
  Chat telemetry settings Bear in Mind changed to their previous user values,
  resets Bear in Mind's user settings, deletes its stored state and its own
  storage folder with the default feed file, and offers to reload or uninstall.
  Settings changed by the user after connecting, workspace settings, custom
  `iceberg.otel.feedPath` files and Copilot's own files are left alone.
- Connecting now records the previous user value of each Copilot setting it
  writes, so a later restore can put it back.
- AI attribution canvas README: screenshots of the Outcomes, Surfaces, Data
  model and Live coverage tabs, generated by `npm run media:canvas` from
  synthetic stores.

## 0.6.2

- Dashboard: a **Model-call credits · retained traces** block groups reported
  credits by model, repository, caller and reasoning effort, because token share
  is not credit share. Calls without a session ID and calls without credits are
  counted and labeled rather than hidden.
- Sessions carry the repository and branch reported by their agent spans, shown
  in the session picker (searchable), the comparison session and diagnostics.
- Cost shows the cache-read share of retained trace input.
- Quality falls back to `execute_tool` span status for tool success when the feed
  has no tool-call metrics or events, so trace-store-only setups get a signal.
  Only OK and ERROR span statuses count; UNSET or missing statuses are left out.
- The trace-store reader tolerates older `agent-traces.db` schemas without
  `agent_name` or `status_code`.
- Research: [connecting AI usage to work and outcomes](docs/research/ai-telemetry-attribution.md)
  across VS Code, Copilot CLI, the GitHub Copilot app and Copilot cloud agent, with a
  structured attribution model. Repository-only; not part of the VSIX.
- Added the **AI attribution** GitHub Copilot app canvas (`.github/extensions/ai-attribution/`)
  showing the model, surface matrix, gaps and live read-only coverage from local stores.

## 0.6.1

- Session selection now lists the name the user gave a chat session, with the
  session ID as searchable detail, instead of leading with a GUID.
- Added a billing-period roll-up of totals for sessions observed since the 1st
  as the dashboard fallback when no session is selected or observed. Trace
  details are limited to retained seven-day history, with the cutoff and
  session coverage shown; trace-credit fallbacks are labeled separately.

## 0.6.0

- Removed the default 5M-token target: ice is unscaled without a reported prompt
  allowance or an explicitly configured personal target. Demo animation no
  longer records usage; the ice is labeled as a metaphor, not environmental data.
- Stopped counting transcript context snapshots as cumulative token consumption.
  Preserved legacy estimates separately and started a measured-token ledger.
- Added comparison-session selection and VS Code's transcript Session Cost
  formula, including reported backend session totals and JSONL splice/delete replay.
- Added current serialized OTel file spans and nano-AIU credit reporting,
  deduplicated with SQLite by span ID. Only model-call spans count tokens, cache,
  reasoning and credits; parent agent totals are excluded.
- Separated idle-inclusive sessions from agent/model latency; throughput now uses
  output tokens over matching model-call time. Round trips use explicit turn counts.
- Documented stable/proposed API boundaries and verified native popup formulas.
  Account quotas and automatic active-chat selection remain unavailable.
- Added restart, credit coverage, real SQLite, export timing and unscaled UI regressions.
- Stable releases now run after all main-branch CI platforms pass, tagging the
  tested commit and attaching its verified VSIX. Already released versions are skipped.

## 0.5.2

- Distinguished local cumulative tokens, reported transcript credits and aggregate
  telemetry from Copilot's monthly allowance, selected-session cost and context window.
- Fixed the habitat, status and usage stats showing a prompt-headroom percentage
  beside an unrelated cumulative-budget fraction. Dashboard budget headroom now
  uses the enabled token dimensions, not all input/output tokens.
- Labelled trace headroom as the latest observed prompt allowance across sessions,
  rather than the selected chat's full context window.
- Separated the ice gauge from cumulative totals, with exact used/limit or
  counted/target values and an explicit unavailable account credit limit.
- Added meter scope/start and exact usage figures to diagnostics, credit-only and
  missing-credit dashboard states, and regressions for the different gauge modes.

## 0.5.1

- Consolidated the extension API and `iceberg.report` behind one typed adapter,
  preserving object and numeric reports.
- Shortened documentation and corrected accounting/privacy descriptions.
- Quality now distinguishes a connected feed awaiting signals from missing
  telemetry; standalone survival, cloud-session and error metrics remain visible.
- Added Quality fallbacks for documented log events without adding them to matching
  metrics; totals survive recent-event eviction.
- Reconciliation waits for both sources instead of marking one-sided data as divergent.
- Validated and bounded persisted handover evidence on load and append.
- Added regressions for API reports, Quality states, missing-feed path changes,
  partial-record seeding, restart accounting and overlap limitations.

## 0.5.0

- Added local OpenTelemetry metering and a cost/speed/quality dashboard.
- Ice shows recent context-window headroom, falling back to the token budget.
- Added trace-store and file-feed setup, with a warning that file export replaces OTLP.
- Reconciled cumulative telemetry/transcript ledgers with per-dimension `max()`;
  transcript credits and manual reports remain separate.
- Removed manual budget/refreeze/add-token/selection commands; baseline adoption
  is automatic.
- Fixed handover/restart accounting, feed identity and rotation, partial/oversized
  records, eviction high-water marks, histogram resets and missing-feed handling.
- Dropped known captured-content attributes at the parser boundary and corrected
  freshness, throughput, source notifications and screenshot-harness failures.
- Added 68 tests and Linux, Windows and macOS CI.

## 0.4.0

- Renamed the project and extension to **Bear in Mind**; added a bear-face
  activity-bar icon. Kept `iceberg.*` IDs to preserve settings and keybindings.
- Old `obrocki.iceberg-copilot` installs must be removed separately.

## 0.3.1

- Detect duplicate installs by contributed view/command IDs, including renamed copies.

## 0.3.0

- Detect duplicate installs before registering commands or starting watchers.
- Added **Iceberg: Name the Bear…**.
- Old `local.iceberg-copilot` installs must be removed separately.

## 0.2.1

- Open-sourced the project with docs, generated media, CI and release workflows.
- Added verified VSIX packaging and rolling `dev` builds.
- Clarified that the extension cannot enforce spending limits.
- Fixed sidebar resizing, Marketplace release conditions and broken Markdown rendering.
- Changed publisher from `local` to `obrocki`.

## 0.2.0

- Added automatic transcript metering, premium credits and persisted baselines.
- Handled cumulative counters, reused request slots, rewrites and replayed history.
- Added polling settings and an output channel; raised the default budget to 5M.

## 0.1.0

- Initial pixel-art iceberg, bear, sidebar/editor views and status bar.
- Added chat/API/manual token reporting, persistence and configurable rendering.
