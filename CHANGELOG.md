# Change Log

## 0.2.1

- Open-sourced: README with generated screenshots and a melt animation,
  contributing guide, security policy, code of conduct, issue and PR templates,
  CI and release workflows, and Dependabot.
- **The extension now says out loud that it has no enforcement mechanism.** It
  cannot cap spend, throttle a request or change a bill — it only makes the burn
  visible, and relies on your compassion for the bear to do the rest. Stated in
  the panel, the status bar tooltip, the Marketplace description and the README.
- `npm run vsix` (or **Build VSIX** in the VS Code task list) now typechecks,
  bundles, packages *and reopens the archive to check what shipped* — required
  files present, no sources or source maps leaked, every contributed command
  actually present in the bundle, every referenced asset packaged.
- New **Build VSIX** workflow: every merge to `main` produces an installable
  `.vsix`, published to a rolling `dev` pre-release, and it can be run on demand
  from the Actions tab with an optional version stamp. Pull requests get a
  reviewable `.vsix` attached to their CI run.
- `tools/` now regenerates every image in `docs/media` from the real renderer
  (`npm run media`), so the screenshots cannot drift from the extension.
- **Extension ID changed** from `local.iceberg-copilot` to
  `obrocki.iceberg-copilot`. If you installed 0.2.0, uninstall it before
  installing this one, or you will have two bears.
- Fixed: the scene could not shrink below its last rendered resolution, so
  narrowing the sidebar clipped the HUD instead of reflowing it.
- Fixed: the Marketplace publish step in the release workflow could never run,
  because a step's `if:` cannot see a secret bound in that same step's `env:`.
- Fixed: an unclosed code fence in the README rendered most of the page as one
  code block on GitHub. `npm run check:docs` now catches that class of bug, and
  CI runs it.
- Fixed: the README relied on raw HTML — a `<table>` of screenshots, centred
  `<div>`s, a `<details>` block — which GitHub honours but sanitising markdown
  renderers drop, so the screenshots below the install section vanished. It is
  now plain markdown throughout, and `check:docs` rejects raw HTML.

## 0.2.0

- **Automatic Copilot Chat metering.** Iceberg now tails the chat transcripts
  VS Code writes to disk and charges the exact `promptTokens` /
  `completionTokens` / `copilotCredits` Copilot records per request, so normal
  Ask / Edit / Agent usage melts the iceberg with no `@iceberg` mention and no
  manual reporting.
- Handles the awkward parts of that format: counters are cumulative and
  rewritten mid-turn, request slots get reused, transcripts are rewritten, and
  continuation sessions replay history that must not be charged again.
- Existing history is adopted as a baseline on first run, so installing the
  extension never instantly melts the berg.
- Premium-request credits are tracked and shown in the status bar tooltip and
  usage stats.
- New settings: `iceberg.trackCopilotChat`, `iceberg.chatPollIntervalMs`.
- Default `iceberg.tokenBudget` raised to 5,000,000 to match real agent-mode
  usage.
- `Iceberg: Refreeze` re-baselines the watcher so a reset cannot re-import
  previous usage.
- New `Iceberg` output channel logging every batch of tokens charged.

## 0.1.0

- Initial release.
- Animated pixel-art iceberg + polar bear in the activity bar and in an editor tab.
- Iceberg size, walkable area, palette, cracks, calving and bear behaviour all
  driven by remaining token budget.
- Token sources: `@iceberg` chat participant, extension API, `iceberg.report`
  command, selection tokenizer, manual entry, meltdown demo.
- Status bar readout, persisted usage, configurable budget.
