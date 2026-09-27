# 792 — Preview containment: measure reachability, not clipping

`e2e/preview-containment.spec.ts` selects every preview format from
`/home/preview-containment` in the browser mock. It runs a narrow details
split in every dock position at 80, 100 and 150 % zoom, at the default and
minimum dock sizes (`ALL_VIEW_MODES=1` adds list and tiles). It also runs an
800 px window at 150 %, the preview with `showPreviewInfo` off, SCM diffs
(a long repository path, and a staged file) and a git-graph commit
comparison.

## What the spec enforces

Each check reads rects in the page. `getBoundingClientRect` reports zoomed
pixels in both Chromium and WebKit, while `offsetWidth` and `scrollWidth`
report CSS pixels, so the spec divides rects by `--app-zoom` before comparing
them with its CSS-pixel limits.

- **Reachability.** The regions are the header, the diff actions, the content
  and the info. The spec walks every element and text box in each region
  (text via `Range.getClientRects`, since text can overflow its own element).
  Wherever a box leaves an ancestor that clips it along an axis, that
  ancestor must scroll along that axis and be reachable itself. Otherwise the
  box must be inline text truncated with an ellipsis. Truncation counts only
  for text and plain inline elements of a block container: `text-overflow`
  does not apply inside a flex or grid container, and it hides buttons and
  other atomic inlines whole. The content region may scroll vertically. It
  must never absorb horizontal overflow: that belongs to an inner scroller
  such as a table, a code block or the CSV surface. An SVG counts as one box.
- **Usable space.** The content region keeps at least 40 CSS px of height.
  The file name and the metadata each keep the smaller of their natural width
  and 96 CSS px. In the split cases every file list keeps 96 CSS px.
- **The page.** It never scrolls horizontally. WebKit reports a 1 px root
  `scrollWidth` excess at 150 % with nothing scrollable, so the spec allows
  1 px.

Each of these checks has failed on a deliberate regression:

| Regression | Check that fails |
| --- | --- |
| `.preview-text { white-space: pre }` | reachability |
| `.preview-text { max-height: 40px; overflow: hidden; flex: none }` | reachability |
| content region capped at 8 px | content height |
| dev's pre-#792 layout at the minimum vertical dock | content height, reachability |
| the first vertical-dock grid, `minmax(0, 1fr) auto` | name width, reachability |
| hunk actions without wrapping | reachability |

## What it found

- **Vertical docks at their minimum height showed no content.** The stacked
  header and the two-row info footer took about 140 CSS px against the 120 px
  minimum, so the content region collapsed to 0. Vertical docks now put the
  name, type and metadata on one grid row.
- **That row can starve one of its columns.** An `auto` metadata column grows
  to the nowrap width of a diff's path, and the grid widened past the pane.
  An `auto` badge did the same to the file name: at 150 % in an 800 px
  window the name was 0 px wide. The header column now takes what it needs,
  up to 65 % of the pane or all but 16rem, whichever is larger. The metadata
  column takes the rest as one ellipsized line. Within the header, the name
  comes first, and the badge ellipsizes down to a 3.5rem floor.
- **Hunk actions were clipped in the default right dock.** `.diff-content`
  clips, and the hunk header is a flex row, so "Discard hunk" fell off its
  end with no way to reach it. The actions now wrap below the range, and the
  range ellipsizes.
- **Frontmatter values broke one character per line in narrow panes.** A
  container query stacks the key above its value below 202 px. That is the
  properties box's 22 px, the 76 px key, the 8 px gap and a 96 px value. The
  default right dock (a 247 px container) keeps them side by side.

## Test mechanics that bite

- A new split pane selects its first entry once its listing arrives. A click
  before that is overridden, so wait for the active pane's `.selected`. A
  single pane has no `.explorer-pane.active`.
- At 150 % the list virtualizes rows away. Scroll the active pane's
  `.virtual-viewport` and let two animation frames pass before looking for the
  row.
- WebKit reports an SVG image's `naturalWidth` from its rendered box. Serve
  extreme-aspect fixtures as canvas-generated PNGs.
- A right dock keeps its preferred width however narrow the window is.
  Nothing caps it the way vertical docks are capped (#699). In an 800 px
  window at 150 % the default right dock leaves the explorer about 13 CSS px,
  so the narrow-window cases run only its minimum width.
- The committed screenshots are rewritten only with `CAPTURE_EVIDENCE=1`. An
  ordinary run writes them under `test-results/`.
