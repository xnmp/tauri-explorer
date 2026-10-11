# Small tiles: bare icon SVGs flex-shrink before the tile scale runs

Issue #1049 reported git-repo folders as *larger* than plain folders at the
Small tile preset. Measured in the browser, the git folder was the correct
size (48 px) and the plain folders were the wrong one (36 px).

`TileSurface` sizes every 64 px icon SVG with `transform: scale(iconScale)`.
The icon slot (`.tile-icon`) is a flex container whose width is the preset's
icon size. Small is the only preset whose slot (48 px) is narrower than the
64 px source SVG, so only Small shows the bug:

- a **bare `<svg width=64>`** (the plain folder, the minimal theme, the inline
  New folder tile) is a flex item that shrinks to the 48 px slot *before* the
  scale, and the 48 × 48 viewBox then draws at 36 px;
- a **wrapped icon** (`span.icon-cat` holding the SVG — the git-repo folder
  and every file icon) has a 64 px min-content width, does not shrink, and
  draws at 48 px.

Fix: `flex-shrink: 0` on the scaled icon children in `TileSurface.svelte` and
`InlineNewFolder.svelte`, so the scale alone decides the rendered size.

Testing note: the gate's unit command is `vitest run`, but the regression is a
layout result no Node-side seam can see. `tests/tiles-folder-icon-size.test.ts`
therefore spawns a private `vite dev` on a free port and measures the real page
with Playwright's Chromium (the CI unit job now installs that browser). The
fuller per-preset coverage and the evidence screenshots live in
`e2e/tile-folder-icon-size.spec.ts`. Vite binds `localhost` to `::1` here, so
poll `http://localhost:<port>/`, not `127.0.0.1`.

When a user reports one icon as "too big", measure all of them: the odd one out
may be the only correct one.
