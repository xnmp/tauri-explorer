/**
 * Title bar / tab strip visibility rules.
 *
 * The title bar is the window's top row and hosts the tab strip (#229):
 * tabs on the left, drag region, then the window controls on the right.
 * It renders when window controls are enabled (Windows 11 style), the
 * integrated title bar is on (macOS style), or the tab strip has
 * something to show. The tab strip shows when there are multiple tabs,
 * or when the active tab is renameable (multi-pane) so its rename
 * affordance stays reachable.
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
