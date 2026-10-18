# #1308 — Restore peek membership with closed tabs

Expansion was already per explorer, but closing a tab destroyed its explorer and the persisted tab snapshot contained only layout and paths. Ctrl+Shift+T therefore restored a collapsed explorer.

The capped closed-tab stack now has separate in-memory session metadata. Window tabs capture each pane's expansion membership and seed its replacement facade/session on restore; closed split panes use the same seed. Fresh tabs receive no seed, and no expansion enters localStorage or survives process restart. Deferred panes retain their seed until activation, including when a restored tab is closed again before visiting every pane. Only membership is restored: listings, watches and temporary drag peeks get fresh ownership.

The browser regression failed before the fix at the missing child after Ctrl+Shift+T. It verifies fresh-tab isolation and a deliberately collapsed sibling in Details, List and Tiles.

Independent review found that collapse/prune commands could arrive before the lazy session import completed and be dropped. The facade now applies the same lightweight domain membership policies to its pending seed; collapse and deletion pruning cannot be undone by chunk completion. Both regressions failed before this correction.
