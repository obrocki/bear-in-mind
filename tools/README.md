# Tools

Run `npm ci` first. No VS Code host is needed for these scripts.

| Command | Output |
| --- | --- |
| `npm run vsix` | Typechecked, bundled and verified VSIX. |
| `npm test` | Node tests using bundled TypeScript and a VS Code stub. |
| `npm run check:docs` | Markdown validation. |
| `npm run media` | All documentation screenshots, the melt GIF and the canvas shots. |
| `npm run media:shots` / `npm run media:gif` | Screenshots / GIF only. |
| `npm run media:canvas` | AI attribution canvas screenshots from synthetic stores. |
| `npm run media:icon` / `npm run media:activity-icon` | Marketplace / activity-bar icon. |

`build-vsix.js` is the shared local/CI packaging path. Run it with `--help` for
options; see [releases](../CONTRIBUTING.md#packaging-and-releases).

Screenshots use the real renderers in headless Chrome/Edge. Set `BROWSER_PATH`
for a nonstandard browser location. The GIF uses `scene-harness.js`, a Canvas2D
shim. Keep `shot.html` and `dashboard.html` in sync with the webviews.
To rebuild one screenshot: `npm run media:shots -- dashboard-waiting.png`.
Canvas shots start the real AI attribution canvas server, load synthetic SQLite
stores, and can be rebuilt one at a time, for example:
`npm run media:canvas -- canvas-coverage.png`.
`npm run media:canvas -- recipe-flow.png` generates the README's ordered
walkthrough as both SVG and PNG. The READMEs embed the PNG because Marketplace
packaging rejects the SVG image. `recipe-story.js` derives its dates and estimated
cost from the same verified synthetic cycle and mocked billing response as the
canvas, rather than maintaining a second story. It is an illustration, not a
live-canvas screenshot or a new API action.
Fixtures and the browser clock are fixed at 22 October 2026. Checks require
delivery steps in order, commits before the example PRs, review before merge and
closure after merge. The final billing card uses the report's read date, not the
earlier day being billed, and stays outside delivery counts and timings.
`node --test test/recipeStory.test.js` checks ordering, missing-data failures,
the calculated share and escaped labels; browser checks reject clipped cards.
The canvas harness also verifies live system theme changes, body-injected host
tokens, explicit Light/Dark overrides and body-text contrast of at least 4.5:1.
Main-view copy is also checked for unexplained codes and specialist terms.
Every tab checks for a single experimental-use footer outside the changing panel,
with theme-matching text and background. Complete-page previews include it.
Overview checks the mission/map/measurements order and the source connections,
including that the bill feeds a separate comparison rather than the delivery flow.
It includes light and dark shared-surface filters; it never reads live stores.
It also checks per-tab visible-word budgets, keyboard expansion and tab
navigation, disclosure state/focus after rendering, full evidence access and
390px layouts. Gaps and Research have their own synthetic previews.
Recipe checks developer/source filters, usage versus ownership and explicit
provider identity link/remove. Its account identities and API responses are synthetic.
Billing exercises the real client with an injected synthetic `gh` response:
explicit submission, native-user/day/model scope, amount precision and estimated
work costs. The setup preview expands the prerequisites/permissions checklist.
Dashboard shots include `dashboard-light.png`, both high-contrast variants and
`dashboard-sdk.png`. They emulate VS Code's body classes/semantic tokens, check
body-text contrast and verify that SVG paints follow live theme changes without
another snapshot. Browser debugging attaches only to the spawned profile's
ephemeral endpoint.

Preview `shot.html?health=0.3&chrome=0` or `dashboard.html?waiting` in a browser.
Both harnesses support `?context` for latest-prompt headroom; the dashboard also
supports `?empty` for a disconnected source and `?credits` to frame the
retained-trace credit breakdown.
Both harnesses support `?account` for synthetic combined account usage and a
reported plan allowance; these fixtures never authenticate or make quota requests.
