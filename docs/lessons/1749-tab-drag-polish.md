# #1749 — tab drag polish, tab context menu, close activation

## Closing the active tab activates its RIGHT neighbour

Decision: when the active tab closes, the tab to its right becomes active;
only when it was the last tab does the left neighbour take over. This is the
Chrome, Safari and VS Code convention (Firefox does the same for tabs it did
not open itself). The tab that slides into the closed tab's place is the one
that becomes active, so the selection stays where the user was looking.

The rule lives in `activationAfterClose` (`domain/window-tab-order.ts`) and is
used by `removeTab` in `state/window-tabs.svelte.ts`; previously that code
picked `tabIndex - 1` inline. Regression tests: `tests/domain/window-tab-order.test.ts`
and the "closing tabs from the strip" block of `tests/state/window-tabs.test.ts`
(which failed on the old left-neighbour behaviour).

Close Others / Close to the Right (`state/window-tab-actions.ts`, built on the
manager's `closeTab`/`setActiveTab`; Duplicate is `exportTab` + `adoptTab`
after the tab) activate the kept tab before closing the
rest when the active tab is among them, so no intermediate neighbour flashes
active; each closed tab is still pushed on the Ctrl+Shift+T stack.

## A later `.tab.active` silently undid `.tab.dragging`

`.tab-area .tab.active { opacity: 1; transform: none }` had the same
specificity as `.tab-area .tab.dragging` and came after it, so a dragged
active tab never dimmed. Drag-state rules now sit at the END of
`window-tab-bar.css` and carry `[data-tab-id]` for one extra attribute of
specificity, so they outrank every tab state (including `.tab.active:hover`).
Assert computed opacity in a browser test (`e2e/window-tab-drag-polish.spec.ts`)
rather than trusting rule order.

## Live displacement resolves against resting slots

`domain/tab-reorder.ts` resolves the insertion index from the pointer and the
tabs' slots captured once at drag start (content coordinates, so edge
scrolling does not invalidate them). Resolving against the displaced
on-screen boxes would oscillate: the tab under the pointer moves away as soon
as it is passed. Consequence for tests: once tabs move aside, the element
under the pointer is no longer the drop target. Read the strip's
`data-reorder-to` instead of `elementFromPoint` (`e2e/tab-overflow.spec.ts`).

## The drop glide moves tabs under the next measurement

The drop and cancel FLIP (`flipTabs`, Web Animations with id `tab-flip`)
leaves tabs transformed for ~160ms. A new drag finishes those glides before
measuring slots; browser specs that measure tab boxes right after a drop must
wait for the list's animations (`settleTabs` in
`e2e/window-tab-drag-lifetime.spec.ts`). A cancelled drag's tab also glides
back under the pointer, so Escape marks the next click as swallowed (a
mousedown clears that mark, so a drag released elsewhere cannot eat a later
click).
