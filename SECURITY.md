# Security Policy

Only the latest released version receives fixes.

## Data handling

Bear in Mind meters local files:

- VS Code chat transcripts under `globalStorage/emptyWindowChatSessions/` and
  `workspaceStorage/<id>/chatSessions/`, for token counts and premium credits.
- The configured Copilot OpenTelemetry JSON-lines feed and read-only
  `agent-traces.db`, for metrics, timings and outcome labels.

From span metadata the dashboard also shows repository and branch names
(`github.copilot.git.*` on agent spans, with any credentials in remote URLs
removed and local filesystem remotes dropped), Copilot caller names, tool names
and span status, and a short
reasoning-effort word taken from `copilot_chat.request.options`; the rest of that
options blob is discarded. These are held in memory for the retained seven-day
window and are not persisted.

Raw records may contain prompts, responses or tool content, especially with
`captureContent` enabled. Reading/parsing JSON is not content isolation: records
pass through memory. Known content-bearing attributes are discarded at the parser
boundary, not retained in aggregates, persisted or logged. Keep Copilot's
`captureContent` off when content should not be written to its feed at all.

Metering makes no network requests. The optional `@iceberg` participant sends its
chat request through VS Code's language-model API, like other chat participants.

Usage ledgers, bounded overlap evidence and file cursors are saved in VS Code's
local global state. **Connect Copilot Telemetry** also changes the selected Copilot
settings, records their previous user values, and creates the chosen feed
directory. It warns before replacing an OTLP exporter.

Disable readers with `iceberg.trackCopilotChat: false` and
`iceberg.otel.enabled: false`. This does not delete Copilot's existing files.
**Restore Defaults and Disconnect** puts the Copilot settings back to their
previous values, resets Bear in Mind's user settings, and deletes its stored
state and its own global-storage folder (the default feed). That folder is kept
while Copilot is still set to write there, and a feed at a custom
`iceberg.otel.feedPath` is not deleted. Copilot's trace store and transcripts
are untouched.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option, not a public
issue. Include reproduction steps and impact, without secrets or private chat
content. Expect acknowledgement within a week.
