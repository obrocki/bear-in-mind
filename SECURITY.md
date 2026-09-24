# Security Policy

Only the latest released version receives fixes.

## Data handling

Bear in Mind meters local files:

- VS Code chat transcripts under `globalStorage/emptyWindowChatSessions/` and
  `workspaceStorage/<id>/chatSessions/`, for token counts and premium credits.
- The configured Copilot OpenTelemetry JSON-lines feed and read-only
  `agent-traces.db`, for metrics, timings and outcome labels.

Raw records may contain prompts, responses or tool content, especially with
`captureContent` enabled. Reading/parsing JSON is not content isolation: records
pass through memory. Known content-bearing attributes are discarded at the parser
boundary, not retained in aggregates, persisted or logged. Keep Copilot's
`captureContent` off when content should not be written to its feed at all.

Metering makes no network requests. The optional `@iceberg` participant sends its
chat request through VS Code's language-model API, like other chat participants.

Usage ledgers, bounded overlap evidence and file cursors are saved in VS Code's
local global state. **Connect Copilot Telemetry** also changes the selected Copilot
settings and creates the chosen feed directory. It warns before replacing an
OTLP exporter.

Disable readers with `iceberg.trackCopilotChat: false` and
`iceberg.otel.enabled: false`. This does not delete Copilot's existing files.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option, not a public
issue. Include reproduction steps and impact, without secrets or private chat
content. Expect acknowledgement within a week.
