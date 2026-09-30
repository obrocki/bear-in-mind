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

Preview `shot.html?health=0.3&chrome=0` or `dashboard.html?waiting` in a browser.
Both harnesses support `?context` for latest-prompt headroom; the dashboard also
supports `?empty` for a disconnected source and `?credits` to frame the
retained-trace credit breakdown.
