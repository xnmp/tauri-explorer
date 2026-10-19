# List peek overflow must use the outer column flow (#1324)

The compact List peek's `+N more` text was an aria-hidden span. It conveyed
hidden rows but offered no action. Increasing the inner scroll area's height
would still leave a large folder inside one card, contrary to the requested
expansion across normal List columns.

A per-pane, session-only bounded set now records folders whose children use
full flow. `buildListStructure` emits each visible descendant and status as an
ordinary one-slot item; the existing placement, virtualization, selection and
keyboard maps remain the authority. Compact cards retain their saved grip
heights. A status slot needs its own row identity even though it has no entry
index, or the renderer mistakes it for the creation sentinel. Horizontal
navigation skips status slots by choosing the nearest selectable row.

The accessible More button belongs inside the folder header treeitem and uses
the existing independent-control admission in `EntryCell`. On activation its
stable header takes focus before the button unmounts. Mouse, Enter and Space
all use the same action. Nested guides split at column boundaries and only
mount for visible or editor-pinned columns.

A saved full-flow choice must not change a later temporary drag peek's geometry.
Temporary paths are excluded from full flow so the existing spring card-fit and
bridge policies keep the held row stable; permanent reopening restores the
saved choice. Shared status markup retains `data-peek-state` for drop routing,
and full-flow slot wrappers expose row identity for pixel-edge hit tests.

Regression coverage asserts all children reach later columns, End reveals a
previously unmounted final child, nested status and guides survive resize and
carets-off mode, mixed compact/full-flow mappings remain valid, and per-pane
choices survive collapse/navigation without exceeding the session cap.
