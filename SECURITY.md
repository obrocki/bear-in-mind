# Security Policy

Only the latest released version receives fixes.

## Data handling

Bear in Mind meters local files:

- VS Code chat transcripts under `globalStorage/emptyWindowChatSessions/` and
  `workspaceStorage/<id>/chatSessions/`, in JSON or JSONL format, for session
  IDs, custom titles, model names and reported credits. The read-only
  `state.vscdb` query reads only `chat.ChatSessionStore.index`, for displayed
  titles (including generated titles) and activity timestamps. Token snapshots
  and prompt/response/tool content are not retained. Custom profiles resolve
  the default-profile history and shared workspace storage.
- The configured Copilot OpenTelemetry JSON-lines feed and read-only
  `agent-traces.db`, for metrics, timings and outcome labels.

From span metadata the dashboard also shows repository and branch names
(`github.copilot.git.*` on agent spans, with any credentials in remote URLs
removed and local filesystem remotes dropped), Copilot caller names, tool names
and span status, and a short
reasoning-effort word taken from `copilot_chat.request.options`; the rest of that
options blob is discarded. When Copilot's identity capture
(`github.copilot.chat.otel.captureIdentity`) is on, it also reads `user.name`,
your GitHub account, from agent spans to group credits by user and label
sessions. These are held in memory for the retained seven-day window and are
not persisted.

Raw records may contain prompts, responses or tool content, especially with
`captureContent` enabled. Parsing briefly passes records through memory.
Transcript prompt/response/tool content and token snapshots are not retained;
displayed session titles are held in memory. Generated titles may summarize
prompt content; the extension does not reconstruct them from messages.
Known telemetry content attributes are removed
before aggregation, persistence or logging. Keep Copilot's `captureContent` off
when content should not be written to its feed at all.

Local metering makes no network requests. Account requests require an explicit
connection through **Refresh Copilot Account Usage**, an authorized VS Code
GitHub session, and `iceberg.accountUsage.enabled` on (default). Once connected,
the extension requests `https://api.github.com/copilot_internal/user` once a minute.
This is GitHub's **unofficial** quota endpoint used by VS Code. Automatic
refreshes do not prompt; **Refresh Copilot Account Usage** can request sign-in
and authorization. Only the authentication credential is sent to GitHub, not
local transcripts, titles, telemetry or usage ledgers. Requests have a fixed
origin, do not follow redirects, time out, and bound response sizes. HTTP/schema
failures are visible without logging response bodies or credentials.
Plan/quota data is held only in memory and cleared on failed refreshes or
account changes; stale/reset quotas cannot drive the account gauge.
The connection opt-in is saved separately from the GitHub authentication grant.
The optional `@iceberg` participant sends its chat request through VS Code's
language-model API, like other chat participants.

Usage ledgers, bounded overlap evidence and file cursors are saved in VS Code's
local global state. **Connect Copilot Telemetry** also changes the selected Copilot
settings, records their previous user values, and creates the chosen feed
directory. It warns before replacing an OTLP exporter, and turns on identity
capture only if you accept a separate prompt, which notes when a connected OTLP
collector would receive the identity too.

Disable readers with `iceberg.trackCopilotChat: false` and
`iceberg.otel.enabled: false`; disable quota API requests with
`iceberg.accountUsage.enabled: false`. This does not delete Copilot's existing files.
**Restore Defaults and Disconnect** puts the Copilot settings back to their
previous values, resets Bear in Mind's user settings, and deletes its stored
state and its own global-storage folder (the default feed). It also immediately
clears the published account quota and resets the connection opt-in, so requests
do not resume after reload without an explicit reconnect. The GitHub
authentication session is left intact for other extensions. That folder is kept
while Copilot is still set to write there, and a feed at a custom
`iceberg.otel.feedPath` is not deleted. Copilot's trace store and transcripts
are untouched.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option, not a public
issue. Include reproduction steps and impact, without secrets or private chat
content. Expect acknowledgement within a week.
