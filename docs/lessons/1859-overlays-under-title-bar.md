# Overlays inside the window body stayed under the title bar (#1859)

## Symptom

In Floating Islands, with a pane's delete confirmation (or any menu opened
from a pane, the sidebar or the toolbar) showing, the title bar stayed sharp
above the dialog's dimmed backdrop: tabs, the new-tab button and the window
controls took clicks through it. In Default only the active tab did, and the
status bar in both.

## Cause

`.main-content` is a stacking context (`position: relative; z-index: 1`,
#970). Every overlay mounted inside it is confined to that level, whatever
its own z-index (`--z-modal` is 1000). Floating Islands lifts the title bar
to z-index 2 so its tab seam paints over the islands; the active tab carries
z-index 2 in every layout (`window-tab-bar.css`) and, in Default's bar (no
stacking context), competes with `.main-content` directly. The status bar is
a later sibling at z-index 1.

## Fix

Each full-window overlay root mounted inside the window body carries
`data-window-overlay`: `Modal.svelte`'s overlay (not a pane-scoped one), and
the dismissing backdrops of the context menu, Details column menu, caret
picker, sidebar section menu, navigation history menu, the git graph's
menus and its action prompts (rename, create branch/tag, pull offer, reset and
delete; `GitGraphDialogs.svelte`, which an independent review caught missing). `+page.svelte` raises `.main-content:has([data-window-overlay])` to
z-index 3, as it already did for a fullscreen preview, so the overlay covers
the title bar and status bar and stays below root dialogs.

Raising main only while an overlay is open keeps the title bar's own
dropdowns (tab search, tab menu) above the window body the rest of the time.
In Floating Islands the tab's soft key shadow just below the bar then sits
under the islands (at most 4/255 per channel), only while the overlay shows.

## Rule

A new overlay mounted under `.main-content` that covers the window (a
backdrop with `position: fixed; inset: 0`) must carry `data-window-overlay`.
`e2e/overlay-stacking.spec.ts` hit-tests every tab, window control and the
status bar under five representative overlays (delete dialog, column menu,
context menu, sidebar section menu, git graph prompt) in Floating Islands and
Default.
