# Folder peek: inline folder expansion (spec, 2026-10-17)

Status: design agreed with the user (2026-10-17); being implemented in phases #1238
(folder-peek-details), #1239 (list-column-flow), #1240 (folder-peek-list), #1241
(folder-peek-tiles) and #1242 (folder-peek-spring-load).

## 0. Assets and terms

- Live mock (private artifact): https://claude.ai/artifact/MqjV96UuuDsowwuHkNnDxB
  - Source: `docs/execution-plans/folder-peek-mock.html`. Open it in a browser; it is
    self-contained apart from a Google Fonts link.
  - URL presets: `#tiles-single|split|above|stacked`, `#list-single|split|many|cards`,
    `#details-tree`. A `shot-` prefix hides the control bar; a `-notes` suffix shows the
    numbered reviewer pins (mock-only).
  - The mock's in-page `selfTest` (console PASS/FAIL) contains the reference layout
    functions (`columnFlow`, `cardSlots`, `listTreeRows`, Tiles placement and sizing).
    Port its cases as the first unit tests.
- Mock dimensions are illustrative. Use the app's row heights (Details 32px,
  `DetailsView.svelte`; List 30px, `ListView.svelte`). Wherever this spec says "row", it
  means that view's row height.
- Terms:
  - **peek**: an expanded folder shown in place.
  - **top-level item**: an entry of the pane's current folder.
  - **card**: List's box for an open top-level folder.
  - **panel**: Tiles' box for an open folder.
  - **band**: the strip between Tiles grid rows that holds panels.
  - **R**: rows per List column.

## 1. Scope

In v1:
- Details tree with nesting.
- List column flow (a base List change) with cards and nesting.
- Tiles panels in bands, one level only.
- The shared model, live updates, selection and file operations on peeked items.
- Keyboard navigation through peeked items, plus palette commands.
- Drag and drop into peeks, and spring-loaded peek.

Not in v1:
- nesting inside Tiles panels;
- persistence across app restarts;
- a default keyboard shortcut for toggling;
- "Paste into" or "New item in" a peeked folder.

## 2. Shared model

- **Expanded set:** absolute folder paths, per pane, in a `src/lib/state/` store. Never
  component-local (#444).
  - It survives navigation, view-mode switches and tab switches, including retained
    hidden tabs (#1173).
  - It is session-only: lost on restart, empty for new tabs and windows.
  - Navigating into `Career` keeps `Career/Applications` expanded; going back keeps
    `Career` expanded.
  - Panes are independent.
  - Paths outside the current folder are kept but not loaded. Cap the set at 500 paths
    per pane and drop the least recently toggled first.
- **What each view shows:**
  - Details and List render the full expanded tree under the current folder.
  - Tiles shows panels only for expanded top-level folders. Deeper paths stay in the set
    with no effect in Tiles.
- **Eligibility:** only directory entries in plain filesystem locations get a caret.
  - No peek for virtual or provider paths (`isVirtualPath`/`providerFor`, e.g.
    `trash://`), the git graph, plugin-owned views or the content-search dialog.
  - Symlinked directories may peek. Depth grows only by clicks, so cycles are harmless.
- **Toggle:** only clicking the caret expands or collapses.
  - Clicking the caret does not change the selection.
  - A single click on the row selects it; a double-click navigates into it (unchanged).
  - Option `folderPeekCarets` (default on; palette "Toggle Folder Peek Carets", Settings
    "Show Folder Peek Carets"): off hides the carets in Details and List (Tiles keeps
    them) and a plain left click on a folder row selects it AND toggles its peek. Ctrl,
    Shift, Meta and Alt clicks only select; file rows never toggle; a click that ends a
    drag, marquee or rename-editor interaction does not toggle. Each click of a
    double-click toggles, so the expanded set is unchanged before navigation. The
    decision is `shouldToggleOnRowClick` in the domain; the toggle uses the caret's action.
- **Caret and names:**
  - The caret points toward the content: right = closed, down = open. In Tiles it points
    up for an above panel.
  - Expanded folder names are bold.
- **Pruning:** when a refreshed parent listing no longer contains an expanded folder
  (deleted, moved or renamed), remove it and its descendants from the set and release
  their watches. Renames are not followed.

## 3. Visible entries: the integration seam

Selection, Shift ranges, the keyboard cursor, marquee, the preview pane and the status bar
all resolve against the pane's `displayEntries` (`explorer.svelte.ts`). Selection rejects
paths that are not in that list.

So peeked children must become part of a single flattened **visible entries** sequence. A
separate cache that the views render on the side would leave them unselectable.

- Order: the current folder's entries in display order, with each expanded and loaded
  folder's children inserted directly after it, recursively.
- Sort and filter each level independently, using the view's existing rules:
  - Details uses its configured sort; List and Tiles sort by name ascending.
  - Hidden-file rules apply at every level.
  - Never sort the flattened list globally: that breaks parent-child adjacency.
- The name filter applies to top-level entries only. A filtered-out folder hides its
  children.
- Each entry carries `depth` and `parentPath` so the views can indent, group and box it.
- Tiles uses the same sequence for selection and ranges. A panel's children follow their
  parent, even though they are drawn in a band.
- Ctrl+A and typeahead stay scoped to the current folder's own entries (depth 0), not
  peeked children. Ctrl+A today selects all of `displayEntries`, so restrict it to
  depth 0.
- The status bar's item count stays the current folder's count. Selection counts and
  sizes include selected children.

## 4. Loading, watching and states

- **Listing:** list a folder when it becomes visible-expanded, through the same path as
  the pane (`loadDirectory`/`fetchDirectory` in `api/files.ts`). Hold each peek listing in
  the pane's state, keyed by path.
- **Watching:** extend the existing refresh split to be keyed by (pane, path). Do not add
  a fourth gate, and do not build a private refresh stack in a component (#431/#432).
  - refresh-manager (WHEN) schedules the refresh.
  - pane-watch (WHETHER) admits it.
  - pane-refresh (HOW) reloads that one peek's listing.
  - Reuse `createDirectoryWatch` and `watch_directory`/`unwatch_directory`.
  - Watcher callbacks capture the path and drop stale work, per the CLAUDE.md rule.
- **Cap:** watch at most 16 peeks per pane, the most recently opened first. Peeks beyond
  the cap refresh whenever the pane itself refreshes. Collapsing releases the watch.
- **States inside a peek** (one muted, non-selectable row in Details/List; a centred label
  in a Tiles panel):
  - Loading: if the listing takes more than 150ms, show "Loading…".
  - Empty: show "Empty folder".
  - Error: show "Can't open folder: <reason>". The folder stays expanded and retries on
    its next refresh or a re-toggle.
- **Large folders:** load the full listing. Card and panel contents must virtualize, so a
  10,000-item peek renders only its visible rows.
- **Per-row metadata:** Details lazy columns (Length, Resolution), git badges and
  thumbnails work on child rows through their existing per-row resolvers and caches.

## 5. Interaction

- **Selection:** peeked items are ordinary entries, keyed by full path.
  - Click, Ctrl-click and Shift-click work across levels.
  - Shift ranges follow the visible-entries order.
  - Marquee selects any visible entries it covers.
- **File operations:**
  - Rename (inline), delete, copy/cut, open and open-with already use full paths, so they
    work unchanged.
  - New File/Folder and Paste keep targeting the pane's current folder, even when a
    peeked item is selected (existing behaviour; see §1).
- **Drag and drop:**
  - Peeked items are drag sources.
  - Drop targets: a peeked folder row targets that folder (existing folder-drop path),
    and a card's or panel's empty area or header targets its folder. A drop on the pane
    background still targets the current folder.
  - Spring-loaded peek:
    - Hovering a drag over a closed folder for 600ms opens a temporary peek.
    - It closes when the drag leaves both the folder and its peek, and when the drag
      ends or is cancelled.
    - A drop inside the peek targets that folder.
    - Temporary peeks do not enter the expanded set.
- **Context menu:** right-clicking a peeked item gives that item's normal menu.
  Right-clicking a card's or panel's empty area gives its folder's menu.
- **Preview pane:** follows the selected entry by path, so it works once children are in
  the visible entries.
- **Esc** is layered:
  - If anything is selected, it clears the selection (existing).
  - Otherwise, if the cursor is inside a peek, it closes the innermost peek containing
    the cursor and moves the cursor to that folder.
  - Inline rename and creation keep their own Esc handling.
- **Palette commands**, with no default shortcut:
  - "Peek into Folder" toggles the cursor folder, or the containing folder for a peeked child file. It is disabled for a depth-0 file.
  - "Collapse All Peeks" removes every expanded path at or below currentPath, including dormant descendants; paths elsewhere remain.

## 6. Keyboard navigation

The navigation seam is `resolveFileListMove` (`domain/file-list-navigation.ts`).
Selection jumps to unmounted rows go through FileList's `scrollToEntry`.

- **Details:** Up/Down move ±1 through the visible entries, including children.
  Existing Home/End/PageUp/PageDown bindings work over the same sequence; phase 1 adds no unmodified Home/End binding. Left/Right are unchanged:
  `yaziNavigation` keeps parent/open.
- **List:** arrow keys keep their visual meaning (user: "up down keys should stay the
  same").
  - Up/Down move one row within the column, passing through a card's rows (scrolling the
    card), and stop at the column's ends.
  - Left/Right move to the same visual row in the adjacent column, clamped to a shorter
    column's last item.
  - `yaziNavigation` (Left = parent, Right = open) applies to Details only from now on.
    Its "single-column List" condition goes, because column count now depends on folder
    size.
- **Tiles:** spatial navigation over the laid-out rectangles: grid items plus the items of
  visible panels.
  - The arrow picks the nearest item whose centre lies in that direction. Prefer items
    that overlap the cursor's extent across the direction of travel.
  - This enters and leaves panels naturally.
  - Moving onto a panel item scrolls the panel to show it.
  - Compute the rectangles in the domain layout, not from the DOM.

## 7. Details view

- The caret sits left of the folder icon in the Name column. File rows keep a blank caret
  slot so names align. With `folderPeekCarets` off there is no caret and no slot: children
  still indent 22px per level, the guide line sits under the parent's folder icon, and
  expanded names stay bold.
- Children indent 22px per level, nest to any depth, and keep the columns aligned.
- Selection is the existing soft fill plus a 3px accent bar at the row's indent.
- Groups are UNBOXED: no fill and no border (the user rejected group boxes). The only
  group cues are the indent, the bold expanded name, and a 1.5px guide line under the
  caret. The line fades from accent to hairline over min(64px, 60% of group height).
- Rendering: the visible entries in the existing fixed-height `VirtualList`.

## 8. List view: column flow with sideways scroll

List becomes Windows Explorer's List view: fixed-height columns filled column by column,
scrolling sideways.

### 8.1 Base layout (phase 2; applies with no folder open)

- R = floor(usable files-area height / row height), minimum 4.
- Columns have a fixed width (mock: 260px, gap 16px). The column count follows from the
  content.
- List scrolls only sideways. A vertical wheel scrolls sideways, except over a card that
  can still scroll in that direction.
- Rendering: replace `useRowGridView`'s row-major chunks with column virtualization.
  - Columns have a fixed height of R slots.
  - Positions are a prefix scan over item slots, cached per expansion revision and per R.
  - Render only the columns that intersect the viewport, plus overscan. `VirtualList`
    already supports variable sizes; add a horizontal axis or a column-level virtualizer.
- Revealing a selection or a typeahead match scrolls sideways.
- R and the layout recompute when the files area resizes. Do not size painted layout from
  a ResizeObserver measurement taken in a later frame (#1061): R comes from the scrollport
  that CSS already sizes.
- Precedent: Windows List view and KDE Dolphin's Compact view.

### 8.2 Placement (pure function, `columnFlow(items, R, slotsOf)`)

- Walk the top-level items in sort order with a (column, row) cursor.
- A plain item takes 1 slot.
- An open top-level folder is a card of `cardSlots` slots: one header slot plus its
  visible rows.
  - A card never splits across columns. If it doesn't fit in the rows left in the
    current column, and the cursor isn't at row 0, it starts at the top of the next
    column, leaving empty slots behind.
- The function has no history: no pins. Closing everything restores the original
  layout.
- Opening a folder shifts every later item along the column path. The user accepted
  this: "sideways scroll is ok... most of that movement happens off screen".
- The clicked folder stays put unless its card doesn't fit. Then it moves to the top of
  the next column, and after the animation it is smooth-scrolled into view if it isn't
  fully visible.

### 8.3 Cards (phase 3)

- An open top-level folder is a card:
  - panel tint, 1px hairline, radius 8;
  - a 1.5px accent border that fades into the hairline over min(64px, 60% of card height);
  - its visual box inset 2px inside its slots, so stacked cards keep a gap.
- The folder's own row is a fixed header. All descendants, nested levels included, scroll
  inside the card.
- Nested levels inside a card get no box and no scroll of their own, only the Details
  guide line, a 16px indent per level and carets.
- Caret placement in List (decided 2026-10-17, the mock's "close" variant):
  - a 14px caret slot with a 10px chevron, about 4px from the icon;
  - file rows keep the blank 14px slot, so names align;
  - the 16px indent puts a child's caret under its parent's icon;
  - the guide line is centred under the caret.
  - Details keeps its 22px spacing.
- Height:
  - visible rows = min(content rows, preferred rows), default preferred 6, clamped to
    1 .. min(content rows, floor(0.7 × R)). A card can therefore never exceed one column.
  - The bottom-edge grip resizes, snapped to whole rows, and the height is remembered per
    top-level path for the session.
  - The grip and "+N more" overlay the edge and add no height.
  - During a drag, only the card's scroll area previews; the layout commits on release.
- Scroll edge:
  - A 28px fade mask sits on whichever edge has content scrolled out of view.
  - A muted "+N more" (rows whose centre is below the visible area) sits by the grip,
    hidden when 0.

### 8.4 Motion (List)

- Duration ~200ms, ease-out cubic.
- Only columns that intersect the viewport animate; off-screen columns snap.
- Entries that stay in their column slide vertically (FLIP).
- Entries that change column move like a conveyor:
  - A snapshot leaves through the old column's bottom edge, and the entry enters through
    the new column's top edge (reversed on close).
  - Both travel the same distance along the column path, counting empty slots.
  - Columns clip their content while animating.
- A card's scroll area grows from 0 or shrinks to 0.
- Reduced motion, programmatic changes and restores are instant.
- Changing R re-lays out instantly.
- **Ghost rule (bug found in mock v11):** motion snapshots must stay out of every live DOM
  query and state update.
  - The mock's per-frame scroll-edge update hit a ghost's missing "+N more" label and
    threw.
  - That froze the animation with the old card still drawn, so a collapse appeared not to
    work, and the next toggle revealed both changes at once.
  - Keep ghosts in their own layer, and stress-test interrupted toggles of cards, not
    just of plain rows.

## 9. Tiles view: panels in bands (phase 4)

### 9.1 Placement

- MIN_PANEL_COLUMNS = 3. A band is the set of panels on one side of one grid row.
- A band of k panels is FEASIBLE iff columns 0..C−1 split into k contiguous segments, in
  parent-column order, each containing its parent's column and at least
  MIN_PANEL_COLUMNS wide.
  - Prefer the midpoint split between consecutive parents; otherwise use the nearest
    feasible boundaries.
- Opening folder f in row r tries, in order:
  1. the band below, if feasible;
  2. the band above, if feasible;
  3. STACKED: its own full-width band under the row's below band, after earlier stacked
     bands.
- Stability:
  - Opening never moves an existing panel to another band; band members re-split widths.
  - Closing removes the panel, and the remaining members re-split.
- On a window or column-count change, keep each panel on its current side while still
  feasible, and re-place only infeasible ones in opening order. (The mock re-places
  everything; follow the spec.)
- Vertical order per row: [above band] [row] [below band] [stacked bands].
- Opening or growing an above band compensates `scrollTop`, so the clicked row does not
  move on screen.
- Rendering: bands are variable-height items in `VirtualList`, which supports this via
  `getItemHeight`.

### 9.2 Panel sizing

- Mini tiles are at ~70% scale (~96px tracks).
- Grid: rows = max(1, round(sqrt(n / 2.5))), cols = min(fits in segment,
  max(2, ceil(n / rows))).
  - Examples: 6 → 3×2, 9 → 5×2, 11 → 6×2, 14 → 7×2, 48 → as wide as fits.
  - The segment is only the maximum area. The panel is centred under its parent's tab
    and clamped inside the segment.
- Height:
  - Default preferred = min(panel width, 3.5 mini rows + padding).
  - Band height = max over members of min(member preferred, member content).
  - Each panel is min(band height, its content) tall. Below and stacked panels align to
    the band top; above panels align to the band bottom.
- Resize:
  - A small, low-contrast grip pill sits on the panel edge farthest from its parent.
  - Dragging sets the preferred height of every band member, and each folder remembers
    its last height.
  - Clamp to between ~1 row and 70% of the viewport, never above the content.
- Panels scroll internally with a thin overlay scrollbar, and have the same fade mask and
  "+N more" as List cards.

### 9.3 Visuals

- Attached panels have no title row. Parent and panel form one outlined "tab and page"
  shape:
  - The tab is the parent cell inset 4px on each side, and joins the panel across its
    full width.
  - Tab corners r 8, panel corners r 10, with concave fillets r 6 where the tab meets the
    panel.
  - If the tab is within r_panel + r_fillet of a panel side, it snaps flush with that
    side.
- Spacing:
  - 4px of whitespace between neighbouring tabs.
  - A 12px gap between a band and its row, crossed only by the panel's own parent tab.
- Colour:
  - Fill: a faint lavender-grey tint.
  - Stroke: a 1px neutral hairline around the whole contour.
  - Accent: a 1.5px overlay on the parent-facing contour that fades into the hairline
    over min(64px, 60% of panel height).
  - Use theme variables, never hardcoded colours, and no saturated fills.
- Hovering a parent or any part of its panel raises its outline group to full opacity
  instantly (#503).
- Subfolders inside a panel show no caret. Double-clicking one navigates the main view
  into it.

### 9.4 Stacked panels

- A stacked panel sits under its parent's column, with a label tab on its top edge
  aligned to the parent column.
  - The label shows the folder icon, the bold name, a muted "· N items" and a × button
    (aria-label "Close <name>", same as clicking the caret).
  - Clicking the label scrolls the parent into view.
- The parent item gets a matching closed highlight: a faint fill and a 1px accent rounded
  rect.
- A ribbon links them: a ~9px strip in panel fill with hairline edges.
  - It merges into the bottom of the parent highlight and the top of the label tab with
    concave fillets.
  - It runs down the free vertical channel nearest the parent's centre, with horizontal
    runs only in band gaps and smooth large-radius bends.
  - Keep 12px of clearance from panels; the 24px gap between neighbouring panels always
    qualifies.

### 9.5 Motion (Tiles)

- Duration ~150ms, ease-out cubic.
- Band heights and margins, and panel left, width and height, interpolate.
- The opening or closing panel fades. Outlines and the ribbon redraw every frame.
- Above bands keep the clicked row fixed on screen throughout.
- A new toggle or grip drag finishes the running animation first.
- Instant under reduced motion and for programmatic changes.

## 10. Accessibility

- The caret is a `button` with `aria-expanded` and the label "Expand <name>" or
  "Collapse <name>". With carets off the folder row itself carries `aria-expanded`
  (already set on the row) and the "Peek into Folder" command remains the keyboard path.
- Details and List child rows carry `aria-level`.
- A card or panel is `role="group"`, labelled "<name> contents".
- The grip is `role="separator"` with `aria-orientation="horizontal"` and
  `aria-valuenow`/`min`/`max`. ArrowUp/ArrowDown resize it by one row; Home/End set the
  minimum and maximum.
- Hover feedback stays instant. All motion respects `prefers-reduced-motion`.

## 11. Testing

- **Vitest (domain, written first):**
  - building the visible entries: per-level sort and filter, depth, pruning, the
    filter-hides-children rule;
  - `columnFlow`, `cardSlots` and the List keyboard moves;
  - Tiles feasibility, fallback order, stability, sizing and ribbon routing;
  - Tiles spatial navigation;
  - the expanded-set store: survives navigation and view switches, prunes, caps at 500;
  - the watch-cap policy.
  - Port the mock's selfTest cases, including its randomised column-flow transitions
    checked against an independent slot-by-slot model.
- **Browser Playwright (`ALL_VIEW_MODES=1`):** assert outcomes, not existence.
  - Toggling shows the children, bolds the name, shifts later items, and restores the
    original layout when everything is closed.
  - Shift-range selection across levels.
  - Ctrl+A and typeahead stay at depth 0.
  - The Esc layering.
  - A drop onto a card or panel targets its folder.
  - Spring-loaded peek.
  - A stress test of interrupted toggles (the mock's random clicker): no uncaught errors,
    and no ghosts, transforms or hidden rows left behind once settled.
  - A WebKit run of the motion specs.
- **Tauri-binary E2E (tier 3):**
  - A file created or deleted in a peeked folder appears or disappears through the real
    watcher.
  - Deleting an open folder prunes it.
  - The watch cap degrades to refresh-on-pane-refresh.
- **Performance:** add a `perf:sweep` case for toggling a card in a 10,000-entry List
  folder and a panel in a large Tiles folder. Record the medians in the PR.

## 12. Phases (one GitHub issue and PR each, branched off `dev`)

Every phase lands in all view modes it touches, updates `docs/code-map/`, and needs
screenshots in `screenshots/<branch>/`.

### Phase 1 — `folder-peek-details`: shared model and Details tree

Scope: §2–§7 for Details, the palette commands and Esc layering, and drop onto peeked
folder rows.

Acceptance:
- [x] Clicking a caret expands or collapses that folder only, without changing that folder's
      selection. Collapsing prunes hidden selected descendants (§14). Nesting works to any
      depth, and children are sorted by the Details sort.
- [x] Expanded state survives navigating into and back out of a folder, view switches and
      tab switches. It is per pane and lost on restart.
- [x] Peeked items can be selected, including Shift-ranges across levels. Ctrl+A selects
      the current folder's items only.
- [x] Rename, delete, copy and open work on peeked items. The preview pane and status-bar
      selection info follow them.
- [x] Esc clears the selection first, then closes the peek containing the cursor. The
      palette commands work.
- [x] Live updates: a file added in a peeked folder appears without a manual refresh
      (tier 3). Deleting an open folder removes it from the expanded set.
- [x] Loading, Empty and error rows render. Trash and virtual locations show no carets.

Screenshots:
- [ ] `details-tree.png`: nested expansion with guide lines and bold names.
- [ ] `details-selection-across-levels.png`
- [ ] `details-empty-and-error.png`

### Phase 2 — `list-column-flow`: List as sideways-scrolling columns (no peek yet)

Scope: §8.1, §6 List, and the `yaziNavigation` change.

Acceptance:
- [ ] Items fill top to bottom, then the next column. List scrolls only sideways, and the
      vertical wheel scrolls sideways.
- [ ] Rows per column follow the window height and update on resize.
- [ ] Up/Down move within a column and stop at its ends. Left/Right move to the same row
      in the adjacent column.
- [ ] Selection reveal, typeahead and `scrollToEntry` scroll sideways to off-screen items.
- [ ] Only visible columns are rendered (verify with a 10,000-entry folder).
- [ ] `yaziNavigation` affects Details only.

Screenshots:
- [ ] `list-columns.png`: several columns overflowing sideways.
- [ ] `list-columns-scrolled.png`: after a sideways scroll, with the selection revealed.

### Phase 3 — `folder-peek-list`: List cards

Scope: §8.2–§8.4, plus §2–§6 for List.

Acceptance:
- [ ] Opening a folder shows a card in its column. Later items shift along the columns.
      A card that doesn't fit starts the next column and is scrolled into view.
- [ ] Nested folders expand inside the card with guide lines and no box. All descendants
      scroll inside the card under a fixed header.
- [ ] The grip resizes in whole rows, remembers the height per folder, and never exceeds
      one column. "+N more" and the fade masks are correct.
- [ ] Only visible columns animate. Interrupted toggles leave no stuck animation, ghost
      or hidden row (stress test).
- [ ] Up/Down pass through a card's rows, scrolling the card.

Screenshots:
- [ ] `list-card.png`
- [ ] `list-cards-nested.png`
- [ ] `list-card-wrapped.png`: a card that started the next column.

### Phase 4 — `folder-peek-tiles`: Tiles panels

Scope: §9, plus §2–§6 for Tiles.

Acceptance:
- [ ] Panels open below, or above, or stacked, following the feasibility rules. Opening
      never moves an existing panel.
- [ ] Panel sizing follows §9.2. The grip resizes the whole band.
- [ ] Tab-and-page outlines render, with an accent fade and instant hover emphasis.
- [ ] A stacked panel has a label with ×, linked to its parent by the ribbon.
- [ ] Column-count changes keep panels on their side while feasible.
- [ ] Spatial arrow navigation enters and leaves panels.
- [ ] A drop onto a panel targets its folder.

Screenshots:
- [ ] `tiles-single.png`
- [ ] `tiles-split.png`
- [ ] `tiles-above.png`
- [ ] `tiles-stacked.png`

### Phase 5 — `folder-peek-spring-load`: spring-loaded peek

Scope: §5 Drag and drop, spring-loaded part, in all three views.

Acceptance:
- [ ] Holding a drag over a closed folder for 600ms opens a temporary peek.
- [ ] A drop inside it targets that folder.
- [ ] Leaving the folder and its peek, or ending or cancelling the drag, closes it.
- [ ] Temporary peeks never enter the expanded set.

Screenshots:
- [ ] `spring-loaded-peek.png`

## 13. Open questions (defaults apply until decided)

- Persistence across restarts. Default: session-only.
- A default keyboard shortcut for toggling. Default: none; the palette commands can be
  bound.
- The numeric caps (16 watched peeks, 500 expanded paths, 600ms spring delay) are
  tunable.

## 14. Decision log (rejected alternatives)

- **Phase 1 selection on collapse:** prune now-hidden descendants from selectedPaths. If the cursor or anchor was hidden, move the cursor to the collapsed folder and clear the anchor, without selecting that folder. Entering List/Tiles applies the same pruning while retaining expanded membership. Root-level filtering keeps its existing behavior. Selected-entry snapshots were rejected because file actions on invisible selections are unsafe.
- **Phase 1 capability/accessibility:** Details is a treegrid; List/Tiles remain flat grids with capability `none`, with no peek resources until their phases. Palette peek commands have no default shortcuts.
- **Folder Peek toggle:** the `folderPeek` setting (default on; palette "Toggle Folder Peek", Settings checkbox) is one more input to `peekCapability`, so "off" is exactly capability `none`: classic `grid` Details with no caret slot, indent, `aria-level`, listings, watches or Git ownership; the peek commands are unavailable and Escape only clears the selection. Expanded membership stays in memory and the toggle applies live. A separate render path for "off" was rejected: it would let the two Details layouts drift.
- **Carets option (#1248):** `folderPeekCarets` hides carets and makes a plain folder click toggle, because some users want a caret-free list and the classic single-click-selects behaviour never expanded anything. Decided purely (`shouldToggleOnRowClick`) and routed through `togglePeek`, so it shares the caret's capability, eligibility and lazy-load guards. Modifier clicks stay selection-only and double-click is two toggles then navigate: a click-delay to disambiguate was rejected as input latency. Drag/marquee-ending clicks are excluded by comparing the press and release points and the marquee grace window.
- **Caret is not a tab stop:** the caret keeps its button role and accessible name for pointer and assistive-technology users, but has `tabindex="-1"` and prevents focus on mousedown. A focusable caret stole keyboard focus from the row grid, so arrows and typeahead stopped following the cursor row after a click, and Tab stopped on every expanded folder. Keyboard users expand the cursor row's folder with the "Peek into Folder" command (bindable) and step back out with Escape, so the caret needs no tab stop of its own.

- **Phase 3 (List cards, #1240):**
  - With peek on, List is a `role="tree"` of `treeitem` rows: §10's `aria-level`,
    `aria-expanded` and caret button are invalid on listbox options. Positions
    (`aria-posinset`/`setsize`) count siblings under the same parent. The card's
    `role="group"` ("<name> contents") is its scroll area, not the whole card: the
    header stays a treeitem in the column flow and keeps one DOM node whether the
    folder is open or closed. Because a tree owns only groups and treeitems, the grip
    separator is rendered inside the folder's header treeitem (still on the card's
    bottom edge) and Empty/Loading/Error rows are treeitems.
  - Every List level sorts by name, like the List root; the pane's Details sort applies
    only in Details. A Details sort (for example size) reordering a List card was
    rejected as surprising in a name-ordered view.
  - A grip drag previews only the card's scroll area (items it would cover are hidden)
    and commits on release without motion; pointercancel or window blur aborts the
    preview. The session is window-level state in `useListColumns`, so a column that
    unmounts mid-drag still commits. The height is clamped to the rows left in the
    card's column; revealing the card after a commit that moved it was rejected,
    since a resize should never relocate what is being resized. Heights are
    remembered per pane for the session, capped at 500 paths like the expanded set.
  - The grip is the card's one Tab stop (the separator's only keyboard path); the
    scroll area is `tabindex="-1"` because the tree's cursor reaches every card row.
    The header owns the group via `aria-owns`.
  - Motion is driven by an explicit user-toggle signal (`peekChange`), armed until the
    opened folder's listing settles (at most 1.5s). Inferring "user change" from layout
    diffs was rejected: refreshes and restores would animate. Revealing a wrapped card
    is not bound to that arm: it waits for the listing however long it takes.
  - Loading (after 150ms), Empty and Error rows take one content row like Details; a
    card is header-only while its listing has produced no row.
  - Card heights come only from the model (CSS variables); measuring rendered heights
    was rejected (#1061).
  - A scrollable card takes a vertical wheel natively until its range end, then the
    List's sideways mapping resumes; taking it with `preventDefault` would lose native
    momentum and scroll chaining.
  - A card's own surface and its pseudo-rows are drop targets for their folder; file
    rows inside a card stay non-targets, as everywhere else. Marquee hits are clipped to
    the card's scroll area.

- **Details:** tinted or bordered group boxes were rejected; groups are unboxed.
- **List layout:**
  - masonry/shortest-column: scattered motion and lone files under cards;
  - cost-minimising tail pour: "this transition makes no sense";
  - row-major flow around cards with pins and no-orphans: "icons are in book order, not
    column by column";
  - vertical "newspaper pages": superseded once sideways scroll was accepted;
  - also: split-band panels, one-column cards that pushed every column down, and
    unbounded inline trees.
  - The earlier rules were compared in throwaway simulations; they are not kept.
- **List caret:** "close" was chosen over three alternatives (compare them with the mock's
  List "Caret" selector):
  - "apart" (the original spacing);
  - "on icon": a white chevron on the folder; it is tiny, can get lost on light folder
    colours, and makes the icon a toggle rather than part of the row;
  - "badge": a Tiles-style corner badge, too busy at List's density.
- **Tiles:**
  - No nesting in v1. Nested panels would almost always stack, nested scrollers trap the
    wheel, and heights compound. Details is the deep-hierarchy view. Revisit as in-panel
    drill-down.
  - A thread link was replaced by the ribbon.
  - Title rows on attached panels were removed.
