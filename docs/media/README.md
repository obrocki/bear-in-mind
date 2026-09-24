# docs/media

Everything in this folder is **generated**, not hand-drawn. If you change
`media/main.js`, `media/style.css`, `media/dashboard.js` or
`media/dashboard.css`, regenerate these so the README does not drift from what
the extension actually looks like.

| File | What it is |
| --- | --- |
| `hero.png` | Wide scene at 100% ice, no HUD. README banner. |
| `melt.gif` | The full melt plus a refreeze, ~106 frames. |
| `melt-progression.png` | Four panels at 100 / 60 / 28 / 0% ice. |
| `panel-full.png`, `panel-mid.png`, `panel-low.png`, `panel-melted.png` | Synthetic demo ice at four levels, without recording usage. |
| `panel-context.png` | Illustrative reported prompt allowance, separate from cumulative tokens. |
| `editor-view.png` | The wide editor-tab view. |
| `dashboard.png` | Representative session comparisons with the default unscaled ice gauge. |
| `dashboard-context.png` | The same dashboard with a reported prompt allowance. |
| `dashboard-waiting.png` | A flowing telemetry feed awaiting quality signals. |
| `dashboard-empty.png` | The dashboard before any telemetry is connected. |

## How they are produced

Three mechanisms, all headless and all driving the *real* renderer rather than
any mock of it:

- **Stills** (`tools/make-screenshots.js`) load `media/style.css` and
  `media/main.js` into a page that reproduces the webview markup from
  `src/habitatView.ts`, then screenshot it in headless Chromium/Edge over the
  DevTools protocol. Because it is a real browser, the HUD, fonts and CSS are
  genuine. A query string sets the health level, so each shot is just a
  different URL.

- **Dashboard shots** use the same driver against `tools/dashboard.html`, which
  loads the real `media/dashboard.css` and `media/dashboard.js` and posts one
  representative snapshot into it. The sample figures are fixed and the
  sparkline wobble is deterministic, so re-running the tool does not churn the
  PNG. `?empty` renders the not-yet-connected state.

- **`melt.gif`** (`tools/make-gif.js`) runs `media/main.js` inside a Node `vm`
  against a minimal Canvas2D shim, steps the animation clock by hand, captures
  the raw pixel buffer each frame, quantises to a 255-colour global palette by
  median cut, and LZW-encodes a GIF89a with frame differencing and a transparent
  index for unchanged pixels.

Neither path needs a native dependency, and neither needs VS Code running.

```bash
npm run media
```

See [`tools/README.md`](../../tools/README.md) for the details.
