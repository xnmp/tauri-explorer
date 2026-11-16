# #1699 — Miller columns jumped between pane and left island in split panes

**Symptom.** Floating Islands, sidebar hidden, a split tab: one pane's Miller
columns rendered inside that pane while another pane was active, then jumped to
a full-height left island when the pane was focused, reflowing the whole split.

**Cause.** The hoist condition was "island layout + no sidebar + *active pane*".
A window-level island can only show one pane's columns, so with several panes
it followed focus, and focus became a layout change.

**Fix.** `domain/miller-placement.ts` `millerHoistedToIsland` hoists only for a
single-pane tab; split panes keep their columns inline. `+page.svelte` (the
island) and `ExplorerPane.svelte` (the inline copy) both read it, keeping the
#434 exactly-once invariant in one importable place.

**Gotcha.** `Ctrl+\` seeds the new pane at the parent directory. From
`/home/user/X` that is `/home`, whose single breadcrumb has no ancestor column,
so the new pane renders no `.miller-columns` even with `millerLayers` > 0.
Choose the seed paths deliberately when a test expects columns in both panes.
