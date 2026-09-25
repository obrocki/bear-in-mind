# Change Log

## 0.6.1

- Session selection now lists the name the user gave a chat session, with the
  session ID as searchable detail, instead of leading with a GUID.
- Added a billing-period roll-up (credits and traced tokens observed since the
  1st) as the dashboard fallback when no session is selected or observed.

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
