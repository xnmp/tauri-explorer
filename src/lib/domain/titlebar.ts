/**
 * Title bar / tab strip visibility rules.
 *
 * Tabs are window-level (#228); the title bar doesn't host them: it
 * renders only when window controls are enabled (Windows 11 style) or the
 * integrated title bar is on (macOS style). The window's tab strip shows
 * when there are multiple tabs, or when the active tab is renameable
 * (multi-pane) so its rename affordance stays reachable.
 */

/** Whether the title bar row renders at all. */
export function showTitleBar(
  integratedTitleBar: boolean,
  showWindowControls: boolean,
): boolean {
  return integratedTitleBar || showWindowControls;
}

/** Whether the window's tab strip is visible. */
export function showWindowTabBar(tabCount: number, activeTabRenameable: boolean): boolean {
  return tabCount > 1 || activeTabRenameable;
}
