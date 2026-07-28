# tools

Scripts the project builds and illustrates itself with. Nothing here needs a
native dependency, a package install, or VS Code.

## Building the extension

```bash
npm run vsix                      # typecheck, bundle, package, verify
node tools/build-vsix.js --help   # all the flags
```

`build-vsix.js` is the one build path — `npm run vsix`, the VS Code **Build
VSIX** task, and all three GitHub workflows call it, so a build behaves the same
wherever it runs. After `vsce` finishes it reads the archive's central directory
and fails if anything is missing, leaked, or unreferenced. See
[CONTRIBUTING.md](../CONTRIBUTING.md#packaging-and-releases).

## Regenerating the artwork

Everything in `docs/media` plus the extension icon. These drive the *real*
renderer — `media/main.js` and `media/style.css` — so the images can never
quietly disagree with what the extension does.

```bash
npm run media         # all of docs/media
npm run media:shots   # just the PNGs
npm run media:gif     # just melt.gif
npm run media:icon    # media/icon.png
```

| File | Purpose |
| --- | --- |
| `build-vsix.js` | Builds and then inspects the distributable `.vsix`. |
| `shot.html` | The webview markup from `src/habitatView.ts`, wired to the real CSS and renderer, with the state driven by a query string. |
| `grid.html` | Four `shot.html` frames side by side for the melt-progression image. |
| `make-screenshots.js` | Launches headless Chromium/Edge, drives it over the DevTools protocol, writes the PNGs. |
| `scene-harness.js` | A Canvas2D shim that runs `media/main.js` in a Node `vm`, so frames can be produced without a browser. |
| `make-gif.js` | Uses the harness to render the melt, quantises to a 255-colour palette by median cut, and writes a looping GIF89a with frame differencing. |
| `make-icon.js` | Draws the 128×128 marketplace icon on a 32×32 grid and encodes the PNG by hand. |

`make-screenshots.js` looks for Chrome or Edge in the usual places for your
platform; set `BROWSER_PATH` if yours is somewhere else.

`shot.html` mirrors the markup in `src/habitatView.ts` and has to be kept in sync
with it. It can also be opened directly in a browser while you work on the art —
for example `tools/shot.html?health=0.3&chrome=0`.
