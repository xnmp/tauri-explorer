# #1365 — List peek-in-place: opening a folder and +N more never move its header

**Symptom:** clicking a large List folder that had been expanded with "+N more"
restored its remembered column stage: a full-height card that did not fit below
the folder's row, so the header jumped to the next column, the pane panned
sideways to reveal it, and later items moved two columns over.

**Rule:** the row the user clicked stays under the pointer — the rule spring
peeks already followed (#1242).

**Fix:**

- Every open folder's header carries `fit: SPRING_CARD_FIT` (3) in
  `sizeListModel`, whether it heads a compact card or a spilled/full-flow group
  (`columnFlow` now honours `fit` on plain one-slot items too). It keeps its
  place while 3 slots remain, a card shrinking to the rows left; otherwise it
  starts the next column. Because every stage uses the same fit, changing stage
  can never move the header. `springCardFits` lost its "held card" fits: the
  base fit already keeps a card holding a temporary peek in place. Only the
  legacy scrollable column keeps no fit.
- New `spill` stage. `buildListStructure` emits a spilled folder's rows as
  ordinary slots (like full flow) and records the group (`ListFlowGroup`).
  The cap depends on R and on the header's row, so it is applied while flowing:
  `cutSpills` flows only the prefix up to each spilled header, cuts the group to
  `listSpillCap(R, row)` slots (rest of the column + the next; R for a header on
  the last row) and appends a `more` item that leads to full flow. Hidden rows
  get `entryItem = -1`; End skips them.
- Nested groups at the cut: `fullFlowGuideSpans` ends a guide at the group's
  last *shown* row and draws none for a group wholly behind the cut.
- Stages: compact → spill → full ("+N more"), Less → compact from every stage,
  and the session forgets a folder's stage whenever it closes or is toggled
  (`rememberWhileExpanded`, as for Tiles panel sides), so a click always opens the compact card.

**Gotchas:**

- A spill always ends at a column's bottom (the cap fills the next column), so
  Down from the last spilled row stops there like any column end, and items
  after the folder start a fresh column.
- With fit 3 a header can reach the last row only while closed: opened, it
  starts the next column, so "a header on the last row" spills over its new
  column and the next. `listSpillCap` still handles a last-row header.
- The column stage (#1324) is now unreachable from the UI; its Less (#1360) is
  tested by staging it directly. Retire it in a follow-up.
- Test the no-move invariant over every header row and several R values
  (`list-cards.test.ts`); a single position hides the bottom-of-column cases.
- Startup budget: `list-column-flow.ts` is eager (keyboard navigation imports
  it) while `list-cards.ts` loads with the List view. `columnFlow` moved to
  `list-cards.ts`, its only production caller, which more than paid for the
  spill code (startup gzip fell ~300 B instead of rising).
