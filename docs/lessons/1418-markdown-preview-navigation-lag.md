# #1418: arrowing through Markdown with the preview open lagged, worst with math

**Symptom:** with the preview pane open, moving the selection between Markdown
files lagged, and math-heavy files (KaTeX, #1393) were worst.

**Measured cause** (fixture `/home/math-nav`: 170-line files, 140 formulas
each; Chromium trace + in-page timing, see the PR for the numbers):
- A math file renders to ~625 KB of KaTeX HTML (~17,000 nodes, HTML plus
  MathML). Marked + KaTeX cost ~16–20 ms of JS. Laying out and painting
  the inserted document cost ~130 ms in Chromium and ~290 ms in WebKit, all in
  one task. Layout, not typesetting, was the dominant share.
- Every file the selection passed over was rendered in full, as long as its
  read finished before the next key. At key-repeat speed, each render held
  the main thread, so the next key (and the selection it moves) waited behind
  it.

**Fix:**
- `domain/markdown.ts` `renderMarkdownBlocks` yields the document as lazily
  typeset top-level blocks. Joined, they equal `renderMarkdown`'s output.
- `domain/progressive-reveal.ts` pulls those blocks one bounded slice per
  frame: 8 ms of JS or 48 KB of HTML, which stands in for layout cost. No work
  starts before the frame after the selection, and the reveal stops at the next
  slice boundary once the request is stale (`preview-lifetime`). A file passed
  over shows at most its first slice. The selection always paints first.
- `state/preview-content.ts` publishes each slice as a whole `PreviewContent`
  replacement (`blocks`, with `partial: true` until the last slice).
  `PreviewPane` keeps `aria-busy` set while the content is partial.
- A per-pane `domain/versioned-lru.ts` remembers complete renders, keyed by
  path and versioned by mtime, size and local revision. Going back to a file
  skips the read and the typesetting. Its layout still goes through the
  progressive reveal. Abandoned renders are never stored.

**Limits:**
- A slice is at least one top-level Marked token. A document whose math all
  sits in one list, blockquote or table is still typeset and inserted in one
  task (after the selection's frame, and only for the file the walk stops on).
  Splitting such a token would need well-formed per-item HTML.
- A complete math document now reaches its last block over ~13 frames
  (~250 ms at 60 fps) instead of one long task. The top shows in the first
  frame.
- A render made while KaTeX failed to load (`degraded`) is not cached, so the
  next visit retries the typesetter.

**Gotchas:**
- `content-visibility: auto` on the blocks cut Chromium's layout from ~150 ms
  to ~27 ms, but barely helped Playwright's WebKit (`hidden` still cost
  ~120 ms). It would also clip inline math that overflows a paragraph
  (paint containment). Slicing bounds the cost in both engines, so it was not
  adopted.
- The frame boundary is rAF followed by a task. rAF never runs in a hidden
  document, so a hidden document only yields. A frame fallback that is too
  short (100 ms) fired before WebKit's slow frames under load and rendered
  before the selection painted. The visible-document safety timer is 1 s.
- Tests that read the Markdown DOM must wait for the complete document
  (`aria-busy="false"`, or the last expected element), not for
  `.preview-markdown` to become visible. The first slice can be partial
  (`e2e/markdown-preview-colours.spec.ts`).
- `e2e/markdown-preview-navigation.spec.ts` paces its key repeat with page
  timers, not runner round trips. A timer cannot fire while a render holds the
  main thread. The old code therefore fails the "no file passed over is fully
  typeset" check, and runner stalls cannot fake a pass. Back-to-back
  `keyboard.press` calls arrive faster than the mock read, so the old code
  passed that version too.
