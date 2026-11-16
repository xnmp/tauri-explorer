# #1705 — Crowded window tabs need bounded targets and persistent controls

The original tab strip prevented shrinking on both the list and each tab. Its
hidden scrollbar also contained New tab, so a crowded window hid the way to
create another tab along with the active tab and window controls.

- Measure the tab allocation in CSS pixels, preserve a readable active tab,
  and compress inactive tabs to a usable icon target. At extreme counts, scroll
  the tabs while keeping New tab and tab search outside that scroller. Reserve
  the titlebar's window controls and a real drag region before sizing the strip.
- Fixed-width tabs must give their title the remaining flex space. Otherwise
  the close glyph can sit at the tab's center, and an ordinary tab click closes
  it. The existing multi-pane close test caught this regression.
- Extracted component CSS must preserve the original ownership boundary.
  Limit the tab's folder-art fill rules to its own SVG; matching a special
  folder's wrapper would recolor imported pack artwork. Compare computed
  colors with the same icon in the sidebar, and keep Git glyphs stroke-only.
- Reveal on explicit activation as well as ID/geometry changes. Selecting the
  already-active tab from search must reveal it after manual strip browsing.
- A picker trigger and focusout dismissal must share ownership: moving focus
  to the trigger must not close the picker before its toggle handler runs,
  because that handler would immediately reopen it.
- Edge scrolling cannot stop merely because a frame did not change
  `scrollLeft`: the first RAF may have zero elapsed time, and a low velocity can
  round to zero on every frame. Accumulate fractional displacement and stop at
  a real boundary. Rebase if another scroll operation changes the position.
  Keep the RAF owned by the drag session and cancel it on drop, Escape,
  detachment, replacement, and unmount.
- At very narrow effective widths, reserve the selected label and use search
  for navigation instead of giving all available space to scroll arrows.

Regression coverage: `tests/domain/tab-strip.test.ts`,
`e2e/tab-overflow.spec.ts`, existing pane-tab/drag/file-drop suites, plus an
independent adversarial review of picker focus, same-tab activation, scrolling,
and cancellation. Browser tests establish UI outcomes; native transfer remains
on the existing reducer and transfer paths.
