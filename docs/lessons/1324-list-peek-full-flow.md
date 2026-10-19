# List peek overflow has explicit expansion stages (#1324)

The compact List peek's `+N more` text originally conveyed hidden rows without
an action. More now expands in two stages when the descendants exceed a whole
column: first a one-column scrollable section, then ordinary column flow. The
second More remains available at either scroll edge. Full flow has a Less
button that restores the one-column section. Groups already fitting a column
can move directly to full flow.

A per-pane, session-only bounded map records the column or full-flow choice,
keeping those stages mutually exclusive. The column stage reserves one slot
for its header and sizes its remaining rows from the current viewport; compact
cards retain their separate saved grip heights. Only compact cards expose the
grip. `buildListStructure` emits full-flow descendants and statuses as ordinary
one-slot items, sharing the existing placement, virtualization, selection and
keyboard maps. Status slots retain row identity without an entry index, and
horizontal navigation chooses the nearest selectable entry.

More and Less belong inside the folder header treeitem and use EntryCell's
independent-control admission. The stable header takes focus before an action
changes, then its new placement is revealed after layout. Mouse, Enter and
Space share the action. Nested guides split at column boundaries and mount
only for visible or editor-pinned columns.

Remembered column and full-flow choices must not alter temporary drag geometry.
Temporary paths use compact sizing and the existing spring fit/bridge policies;
a permanent ancestor still reserves its column when a nested temporary peek
opens. Permanent reopening restores the saved stage. Shared status and slot
markup retain their identities for drop routing and pixel-edge hit tests.

Regression coverage verifies both More stages, Less, scroll-edge availability,
column sizing across viewport changes, End revealing unmounted descendants,
nested status/guides, keyboard activation and bounded pane-local stage memory.
