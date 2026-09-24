![A polar bear on a pixel-art iceberg under an aurora](docs/media/hero.png)

# 🐻‍❄️ Bear in Mind — Copilot Token Meter

Track reported Copilot usage in your sidebar, with a dashboard for tokens,
credits, speed and quality signals. The polar bear's ice is a **usage metaphor**,
not a measurement of energy consumption, CO2 or real ice loss.

[![CI](https://github.com/obrocki/bear-in-mind/actions/workflows/ci.yml/badge.svg)](https://github.com/obrocki/bear-in-mind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Bear in Mind visualises usage. **It cannot cap spending, throttle requests or
change your bill**, including on unlimited plans.

![The iceberg melting and refreezing](docs/media/melt.gif)

## Install

Download a `.vsix` from [Releases](https://github.com/obrocki/bear-in-mind/releases),
then run:

```bash
code --install-extension bear-in-mind-0.6.0.vsix
```

Use the downloaded filename if it differs. Open the Iceberg activity-bar icon.
Every merge also updates the rolling
[`dev` build](https://github.com/obrocki/bear-in-mind/releases/tag/dev).
A new package version is released automatically after all `main` CI platforms
pass. The release attaches a verified VSIX; Marketplace publishing additionally
requires the repository's `VSCE_PAT` secret.

## The dashboard

Open **Iceberg: Open Token Dashboard** or the sidebar's *Cost, Speed, Quality* view.

![Cost, speed and quality dashboard](docs/media/dashboard.png)

| Section | Signals |
| --- | --- |
| Cost | Reported model-call tokens, per-session transcript and trace credits, cache/reasoning subtotals and feed rate. Not a bill. |
| Speed | Elapsed session duration, agent-invocation latency, model-call latency, first token, output throughput and slow tools. |
| Quality | Observed edit acceptance, code survival, pull requests, tool success and response feedback. Not a correctness score. |

The ice shows **reported prompt headroom for the comparison session** when a
recent trace reports an input allowance. Otherwise it is **unscaled**: no
percentage and no invented denominator. There is **no default 5M target**.
An explicitly configured `iceberg.tokenBudget` remains an optional personal
fallback, not a model limit or spending cap. The demo is synthetic and never
adds tokens or credits to the meter.

### Comparing this with Copilot

These readings have different units and scopes, even when viewed during one chat:

| Reading | Meaning |
| --- | --- |
| Copilot status **Credits used / allowance** | Account/billing-period credits and the allowance Copilot reports. Bear in Mind does not read either value or the reset date. |
| Copilot **Session Cost** | Compare with **Session Cost · transcript** for the same session ID. Uses VS Code's formula: `max(sum(turn copilotCredits), reported sessionCopilotCredits)`. Includes existing history, unlike the local meter. |
| **Model-call credits · traces** | Sum of reported `copilot_chat.copilot_usage_nano_aiu / 1,000,000,000` on unique `chat` spans. Shows coverage (`reported / observed` calls); missing credits are unknown, not free. Never added to transcript credits. |
| Copilot **Context Window** | Latest prompt plus completion tokens, divided by the selected model's full context window. The denominator can change immediately when you switch models. |
| Dashboard **local tokens** | Persisted, conservative reconciliation of metric and span growth since the displayed meter start, plus explicitly labeled manual reports. Not a selected-chat total or billing-period total. |
| **Session input/output · traces** | Sum of unique model-call spans retained for that session. Repeated context counts on every call, including cached input; it is not context occupancy. |
| Dashboard model totals, speed and Quality | Aggregate telemetry, not the comparison session: file history or retained seven-day traces. Model totals need not sum to the local meter. Quality measures actions, not task correctness. |
| Ice in prompt mode | Input tokens / `max_prompt_tokens` for the comparison session. This is only the reported prompt allowance, **not** the full native Context Window. |
| Ice without a reported limit | Unscaled unless you explicitly set a personal visual target. No environmental or billing inference. |

Use **Iceberg: Select Comparison Session** (or **Select session…** in the
dashboard) to pin the session ID you are examining in Copilot. The default is
the latest observed session, **not automatically the active chat**. A missing
pinned session stays missing rather than switching to somebody else's reading.
Export delays, retained history, subagent attribution and provider coverage can
still cause differences. No token-to-credit price estimate is used.

See [Copilot billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing)
and [VS Code usage monitoring](https://code.visualstudio.com/docs/agents/guides/optimize-usage#monitor-your-usage).
A metric/span divergence is a **source diagnostic, not a billing comparison**.
Use **Iceberg: Telemetry Diagnostics** for the comparison session ID, credit
coverage, exact observed totals, meter start and gauge basis.

### APIs investigated

Checked against [VS Code source `13de456`](https://github.com/microsoft/vscode/tree/13de4561e248a9e0c4e1f832d5cf1793e6500a3c)
and the official [OTel reference](https://code.visualstudio.com/docs/agents/guides/monitoring-agents).
Copilot's current implementation is under `extensions/copilot` in that repository.

| Surface | What is actually available |
| --- | --- |
| Stable `vscode.lm` API | Model selection, requests and tokenization of supplied text. Not a listener for all Copilot usage; visible-text tokenization is not billed usage. |
| Copilot extension exports | No documented session-usage or account-quota getter. |
| Proposed/private APIs | `ChatResponseStream.usage`, model pricing, active chat session and debug APIs exist, but are not stable third-party extension contracts. This extension does not enable proposed APIs. |
| Account status popup | Reads VS Code's internal entitlement/quota service. No supported third-party live quota API was found; account usage, allowance and reset date remain **Not read**. |
| Local transcript storage | Internal/version-dependent mutation log. Supplies session IDs and reported credits. `promptTokens` is latest context, not cumulative consumed input. |
| Copilot OTel | Metrics, spans and events. Current spans carry tokens, session identity, timing and optional nano-AIU credits; older exporters may emit empty `{}` spans. |

Source details: [native context widget](https://github.com/microsoft/vscode/blob/13de4561e248a9e0c4e1f832d5cf1793e6500a3c/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts),
[session cost model](https://github.com/microsoft/vscode/blob/13de4561e248a9e0c4e1f832d5cf1793e6500a3c/src/vs/workbench/contrib/chat/common/model/chatModel.ts),
[credit conversion](https://github.com/microsoft/vscode/blob/13de4561e248a9e0c4e1f832d5cf1793e6500a3c/extensions/copilot/src/platform/networking/common/openai.ts),
[per-call versus turn usage](https://github.com/microsoft/vscode/blob/13de4561e248a9e0c4e1f832d5cf1793e6500a3c/extensions/copilot/src/extension/intents/node/toolCallingLoop.ts),
[status popup](https://github.com/microsoft/vscode/blob/13de4561e248a9e0c4e1f832d5cf1793e6500a3c/src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts).

## Connecting the telemetry

Run **Iceberg: Connect Copilot Telemetry…**, choose a source, **reload the window,
then send a Copilot Chat request**. Allow an export interval for data to arrive.

| Source | Provides | Exporter impact |
| --- | --- | --- |
| Local trace store (`agent-traces.db`) | Model-call tokens, optional credits, exact timings and reported prompt limits. | Runs alongside an existing OTLP collector. |
| JSON-lines file feed | Token metrics, quality signals and (in current Copilot) serialized spans with session details. | **Replaces the OTLP exporter.** The command warns first. |
| Both | All available signals. | Same replacement caveat as the file feed. |

Older file-feed spans may serialize as `{}`; those builds need the trace store
for exact timings and session credits. Quality needs relevant actions, not just chat
requests: accept/reject an edit or rate a response. A connected but empty Quality
section [waits for those signals](docs/media/dashboard-waiting.png); it does not
require reconnecting.

Quality uses cumulative metrics when present, otherwise documented edit,
survival, feedback, cloud-session and tool-call events. Matching metrics and
events are never added together; inference events alone are not quality signals.

## How tokens get counted

Existing metric history becomes a baseline; completed spans are counted only if
their call started after trace metering began. Stable span IDs deduplicate file
and SQLite copies, including across restarts. Only `chat` spans contribute tokens
and credits; enclosing `invoke_agent` totals are not added again. Cache and
reasoning are subtotals, not extra tokens.

Metrics and spans can describe the same calls. The local meter uses their
per-dimension maximum, **not their sum**. Different baselines and coverage mean
this is a conservative observation, not a guaranteed complete union or billing
record. Idle periods never copy or reset those ledgers.

Transcript prompt snapshots are **not** counted as consumption. Older stored
estimates are preserved separately, explicitly excluded from the new meter, and
shown in diagnostics. Manual API reports add separately and are labeled.
`@iceberg` relies on reported telemetry, not a character-count estimate.

Metering stays local. See [SECURITY.md](SECURITY.md) for data handling.
Reconciliation stays pending until metrics and spans both have observations.

## API

The exported API and `iceberg.report` command share one implementation and accept
`{ input?, output? }`. A numeric argument remains supported as input tokens.
Report only usage the automatic watchers do **not** already see.

```ts
const extension = vscode.extensions.getExtension('obrocki.bear-in-mind');
const api = await extension?.activate();
api?.reportUsage({ input: 1200, output: 340 });

// Or use the command instead of reportUsage:
// await vscode.commands.executeCommand('iceberg.report', { input: 1200, output: 340 });
```

| Member | Contract |
| --- | --- |
| `reportUsage(usage)` | Adds a report; missing fields are zero. Non-positive/non-finite values are ignored; positive values are rounded. |
| `getUsage()` | Current totals, optional budget (`0` = none), animation `health` (0–1), source (`otel` or `none`), basis, context, manual/legacy counts and metric/span drift. Only display a percentage for a measured/custom basis, never `unavailable`. |
| `onDidChangeUsage(listener)` | Usage snapshots; returns a disposable subscription. |

Types: [`IcebergApi`, `UsageReport`, `UsageSnapshot`](src/api.ts).
The meltdown demo never changes usage. `@iceberg` is counted only by automatic telemetry.

## Commands and settings

Search the Command Palette for **Iceberg** to open the habitat/dashboard, connect
telemetry, inspect diagnostics/stats, name the bear or toggle the meltdown demo.

Common settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `iceberg.tokenBudget` | `0` | No default target. Positive values opt into a personal fallback, not a Copilot limit. |
| `iceberg.trackCopilotChat` | `true` | Read transcript session IDs and reported credits, not consumed-token totals. |
| `iceberg.otel.enabled` | `true` | Read local telemetry. |
| `iceberg.otel.authoritative` | `true` | Include new telemetry usage in the meter; off makes it display-only. |
| `iceberg.otel.feedPath` | `""` | Override the feed path; otherwise follow Copilot's configuration. |
| `iceberg.otel.tracesDbPath` | `""` | Override trace-store discovery. |

Use **Settings → Iceberg** for polling, input/output counting, animation, pixel
scale, status bar and bear name. Turning telemetry off does not erase counted usage.

## Troubleshooting

- **No data:** reload after connecting, send a chat request, then run
  **Iceberg: Telemetry Diagnostics**. Check **View → Output → Iceberg**.
  Transcript credit comparison requires a VS Code build that persists usage metadata.
- **Quality is empty:** an active feed can have token data before any quality
  actions occur. Trace-store-only setups need a file feed.
- **Collector stopped:** clear `github.copilot.chat.otel.outfile` to restore OTLP;
  use the local trace store alongside it.
- **Duplicate menus:** remove old `local.iceberg-copilot` or
  `obrocki.iceberg-copilot` installs, then reload. `iceberg.*` settings remain valid.

## Development

```bash
npm ci
npm test
npm run vsix
```

The VSIX build typechecks, bundles and verifies the archive. Press `F5` for an
Extension Development Host. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture,
accounting invariants and release steps.

[MIT](LICENSE) © Dawid Obrocki
