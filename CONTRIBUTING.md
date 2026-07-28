# Contributing

Thanks for looking. This is a small project — a pixel-art scene, a token
accountant, and about 400 lines of glue.

## Getting set up

```bash
git clone https://github.com/obrocki/iceberg-copilot.git
cd iceberg-copilot
npm install
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then open the 🧊
icon in the activity bar.

| Command | What it does |
| --- | --- |
| `npm run compile` | Bundle `src/` into `dist/extension.js` with esbuild. |
| `npm run watch` | Same, but rebuilds on change. |
| `npm run typecheck` | `tsc --noEmit`. This is the gate CI enforces. |
| `npm run check:docs` | Balanced code fences and working relative links in every `.md`. |
| `npm run vsix` | Typecheck, production bundle, package, then verify the `.vsix`. |

`npm run vsix` is also the default VS Code build task
(<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>), and it is exactly what CI runs —
see [Packaging and releases](#packaging-and-releases).

There is no test runner wired up. `npm run typecheck` plus a manual pass in the
Extension Development Host is the current bar. If you add a test setup, that
would be a very welcome PR.

## How the pieces fit together

```
src/extension.ts    activation, commands, status bar, chat participant, the
                    exported API. Owns the wiring, no logic of its own.
src/tokenMeter.ts   the accountant. Holds input/output/credits/requests, derives
                    `health` (1 = pristine, 0 = melted), persists to globalState,
                    fires onDidChange.
src/chatWatcher.ts  reads VS Code's chat transcripts and turns them into usage
                    deltas. The subtle part of the project — see below.
src/habitatView.ts  webview plumbing for the sidebar view and the editor tab.
media/main.js       the entire renderer. No dependencies, no build step, plain
                    Canvas2D drawing at ~200x130 internal pixels.
media/style.css     the HUD under the canvas.
```

State flows one way: something reports usage → `TokenMeter` recomputes `health`
→ `onDidChange` → the webview gets a `state` message → `media/main.js` eases
toward the new health. The renderer never decides anything about usage.

## Working on `src/chatWatcher.ts`

This file is the easiest place in the project to introduce a bug that nobody
notices for a week. It tails append-only JSONL transcripts that VS Code writes,
and the format has several traps. All of these are real behaviours observed in
actual transcripts, and each one caused a wrong number before it was handled:

1. **Counters are cumulative and rewritten mid-turn.** During an agent turn,
   `requests/1/promptTokens` was seen going 23,516 → 36,611 → 48,836 → 76,876 →
   96,782 → 102,515 as tool calls ran. Summing the records over-counts about
   fivefold. Only growth is charged.
2. **`kind:0` snapshots replay history.** When VS Code starts a continuation
   transcript it opens with a full snapshot of the previous session, tokens and
   all. One real file carried 18.9M tokens in its first line. Anything a
   snapshot brings in is recorded as `base` and subtracted before charging.
3. **Request slots get reused.** Index 0 was observed serving three different
   requests across sessions. A counter going *down* means a new request landed
   in that slot; the old value is banked into `retired` so the earlier burn is
   not lost.
4. **Files get rewritten, not just appended to.** If `size < offset` the file is
   re-read from the top, and the already-charged amount is rebased *after*
   parsing, because whether the rewrite was a snapshot changes the arithmetic.
5. **The tail may be a partial line.** The read offset only ever advances past
   the last `\n`.

If you change the accounting, please say in the PR how you convinced yourself it
is right. Replaying your own real transcripts and comparing against a
independently-written total is the approach that has worked.

Things that are cheap and worth preserving: the string pre-filter before
`JSON.parse` (most lines are not token records), skipping files whose `stat.size`
has not moved, and refreshing the directory listing only every 30 seconds.

## Working on the renderer

`media/main.js` is loaded directly by the webview — there is no build step for
it, so you can edit and reload. A few conventions:

- Everything is drawn into a small internal buffer and upscaled with
  `image-rendering: pixelated`. Never draw at display resolution; it stops
  looking like pixel art immediately.
- The iceberg silhouette comes from a *seeded* noise profile terraced into
  facets, so the berg keeps its identity as it shrinks rather than morphing into
  a different mountain.
- Shading is derived from local surface slope, quantised to three levels. This
  is what makes it read as ice rather than as a hill. Please don't replace it
  with a vertical gradient.
- Respect `state.animate === false`: it must settle to a static frame and stop
  requesting frames.

### Regenerating the screenshots

`docs/media/*` is generated, not hand-made:

```bash
npm run media
```

That drives the real renderer twice — once in headless Chromium/Edge for the
stills that include the HUD, and once in a Node `vm` against a Canvas2D shim for
the animated GIF. Neither needs VS Code running. If you change the art, please
regenerate the images in the same PR so the README does not drift. See
[`tools/README.md`](tools/README.md).

## Packaging and releases

`tools/build-vsix.js` is the single build path — locally, in CI, and at release
time. Nothing runs `vsce` directly, so a build can't behave differently depending
on where it happened.

After packaging it reopens the archive and reads its central directory, because
`vsce` will happily produce a `.vsix` that is missing the bundle. It fails the
build if a required file is absent, if sources, source maps or `node_modules`
leaked in, if a contributed command doesn't appear anywhere in the bundle, or if
the manifest points at an asset that wasn't packaged.

```bash
node tools/build-vsix.js --help
```

| Workflow | Trigger | What it produces |
| --- | --- | --- |
| `ci.yml` | Push to `main`, pull requests | Build + verify on Linux, Windows and macOS. PRs also get an installable `.vsix` attached to the run. |
| `build-vsix.yml` | Merge to `main`, or manually | A `.vsix` artifact, plus a refresh of the rolling `dev` pre-release. The manual run can stamp a version or mark the build as a pre-release without committing anything. |
| `release.yml` | Pushing a `v*` tag | Verifies the tag matches `package.json`, attaches the `.vsix` to a GitHub release, and publishes to the Marketplace if `VSCE_PAT` is set. |

To cut a release: bump the version in `package.json`, run
`npm install --package-lock-only` so the lockfile follows (`npm ci` fails if it
doesn't), update `CHANGELOG.md`, then tag `vX.Y.Z`.

## Pull requests

- One change per PR. A rendering tweak and an accounting fix are two PRs.
- Run `npm run typecheck` before pushing.
- Include a screenshot for anything visual.
- Update `CHANGELOG.md` under an `## Unreleased` heading.
- Match the surrounding style: two-space indent, single quotes, semicolons, and
  comments only where something is genuinely non-obvious.

## Reporting bugs

If the iceberg is not melting, the two most useful things you can attach are the
output of **Iceberg: Show Usage Stats** and the last few lines of the **Iceberg**
output channel (View → Output → Iceberg). The output channel logs every batch of
tokens the watcher charges, so a silent channel and a silent iceberg together
narrow the problem down a lot.
