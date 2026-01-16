/**
 * Context key for pane navigation.
 * Used to communicate navigation requests from Sidebar to PaneContainer.
 */

import { getContext, setContext } from "svelte";
import type { ExplorerInstance } from "./explorer.svelte";

const PANE_NAV_KEY = Symbol("pane-navigation");

export interface PaneNavigationContext {
  navigateTo: (path: string) => void;
  getActiveExplorer: () => ExplorerInstance | null;
  refreshAllPanes: () => void;
}

export function setPaneNavigationContext(ctx: PaneNavigationContext) {
  setContext(PANE_NAV_KEY, ctx);
}

export function getPaneNavigationContext(): PaneNavigationContext | undefined {
  return getContext<PaneNavigationContext>(PANE_NAV_KEY);
}
