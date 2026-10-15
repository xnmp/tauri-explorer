# Tab switches rebuilt the whole pane tree (#1173)

`PaneContainer` rendered only the active tab, inside `{#key activeTabInstance}`,
so every switch destroyed the old tab's pane tree and built the target's from
scratch: navigation bar, file list, and every visible row (`FileItem`, icons,
Git badges). Nothing was reloaded — the explorer state and listing survived in
the manager — but at 4x CPU throttling a switch into a 5000-entry folder cost
~90 ms of main-thread time (150–200 ms under load), almost all of it component
construction. The remount also dropped the list's scroll offset.

Recently active tabs (`RETAINED_TAB_CAPACITY`, active included) now stay
mounted as `.pane-tree.retained` layers: absolutely stacked, `visibility:
hidden`, `content-visibility: hidden` and `inert`. A switch toggles that class;
measured main-thread time per switch dropped to ~30 ms at 4x throttling, and
rows keep their DOM identity and scroll offset.

Notes for later changes:

- Render order must stay stable (`retainTabs` appends, never reorders): moving
  a keyed subtree detaches it, and a detached scroller loses its offset.
- Do not hide with `display: none`: `VirtualList` measures its viewport with
  `bind:clientHeight`, so a zero height would drop all rows but the buffer and
  rebuild them on show.
- Hidden tabs keep their DOM. Global `.entry-item` / `.explorer-pane` locators
  in E2E tests and `document.querySelector` lookups see them; scope to
  `.pane-tree:not(.retained)` or use Playwright's `:visible`.
- `bun run perf:sweep` measures tab switching through `Ctrl+Tab`;
  `e2e/tab-switch-retained.spec.ts` asserts the budget with CDP `TaskDuration`
  under 4x throttling, which separates a remount (90+ ms) from a retained
  switch (~30–45 ms) even on a loaded runner, where wall time does not.
