/**
 * Pane-scoped Svelte context.
 *
 * Access rule (refactor #4): components rendered *inside* a pane resolve
 * their pane via this context (or receive `explorer` as a prop); only
 * window-global surfaces (QuickOpen, CommandPalette, ContentSearchDialog,
 * SCM panel, status bar, preview) use the windowTabsManager singleton.
 */

import { getContext, setContext } from "svelte";
import type { PaneId } from "./types";

const PANE_ID_KEY = "pane-id";

/** Set by ExplorerPane at init (paneId is a static literal per pane). */
export function setPaneIdContext(paneId: PaneId): void {
  setContext(PANE_ID_KEY, paneId);
}

/**
 * Consumed by per-entry components (e.g. GitStatusBadge) to resolve which
 * pane — and therefore which directory — they are rendered in, so dual
 * panes showing different directories don't bleed state into each other.
 */
export function getPaneIdContext(): PaneId | undefined {
  return getContext<PaneId | undefined>(PANE_ID_KEY);
}
