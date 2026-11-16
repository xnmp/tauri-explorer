/**
 * Where a pane's Miller columns render (#434, #1699).
 *
 * The island layout without a sidebar hoists the columns into their own
 * left island, standing in for the sidebar. That only makes sense for a
 * single-pane tab: in a split, a window-level island could only show the
 * active pane's columns, so moving focus between panes moved the columns in
 * and out of the panes and reflowed the whole split. Split panes therefore
 * keep their columns inline, inside their own island.
 *
 * `+page.svelte` (the island) and `ExplorerPane.svelte` (the inline copy)
 * must both read this one decision, or the columns mount twice or not at all.
 */
export interface MillerPlacementInput {
  /** The applied layout theme uses the island arrangement. */
  readonly islands: boolean;
  readonly showSidebar: boolean;
  /** The active tab shows more than one pane. */
  readonly multiPane: boolean;
}

export function millerHoistedToIsland(input: MillerPlacementInput): boolean {
  return input.islands && !input.showSidebar && !input.multiPane;
}
