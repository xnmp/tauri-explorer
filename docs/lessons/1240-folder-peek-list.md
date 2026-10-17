# List cards (#1240, folder peek phase 3)

An open top-level folder in the column-flow List is a card: `buildListModel`
(`domain/list-cards.ts`) turns the shared peek rows into top-level items, and a
card spans `1 + visibleRows` slots, `visibleRows = min(content, clamp(preferred,
1, floor(0.7R)))`, so it always fits one column. Rendering, reveal, keyboard
moves and motion all read that one model.

## Keep the header node stable

The header row renders outside `{#if item.card}` in the slot; `ListCard` adds
only the scroll area and "+N more" below it (the grip lives in the header, see
below). Swapping a plain row for a
card component destroyed the focused row on every toggle (carets-off clicks and
palette commands keep focus on it).

## Each items, not deriveds, for rows a blur can read

`{@const row = …}` and destructured `{#each … as { item }}` values are deriveds
owned by the block. A rename input's blur fires after Enter has re-sorted the
listing and destroyed its slot, then reads the row through `EntryCell`'s
`entry` prop: `derived_inert` (failed `list-column-flow` "rename survives
horizontal virtualization" deterministically). Map rows into plain objects in
`<script>` (`slots`, `mounted`) and iterate those.

## Mounted slot identity

`useListColumns.visibleItems` returns one object per placement for the layout's
lifetime (a `WeakMap` keyed by placement). Mapping fresh `{ placement, item }`
objects on every mounted-range change made the keyed each update every slot
that stayed mounted; with cards' extra per-slot expressions that cost the
sideways wheel about 15% over phase 2. With stable objects only entering and
leaving columns do work: in the perf sweep the wheel's renderer task time fell
below phase 2 (1667ms vs 2884ms median, sequential runs on the same machine).
The caret is absolutely positioned in a padding gutter, so file rows carry no
blank slot element.

## Drop feedback on a surface with rows inside

A card's scroll area is a drop target for its folder, but its rows are their
own targets (folders) or none (files). Moving onto a row fires no `dragleave`
on the surface (the row is inside it), so the surface's feedback must be
retired explicitly (`releaseDropTarget`), or it sticks after a drag ends over
a file row.

## Ghost rule in practice

Styling uses look classes (`list-place`, `list-card-box`, `list-entry`,
`list-card-scroll`); queries use identity classes and attributes (`.list-slot`,
`.entry-item`, `.list-item`, `[data-card-scroll]`, `[data-path]`,
`.peek-drop-target`). Ghost clones drop every identity class and every
`data-*`/`aria-*`/`role`/`tabindex` attribute and live in an `inert`,
`aria-hidden` layer, so marquee, drop resolution, FileList focus and the motion
composable's own `data-motion-key` lookup can never reach them. A new layout
always calls `finish()` first: rAF cancelled, ghosts removed, inline
`transform`/`clip-path`/`visibility`/`height` cleared, so an interrupted toggle
starts from a clean final frame.

## Which changes animate

`explorer.peekChange` changes only on user toggles and collapse-all. An open
stays armed until its listing leaves `loading` (at most 1.5s), because the
card's rows arrive after the toggle. Refreshes, navigation, restores, R changes,
reduced motion and grip commits are instant; the grip's preview has already
shown the new height, so animating its commit would snap back first.

Reveal is decoupled from the motion arm (`stepMotionArm`, pure and unit
tested): a card that wraps to the next column only once a listing slower than
the arm settles is still scrolled into view, and an open whose motion a
refresh interrupts carries its owed reveal through `finish(false)`.

Closing a card animates only a ghost of its body: the live header never takes
`visibility: hidden`, which would drop a focused header's focus to `BODY`
(caret, carets-off click and Escape all close with focus on the header).

## Card scroll state

A card scroll changes which rows are mounted just as a sideways scroll does, so
`setCardScrollTop` notifies FileList (`onviewportscroll`: tab-stop fallback,
marquee) and drop hover once per frame. A grip preview whose card closes before
its cancel arrives is dropped with the card's other per-card state.

The grip's drag session also lives in `useListColumns` (`beginGrip`,
`gripKey`, `gripMax`), ended by window-level `pointerup`/`pointercancel`/`blur`
listeners. Grip-local state was stranded when a sideways wheel unmounted the
card's column mid-drag (a covered slot, a `.dragging` grip and a stale preview
survived the release). The preview, keys and `aria-valuemax` stop at the rows
left below the header in its column: a resize that no longer fit pushed the
card into the next column, out of view. `ListCard`'s surface drop feedback is
the importable `composables/surface-drop-feedback.ts` for the same reason
(#444).

`useListColumns` owns card offsets. Reveal writes the offset synchronously
(`cardRevealTop`), so the row is in the card's mounted window when FileList
focuses it a tick later; `ListCard` applies the offset to the DOM in an effect
and reports native scrolling back. A card that can still scroll takes a vertical
wheel natively (no `preventDefault`), then the List's sideways mapping resumes.

## A peek List is a tree, not a listbox

Rows with `aria-level`/`aria-expanded` and a caret button are not valid
listbox options (axe `aria-allowed-attr`, `nested-interactive`), which failed
the theme-accessibility List scan in all 24 themes. With peek on the List is
`role="tree"` with `treeitem` rows; `peekTreePositions` states each row's
`aria-posinset`/`aria-setsize` among its own siblings, since a virtualized tree
cannot leave them to the DOM. A tree may own only groups and treeitems, and
axe looks through a `group` for them, so the card's separator grip is rendered
inside the folder's header treeitem (`ListCardGrip`) and Empty/Loading/Error
rows are treeitems. List entries are therefore not positioned: the caret and
the grip resolve against the slot (`.list-place`, or a card's `.list-row`),
which puts the grip on the card's bottom edge without measuring. A renaming
row rises by its slot's `z-index` for the same reason. The grip and caret are
excluded from row clicks, double clicks and drags (`EntryCell`'s
`isPeekControl`). `dragstart` targets the draggable row, not the element under
the press, so `EntryCell` notes at `pointerdown` (capture) whether the press
began on a control; checking `dragstart.target` alone never matches.

The header owns its card's group with `aria-owns` (ids from `$props.id()` and
the entry index; ghosts strip ids) and is named by `aria-label` alone, since
name-from-content would include the owned rows. The card's scroll area is
`tabindex="-1"`: Chromium otherwise makes it a keyboard-focusable scroller, a
second Tab stop per card. The grip stays a Tab stop (WAI-ARIA window splitter;
the only keyboard path to a card's height). axe's
`scrollable-region-focusable` cannot see roving rows (`tabindex="-1"`) as
focusable content, so it stays disabled for the List scan.

The idle `.list-motion-layer` (absolute, full canvas) must be `display: none`
while empty: axe reports every row's text as "overlapped by another element"
otherwise, although it has `pointer-events: none`.

## No open card, no card cost

With nothing expanded, tree positions are arithmetic
(`peekTreePositionLookup`), the pinned-editor lookup runs only while an editor
is pinned, and the caret's chevron is its button's masked `::before` (one
element per folder row instead of button, svg and path). The model is split
into an R-independent structure (`buildListStructure`) and sizing
(`sizeListModel`), so a row-count change re-flows without rebuilding 10,000
items. A build with every per-row card-aware binding removed measured the
same as the real one: what remains over phase 2 is the caret element (about
half the scroll-back delta) and the tree/row-model rendering. Measure List perf
against the previous phase with concurrent A/B runs (both dev servers under
the same load); sequential runs on a shared host drift by more than the
differences being measured.

## Tests

- Wait for a toggle to settle by the folder's `peekStatus` leaving `loading`
  and then for no motion across more than one animation length; checking "no
  ghost" once can pass before the listing arrives and starts the motion.
- `folder-peek-details`' old "List stays flat" check passed vacuously: List
  loads lazily, so `toHaveCount(0)` was true before it mounted. Assert the
  positive outcome (the card and its child) instead.
- Motion tests must check both scrollport edges with exact boxes (a column wholly
  off the left edge as well as the right), and pair "instant" assertions with a
  positive control (a user toggle seen animating by the same probe).
- `tests/test-cache.test.ts` treats a string literal naming a repository file
  (`AGENTS.md`) in a unit test as a read of that file; fixture names in unit
  tests must not collide with repository files.
