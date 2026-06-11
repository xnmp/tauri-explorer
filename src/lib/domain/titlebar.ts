/**
 * Title bar / tab strip visibility rules.
 *
 * The tab strip shows whenever there are multiple tabs, OR when window
 * controls are enabled (Windows 11 style — the strip hosts the controls,
 * so it must remain visible even with one tab), OR when the integrated
 * title bar is on (macOS style — the strip doubles as the title bar).
 */

/** Whether the tab bar (inside the title bar) is visible. */
export function showTabBar(integratedTitleBar: boolean, tabCount: number): boolean {
  return integratedTitleBar || tabCount > 1;
}

/** Whether the title bar row renders at all. */
export function showTitleBar(
  integratedTitleBar: boolean,
  tabCount: number,
  showWindowControls: boolean,
): boolean {
  return showTabBar(integratedTitleBar, tabCount) || showWindowControls;
}

/** Whether the tab strip area (WindowTabBar) is visible. */
export function showTabArea(
  integratedTitleBar: boolean,
  tabCount: number,
  showWindowControls: boolean,
): boolean {
  return integratedTitleBar || tabCount > 1 || showWindowControls;
}
