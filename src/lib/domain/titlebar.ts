/**
 * Title bar / tab strip visibility rules.
 *
 * The title bar is the window's top row and hosts the tab strip (#229):
 * tabs on the left, drag region, then the window controls on the right.
 * It renders when window controls are enabled (Windows 11 style), the
 * integrated title bar is on (macOS style), or the tab strip has
 * something to show. The tab strip shows when there are multiple tabs,
 * when the active tab is renameable (multi-pane) so its rename
 * affordance stays reachable, or when window controls are enabled — the
 * bar is already occupying the row to host them, so hiding the tab
 * leaves the user's current folder unlabelled for no space saving (#504).
 *
 * That last clause has been lost once already: it was fixed inline in
 * WindowTabBar.svelte (5ca49d76), then dropped when #140 extracted these
 * rules into this module. It lives here, under test, so the next
 * extraction cannot silently drop it again.
 */

/** Whether the title bar row renders at all. */
export function showTitleBar(
  integratedTitleBar: boolean,
  showWindowControls: boolean,
  tabStripVisible: boolean,
): boolean {
  return integratedTitleBar || showWindowControls || tabStripVisible;
}

/** Whether the window's tab strip is visible. */
export function showWindowTabBar(tabCount: number, activeTabRenameable: boolean): boolean {
  return tabCount > 1 || activeTabRenameable;
}
