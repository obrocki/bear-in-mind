# AI attribution canvas

A [GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
canvas for Workstream 2 (Data and Attribution Model). It shows how Copilot
telemetry from VS Code, Copilot CLI, the Copilot app and the cloud agent connects
AI usage to work and outcomes.

It renders [the research](../../../docs/research/ai-telemetry-attribution.md) and
[the model spec](../../../docs/research/attribution-model.json), and adds live,
read-only coverage from this machine.

## Views

| Tab | Shows |
| --- | --- |
| Outcomes | Live coverage metrics, credit-weighted funnels, desired outcomes and what unlocks each |
| Surfaces | Concept × surface matrix with native / partial / missing / unverified fields |
| Data model | Entities, relationships, attribution tiers and accounting invariants |
| Gaps | Gaps by impact, verification status and prior art |
| Live coverage | Per-source funnel, breakdowns by model, agent, reasoning effort, repository and tools |
| Research | The rendered research document and sources |

## Live coverage

| Source | Default location |
| --- | --- |
| Copilot CLI / app session store | `$COPILOT_HOME/session-store.db` (default `~/.copilot/`) |
| VS Code span store | `globalStorage/github.copilot-chat/agent-traces.db` for Code and Code - Insiders |

Stores are opened read-only. If the file is locked, a temporary copy is read and
then deleted. Only aggregates are produced (counts, token and credit sums, and
model, agent, tool and repository names); prompt, response and tool content is
never read. Nothing leaves the machine, and the two sources are shown side by
side rather than summed.

## Use

The app loads project extensions from `.github/extensions/`. Ask Copilot to open
the **AI attribution** canvas, or have the agent call:

```text
open_canvas({ canvasId: "ai-attribution", instanceId: "attribution", input: { view: "outcomes", windowDays: 30 } })
```

| Action | Input | Result |
| --- | --- | --- |
| `show_view` | `{ view }` | Switches tab |
| `refresh_coverage` | `{ windowDays? }` | Recomputes coverage; returns a summary |
| `get_coverage` | — | Full coverage object |
| `get_model` | `{ section? }` | Model spec or one section |

Open input also accepts `sessionStorePath` and `tracesDbPath` overrides.

## Layout

| File | Role |
| --- | --- |
| `extension.mjs` | Canvas declaration, actions and per-panel state |
| `lib/coverage.mjs` | Store discovery and coverage computation |
| `lib/server.mjs` | Loopback HTTP server, JSON API and server-sent events |
| `lib/model.mjs` | Loads the committed research files |
| `ui/` | Static front end (no build step, no dependencies) |

After editing, reload extensions in the app. Tests live in
[`test/attributionCanvas.test.js`](../../../test/attributionCanvas.test.js).
