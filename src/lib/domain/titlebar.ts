/**
 * Title bar / pane tab strip visibility rules.
 *
 * Tabs are per-pane (each pane renders its own strip), so the title bar
 * no longer hosts tabs: it renders only when window controls are enabled
 * (Windows 11 style) or the integrated title bar is on (macOS style).
 * A pane's tab strip shows when the pane has multiple tabs, or whenever
 * dual-pane is on (so both panes expose their strips as drag targets and
 * the layout stays symmetric).
 */

/** Whether the title bar row renders at all. */
export function showTitleBar(
  integratedTitleBar: boolean,
  showWindowControls: boolean,
): boolean {
  return integratedTitleBar || showWindowControls;
}

/** Whether a pane's tab strip is visible. */
export function showPaneTabBar(tabCount: number, dualPaneEnabled: boolean): boolean {
  return dualPaneEnabled || tabCount > 1;
}
