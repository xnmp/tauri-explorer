/**
 * Title bar / tab strip visibility rules.
 *
 * The title bar is the window's top row and hosts the tab strip (#229):
 * tabs on the left, drag region, then the window controls on the right.
 * It renders when window controls are enabled (Windows 11 style), the
 * integrated title bar is on (macOS style), or the tab strip has
 * something to show.
 */

/** Whether the title bar row renders at all. */
export function showTitleBar(
  integratedTitleBar: boolean,
  showWindowControls: boolean,
  tabStripVisible: boolean,
): boolean {
  return integratedTitleBar || showWindowControls || tabStripVisible;
}

/**
 * Whether the tab strip has content of its OWN worth a row: more than one
 * tab, or a renameable single tab whose rename affordance must stay
 * reachable (multi-pane). This is the strip's intrinsic reason to render
 * and says nothing about the row it lives in — components want
 * {@link showTabStrip}.
 */
export function showWindowTabBar(tabCount: number, activeTabRenameable: boolean): boolean {
  return tabCount > 1 || activeTabRenameable;
}

/**
 * Whether the window's tab strip is visible — the rule the components use.
 *
 * The strip renders for its own reasons, OR because the window controls are
 * already holding the row open: hiding the lone tab then saves no vertical
 * space and costs the user the label of the folder they are looking at (#504).
 *
 * `showWindowControls` is a REQUIRED parameter, not a defaulted one, on
 * purpose. This clause was fixed once inline in WindowTabBar.svelte
 * (5ca49d76) and then lost when #140 extracted these rules into this module —
 * the extraction transcribed the rule's shape but not all of its clauses. An
 * omittable argument would let the same bug back in silently.
 */
export function showTabStrip(
  tabCount: number,
  activeTabRenameable: boolean,
  showWindowControls: boolean,
): boolean {
  return showWindowTabBar(tabCount, activeTabRenameable) || showWindowControls;
}
