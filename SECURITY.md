# Security Policy

## Supported versions

The latest released version is the only one that receives fixes.

## What this extension touches

Iceberg is a visualisation, but it does read files, so it is worth being
explicit about what it does and does not do:

- **It reads VS Code's own chat transcripts.** To meter Copilot Chat usage it
  tails the `.jsonl` files VS Code writes under
  `<user-data>/User/globalStorage/emptyWindowChatSessions/` and
  `<user-data>/User/workspaceStorage/<id>/chatSessions/`. Those paths are derived
  from the extension's own `globalStorageUri`, never from user input.
- **It only reads token counters.** Lines are pre-filtered and only the
  `promptTokens`, `completionTokens` and `copilotCredits` fields are used. Prompt
  and response text is never parsed, stored, or logged.
- **It sends nothing anywhere.** There is no network access of any kind. Usage
  totals live in VS Code's global state on your machine.
- **It writes nothing outside its own storage.** The only thing persisted is the
  running total plus per-file read offsets, in `globalState`.

You can turn the transcript reading off entirely with
`"iceberg.trackCopilotChat": false`.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private reporting: go to the repository's **Security** tab →
**Report a vulnerability**. Include what you found, how to reproduce it, and what
an attacker could do with it.

You can expect an acknowledgement within a week.
