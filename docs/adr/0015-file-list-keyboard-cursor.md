# 0015 — File-list keyboard cursor

Status: Accepted

Governs: `src/lib/domain/file-list-navigation.ts`, `src/lib/state/selection.ts`,
`src/lib/state/explorer.svelte.ts`, `src/lib/components/FileList.svelte`,
`src/lib/components/ExplorerPane.svelte`, `src/lib/components/VirtualList.svelte`,
`src/lib/components/DetailsView.svelte`, `src/lib/components/ListView.svelte`,
`src/lib/components/TilesView.svelte`, `src/lib/components/EntryCell.svelte`,
`src/lib/components/FileItem.svelte`, `src/lib/state/file-list-focus-context.ts`,
`src/lib/composables/use-inline-rename.svelte.ts`.

## Problem

Each file entry was a Tab stop, while Open and Preview operated on selection.
Tab could therefore focus Archive while Enter opened Downloads. Repeated range
extension derived its next position from the first selected entry, losing the
moving endpoint. Index-based anchors also changed identity after sorting or an
inserted listing entry. Deferred focus searched for an arbitrary selected node
and could run after its interaction had lost ownership.

## Decision

Treat each main file listing as a keyboard composite, following the WAI-ARIA
[grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) and
[keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
guidance. Tab enters at one cursor; arrows move within the collection. The cursor,
selection set and range anchor have separate meanings. Cursor and anchor identify
paths, so reorder does not substitute another entry. Focus alone does not rewrite
multi-selection. Ordinary movement replaces selection, Shift extends from the
anchor, and Ctrl/Cmd arrows move only the cursor. Ctrl/Cmd+Home/End selects a
boundary; adding Shift extends the range to that boundary. Existing selection
commands retain their selected-entry semantics.

Pure domain functions resolve cursor fallback and keyboard movement intents.
The explorer state owns cursor and selection. ExplorerPane translates accepted
intents into state operations and delegates exact entry reveal to FileList.
Inputs, nested controls and other composites retain their keyboard ownership.
The global command router remains responsible for configurable Open and Preview.

FileList owns deferred DOM focus, guarded by the current pane, directory, view,
cursor and initiating interaction. Each view exposes entry-index reveal and a
reactive rendered-range query. An unmounted cursor gives the viewport a temporary
Tab stop; entering it reveals and focuses the cursor. Inline editor Enter/Escape
borrows the same FileList-owned request across editor teardown; blur commits do
not request focus. Empty-name validation keeps the editor focused. No row-node
registry or parallel selection cache is needed. Programmatic scroll cancels
pending scroll coalescing and synchronizes the virtual window before focus is
attempted.

Entries are gridcells instead of buttons containing inline editors. Details uses
one cell per file row; sortable column controls remain outside the body grid.
List and Tiles expose their row-major cell positions. This is a collection grid,
not a claim that Details implements a fully navigable spreadsheet.

## Consequences and verification

Focus is visible independently of multi-selection. Pointer hover remains immediate.
Virtualization retains bounded row rendering; no startup or latency improvement
is inferred from this change. Unit tests exercise path anchors and public explorer
outcomes. Browser tests must verify actual Tab traversal, range endpoints,
virtualized reveal, folder navigation and existing configurable commands in all
three views. Native/platform acceptance remains separate from mock browser proof.
