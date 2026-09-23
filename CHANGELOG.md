# Change Log

## Unreleased

- **The ice now measures the context window.** It used to be cumulative lifetime
  tokens divided by a number you typed into `iceberg.tokenBudget`, which was the
  one arbitrary figure left in the product. `copilot_chat.request.max_prompt_tokens`
  rides on every `chat` span, so the berg can track something real instead: how
  much of the model's context window the current session is using. It needs no
  configuring, it climbs through an agent turn as context accumulates, and it
  refreezes by itself when a session ends or the context is summarised. Cumulative
  burn against the budget remains the fallback until the trace store is connected,
  and the panel always says which of the two you are looking at.
- **Bear in Mind now meters from OpenTelemetry.** Copilot Chat can emit traces,
  metrics and events following the
  [GenAI semantic conventions](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md),
  which is a documented, supported interface — unlike the private chat
  transcript format the meter has been reverse-engineering. When telemetry is
  reporting it holds the meter, and the chat transcripts fall back to being the
  safety net for when it is not. Run **Iceberg: Connect Copilot Telemetry…** to
  set it up.
- **The two sources are reconciled, not added.** They observe the same traffic,
  so summing them would double every number. They share one ledger and only
  whichever is authoritative charges it; handing over mid-flight carries the
  balance, so the ice never jumps. Both keep running either way, which is what
  makes the drift readout on the dashboard possible: it shows what each source
  saw over the window in which both were watching, and says plainly whether
  they agree.
- **New: a cost, speed and quality dashboard.** Three sections — **Cost** in
  tokens, **Speed** in session duration, **Quality** from PR and IDE signals.
  Open it with **Iceberg: Open Token Dashboard**, or from the new sidebar view.
  Sections with no data say so and name the signal that is missing, rather than
  showing a confident zero. Its palette is taken from the scene above it — the
  ice, the aurora and the low sun — so the numbers and the berg read as one
  product.
- **Fixed: connecting the file feed produced nothing.** Copilot Chat's file
  exporter opens its write stream with `createWriteStream`, which does not
  create parent directories, so pointing it at a folder that did not exist yet
  meant every record was silently dropped — while VS Code cheerfully reported
  monitoring as enabled. The connect command now creates the directory first.
  It also writes each setting individually and checks it is registered, so one
  key an older Copilot Chat does not know about can no longer abort the rest of
  the setup, and it reports what it actually managed to change.
- **Fixed: a handover double-charged the traffic that triggered it.** `observe`
  refreshed the telemetry timestamp *before* reading which source was
  authoritative, so the delta that promoted telemetry was charged on top of the
  transcript delta for the same request — and again after every idle spell
  longer than the staleness window. Authority is now decided from the state as
  it stood before the delta arrived, and the feed being alive keeps telemetry
  authoritative through idle spells.
- **Fixed: the first drift report accused two agreeing sources of disagreeing.**
  Opening the comparison window zeroed both counters and then immediately
  recorded the telemetry delta, whose transcript counterpart had been recorded
  before the window existed — reporting 100% disagreement. The delta that opens
  the window is no longer counted on either side.
- **Fixed: evicted metric series leaked across filtered queries.** Series
  dropped under the memory cap were folded under their metric name alone, so an
  evicted input-token series was added to the output-token total as well, and
  `tokensByModel` ignored them entirely. Folded series now keep their attributes
  and are visible to every query.
- **Fixed: the cost headline could contradict itself.** It took its total from
  the telemetry rollup but its percentage from the meter, which have different
  baselines by design, and it labelled a context-window percentage as budget
  remaining. Both now come from the same ledger, and the label follows what is
  actually being measured.
- **Quality includes what you actually did.** Thumbs up and down
  (`copilot_chat.user.feedback.count`) get their own block with a positive rate,
  alongside `copilot_chat.user.action.count` — how many responses were applied,
  inserted, copied or followed up. Votes are the explicit signal and engagement
  is the implicit one; copying or applying an answer costs something, so both are
  shown rather than collapsed into a single score.
- **Two telemetry sources, because neither is sufficient alone.** The local
  trace store (`agent-traces.db`) carries real spans with exact session timings
  and the context-window limit, and runs happily beside an OTLP collector you
  already use. The JSON-lines file feed carries the metrics and log records the
  quality section is built from, but *replaces* your exporter — setting
  `outfile` forces `exporterType` to `file` upstream. The connect command
  explains the trade-off and asks before replacing anything.
- **Removed the manual accounting controls.** Telemetry reports consumption
  exactly and automatically, so **Budget…**, **Refreeze**, **Add Tokens
  Manually…** and **Count Selection as Prompt Tokens** no longer earn their
  place. The buttons are gone from the habitat panel and the commands are gone
  from the palette. `iceberg.tokenBudget` remains as a setting because the
  fallback melt needs a denominator, but it is no longer something to enter.
- **Refreezing is automatic now.** A cumulative counter going backwards means
  the feed restarted, so the meter re-baselines itself rather than charging a
  negative delta or billing the same tokens twice. That was the only thing the
  manual refreeze was really for.
- **Spans in the file feed are skipped on purpose.** Since OpenTelemetry JS SDK
  v2 the span implementation keeps its state in private class fields, which
  `JSON.stringify` cannot see, so every span in the file feed serialises to
  `{}`. Verified against `@opentelemetry/sdk-trace-node` 2.11.0. That is why
  exact timings and context headroom need the SQLite store, and why the dashboard
  counts skipped spans instead of pretending they were not there.
- **Fixed: the screenshot harness was rendering blank scenes.** `tools/shot.html`
  reproduces the webview markup by hand, so the HUD changes left `main.js`
  calling `addEventListener` on a button that was not there — which threw before
  the first frame and produced an empty canvas. The renderer now treats every
  HUD control as optional, and the harness was brought back in step.
- **There are tests now.** `npm test` covers the parsing and aggregation against
  a fixture produced by driving the real OpenTelemetry SDK through exporters
  that replicate Copilot Chat's own, so the record shapes under test are the
  shapes the extension will actually meet.

## 0.4.0

- **New activity bar icon.** The sidebar icon is now the bear's face with a
  snowflake, replacing the iceberg — the iceberg is what the panel already
  shows, so the icon says who is standing on it. Generated by
  `tools/make-activity-icon.js` (`npm run media:activity-icon`) rather than
  hand-drawn, because VS Code paints this file as a CSS *mask*: colour is
  discarded and only alpha survives, so the eyes and nose have to be holes
  punched through the head rather than dark shapes on top of it, and partial
  opacity is the only way to get a second tone. `media/icon.png`, the
  Marketplace tile, still shows the full scene.
- **Renamed to Bear in Mind.** The repo moved to
  `github.com/obrocki/bear-in-mind` (the old URL redirects) and the extension id
  changed from `obrocki.iceberg-copilot` to `obrocki.bear-in-mind`. The name is
  the product: there is no enforcement here, only a bear you might bear in mind.
  Everywhere the extension referred to *itself* now says Bear in Mind — the
  status bar tooltip, the panel's "can't cap your spend" note, the
  duplicate-install warning, and the docs. Screenshots were regenerated to
  match. Things that name the *iceberg on screen* keep their names: the
  `Iceberg:` commands, the Habitat view, the `Iceberg` output channel.
- **Your settings and keybindings are unaffected.** The `iceberg.*` setting,
  command and view ids were deliberately *not* renamed. Two reasons: renaming
  them would silently reset everyone's configuration, and the duplicate-install
  guard finds a stale copy by matching contributed ids — so had they changed,
  the old and new copies would share nothing, the guard would stay quiet, and
  the doubled menus would be back.
- **You may need to remove the old copy.** Because VS Code keys an extension on
  `publisher.name`, this installs alongside `obrocki.iceberg-copilot` rather
  than upgrading it. The guard added in 0.3.0 detects that and offers to
  uninstall the old one; if you would rather do it yourself:
  `code --uninstall-extension obrocki.iceberg-copilot`

## 0.3.1

- Fixed: the duplicate-install guard added in 0.3.0 matched on the literal
  extension name `iceberg-copilot`, which made it blind to the one situation it
  exists to catch — a rename. Worse, it failed asymmetrically: a renamed copy
  would stand down, but the *older* copy would activate happily and keep its
  usage watcher running, which is the half that quietly charges a second meter.
  Conflicts are now detected by comparing contributed view and command ids
  against the other installed extensions, which is the condition that actually
  breaks, so any future rename stays safe. If the manifest cannot be read, it
  falls back to the extension name taken from our own id rather than a
  hardcoded one.

## 0.3.0

- Fixed: **duplicated menu items and toolbar buttons.** The publisher changed
  from `local` to `obrocki` in 0.2.1, and because VS Code keys an extension on
  `publisher.name`, that made 0.2.1 a *different* extension — the old copy
  stayed installed alongside it. Both claimed the same view, the same commands
  and the same chat participant, so every menu entry appeared twice, whichever
  copy activated second died with "already registered", and its usage watcher
  kept charging a second meter the user could not see. Iceberg now detects a
  second copy of itself, registers nothing, and offers to uninstall the other
  one instead of failing obscurely.
  **If you installed 0.2.0, uninstall `local.iceberg-copilot`.**
- New **Iceberg: Name the Bear…** command: a quick pick of suggested names
  grouped as arctic (`Siku`, `Isbjørn`, `Knut`), burn-rate puns (`Frostbyte`,
  `Burnie`, `Calvin`) and soft (`Teddy`, `Pudge`), plus free text. The default
  is still `Nanuq`, Inuit for "polar bear".

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
