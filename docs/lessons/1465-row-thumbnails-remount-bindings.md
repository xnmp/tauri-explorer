# #1465 — Row thumbnails: a same-component remount clears its own bindings

Row thumbnails make every Details/List row taller. Details and classic List
take the height reactively (`layoutStore.detailsRowHeight` /
`listRowHeight`). The column-flow List reads `LIST_SLOT_HEIGHT` from
`domain/list-column-flow.ts` inside dozens of pure functions, so it became a
live ESM binding set by `ListColumnsView` as it mounts, and FileList remounts
that view with `{#key settingsStore.state.rowThumbnails}`.

Gotcha: Svelte 5's `BranchManager` mounts the incoming `{#key}` branch
before destroying the outgoing one, and a destroyed component reads its
*last* prop values. ListColumnsView's `onDestroy` guard
(`if (getNavigation === navigation) getNavigation = undefined`) therefore saw
its own stale bindings and cleared the ones the new instance had just
installed: after toggling the setting, Arrow keys did nothing in List. The
new instance re-installs its bindings in `onMount`, which runs after the old
branch is destroyed. `e2e/row-thumbnails.spec.ts` toggles the setting while
List is shown and asserts ArrowDown moves the selection.

Any bindable "retire only our own binding" guard has this hole when the same
component is remounted in place; re-assert on mount rather than trusting the
outgoing instance's comparison.
