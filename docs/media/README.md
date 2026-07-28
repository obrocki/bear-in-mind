# docs/media

Everything in this folder is **generated**, not hand-drawn. If you change
`media/main.js` or `media/style.css`, regenerate these so the README does not
drift from what the extension actually looks like.

| File | What it is |
| --- | --- |
| `hero.png` | Wide scene at 100% ice, no HUD. README banner. |
| `melt.gif` | The full melt plus a refreeze, ~106 frames. |
| `melt-progression.png` | Four panels at 100 / 60 / 28 / 0% ice. |
| `panel-full.png`, `panel-mid.png`, `panel-low.png`, `panel-melted.png` | The sidebar view at four budget levels. |
| `editor-view.png` | The wide editor-tab view. |

## How they are produced

Two mechanisms, both headless and both driving the *real* renderer rather than
any mock of it:

- **Stills** (`tools/make-screenshots.js`) load `media/style.css` and
  `media/main.js` into a page that reproduces the webview markup from
  `src/habitatView.ts`, then screenshot it in headless Chromium/Edge over the
  DevTools protocol. Because it is a real browser, the HUD, fonts and CSS are
  genuine. A query string sets the health level, so each shot is just a
  different URL.

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

