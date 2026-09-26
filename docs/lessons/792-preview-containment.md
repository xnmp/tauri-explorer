# 792 — Preview containment: measure reachability, not clipping

`e2e/preview-containment.spec.ts` selects every preview format from
`/home/preview-containment` in the browser mock. It covers a narrow split, the
default and minimum dock sizes, every dock position, and 80, 100 and 150 %
zoom.

## Clipping hides overflow, so check reachability

`.preview-pane` and the root both clip (`overflow: hidden`). Content that
spills out of its region disappears silently, and a bounding-box-inside-the-pane
check passes. The spec walks every element and text box (text via
`Range.getClientRects`, since text can overflow its own element's box) in
each region: header, content and info. A box that leaves its region must sit
inside a scroller along that axis, and that scroller must itself be
reachable, or inside an ellipsis truncation.

The content region scrolls vertically by design. Horizontal overflow must be
absorbed by an inner scroller (a table, a code block, the CSV surface), never
by scrolling the whole preview sideways. Mutating `.preview-text` to
`white-space: pre` fails the spec; that proves it is not vacuous.

## What it found

- **Vertical docks at their minimum height showed no content.** The stacked
  header (name above type badge) and the two-row info footer took about 140
  CSS px against the 120 px minimum, in CSS pixels at every zoom. The
  content region collapsed to 0 and the footer was cut off. Vertical docks now
  put the name, type and metadata on one row, as in a bottom details pane, via
  a grid on `.preview-pane.vertical:not(.fullscreen)`. The right dock keeps
  its column.
- **Frontmatter values broke one character per line in narrow panes.** The
  property grid kept a 76 px minimum key column. A container query on
  `.preview-markdown` stacks the key above its value below 260 px.

## Test mechanics that bite

- A new split pane selects its first entry once its listing arrives. A click
  before that is overridden, so wait for the active pane's `.selected`.
- At 150 % the list virtualizes rows away. Scroll the active pane's
  `.virtual-viewport` and let two animation frames pass before looking for the
  row.
- WebKit reports an SVG image's `naturalWidth` from its rendered box. Serve
  extreme-aspect fixtures as canvas-generated PNGs.
- Zoomed layout rounds: WebKit reports a 1 px root `scrollWidth` excess at
  150 % with nothing scrollable, so the page-overflow check allows 1 px.
