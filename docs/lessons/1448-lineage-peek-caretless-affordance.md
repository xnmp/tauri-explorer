# #1448 — caret-less peek hid lineage edits with no pointer way in

With `folderPeekCarets: false`, Folder Peek gives a folder row's click to its
peek and shows a hover Open action instead of a caret. Lineage parents (files
whose edits Show traces groups under them) fell between the two rules: no
caret (carets off), no row-click toggle (`rowClickOwnsPeek` is folder-only, so
an image click still selects and previews) and no Open action (folders only).
`canPeekEntry` was true, but only the keyboard Peek command could reach it.

Fix: `rowShowsPeekToggle` (domain/folder-peek-flat.ts) is the third affordance,
exactly for caret-less, peekable non-directories, using the caret's own
`canPeek` input (peek on here and something to peek). Every peekable row in
caret-less mode now has exactly one pointer affordance (unit-tested as an
invariant). The toggle sits at the row's trailing edge, where caret-less rows
keep Open, rather than in a leading caret slot: caret-less rows have no slot,
so a leading caret would shift the parent's icon onto its children's indent and
cross the peek guides.

When adding a new peekable kind, check all three predicates (`caretsShown`,
`rowClickOwnsPeek`, `rowShowsPeekToggle`) and the `isPeekControl` selectors in
`FileItem.svelte` and `EntryCell.svelte`, which keep a control's click from
also selecting or dragging the row.
