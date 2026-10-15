# #1044 - symlinked folder tile icon larger than a real folder's

Tile icons are 64px glyphs scaled by `transform: scale(displaySize / 64)`. A bare folder `<svg>` is a direct flex item of `.tile-icon` and shrank to the 48px small tile first, then was scaled again (36px). The linked folder is a `span.icon-cat` that cannot shrink below its content, so it stayed at the intended 48px and looked larger.

Fix: scaled direct children of `.tile-icon` carry `flex-shrink: 0` (TileSurface, InlineNewFolder). Regression: `tests/ui/tile-icon-size-contract.test.ts` and `e2e/linked-folder-tile-size.spec.ts` (compares real vs linked folder boxes at every tile size).

Gotcha: a dev server on :1420 may belong to another worktree; check `/proc/<pid>/cwd` before trusting a Playwright run that reuses it.
