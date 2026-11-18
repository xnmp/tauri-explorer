/**
 * Floating Islands surfaces that can meet the tab strip's base (#1734):
 * shared by the tab seam marks and the strip-start alignment.
 */

/** Island surfaces whose top edge can meet the strip base. */
export const ISLANDS = [
  '[data-region="sidebar"]',
  '[data-region="miller-island"]',
  '[data-region="panes"]:not([data-split])',
  '[data-region="panes"][data-split] [data-region="pane"]',
  '[data-region="preview"]',
  '[data-region="scm"][data-island]',
].join(",");

/** Structural islands wear a heavier surface than content islands. */
export const STRUCTURAL = '[data-region="sidebar"]';
