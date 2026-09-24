# Security Policy

## Supported versions

The latest released version is the only one that receives fixes.

## What this extension touches

Bear in Mind is a visualisation, but it does read files, so it is worth being
explicit about what it does and does not do:

- **It reads VS Code's own chat transcripts.** To meter Copilot Chat usage it
  tails the `.jsonl` files VS Code writes under
  `<user-data>/User/globalStorage/emptyWindowChatSessions/` and
  `<user-data>/User/workspaceStorage/<id>/chatSessions/`. Those paths are derived
  from the extension's own `globalStorageUri`, never from user input.
- **It reads Copilot Chat's OpenTelemetry output, when you connect it.** That is
  the JSON-lines file named by `github.copilot.chat.otel.outfile` and the
  `agent-traces.db` SQLite store, both on your own machine. The database is
  opened read-only. Neither is touched unless Copilot Chat is already writing
  it.
- **It only reads counters and enums.** From the transcripts: `promptTokens`,
  `completionTokens` and `copilotCredits`. From telemetry: token counts,
  durations, model names and outcome labels. Prompt and response text is never
  parsed, stored, or logged.
- **Content capture is ignored.** If you set
  `github.copilot.chat.otel.captureContent`, the feed will contain your prompts,
  responses, tool arguments and file contents. Bear in Mind discards
  `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.system_instructions`, `gen_ai.tool.call.arguments` and
  `gen_ai.tool.call.result` while JSON is parsed, so they are never retained,
  inspected, or written anywhere. It has no use for them and does not look.
- **It sends nothing anywhere.** There is no network access of any kind. Usage
  totals live in VS Code's global state on your machine.
- **It writes nothing outside its own storage.** The only thing persisted is the
  running total plus per-file read offsets, in `globalState`. The one exception
  is **Iceberg: Connect Copilot Telemetry…**, which writes
  `github.copilot.chat.otel.*` settings — and only the ones you pick, after
  telling you what each costs.

You can turn the transcript reading off with
`"iceberg.trackCopilotChat": false`, and the telemetry reading off with
`"iceberg.otel.enabled": false`.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private reporting: go to the repository's **Security** tab →
**Report a vulnerability**. Include what you found, how to reproduce it, and what
an attacker could do with it.

You can expect an acknowledgement within a week.
