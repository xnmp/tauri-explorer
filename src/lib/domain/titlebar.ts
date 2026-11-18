/**
 * Title bar / tab strip visibility rules.
 *
 * The title bar is the window's top row and hosts the tab strip (#229):
 * tabs on the left, drag region, then the window controls on the right.
 * It renders when window controls are enabled (Windows 11 style), the
 * integrated title bar is on (macOS style), or the tab strip has
 * something to show.
 */

/**
 * Whether the custom min/max/close controls render. macOS windows always have
 * native traffic lights (`decorations(true)` + overlay title bar), so the
 * custom set never renders there regardless of the setting (#1756). Every
 * reader of the setting must go through this, not the raw value.
 */
export function effectiveWindowControls(showWindowControls: boolean, isMac: boolean): boolean {
  return !isMac && showWindowControls;
}

/**
 * Whether something other than the tabs holds the title bar row open: the
 * integrated title bar (the macOS traffic lights sit in it) or custom window
 * controls that actually render ({@link effectiveWindowControls}).
 */
export function titleRowHeldOpen(integratedTitleBar: boolean, showWindowControls: boolean, isMac: boolean): boolean {
  return integratedTitleBar || effectiveWindowControls(showWindowControls, isMac);
}

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
 * The strip renders for its own reasons, OR because something else is
 * already holding the row open ({@link titleRowHeldOpen}: window controls, or
 * the macOS integrated title bar's traffic lights): hiding the lone tab then
 * saves no vertical space and costs the user the label of the folder they are
 * looking at (#504). On macOS the custom controls never render (#1756), so the
 * integrated title bar is what holds the row there; a Floating Islands window
 * needs that lone tab, since the active tab owns its island's top edge (#1734).
 *
 * `rowHeldOpen` is a REQUIRED parameter, not a defaulted one, on
 * purpose. This clause was fixed once inline in WindowTabBar.svelte
 * (5ca49d76) and then lost when #140 extracted these rules into this module —
 * the extraction transcribed the rule's shape but not all of its clauses. An
 * omittable argument would let the same bug back in silently.
 */
export function showTabStrip(
  tabCount: number,
  activeTabRenameable: boolean,
  rowHeldOpen: boolean,
): boolean {
  return showWindowTabBar(tabCount, activeTabRenameable) || rowHeldOpen;
}

/**
 * Whether a primary press on `target` drags (or, double-clicked, maximizes)
 * the window. Everything in the title bar does, except its controls: buttons,
 * fields, the tabs and their scroller, and the open-tabs picker. That
 * includes the strip's empty band before its first tab, which Floating
 * Islands widens over the sidebar (#1734).
 */
export function startsWindowDrag(target: Element | null): boolean {
  return !target?.closest("button, input, textarea, select, .tab-scroll-group, .window-tab-picker");
}
