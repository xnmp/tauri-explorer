/**
 * Closed-surface history rules (#229, #1372): the bounded stack of closed
 * panes Ctrl+Shift+T restores, and how it competes with closed tabs.
 */

import type { LeafSiblingContext } from "./pane-layout";

/** A closed pane, restorable while its tab still lives in this window. */
export interface ClosedPaneSnapshot extends LeafSiblingContext {
  tabId: string;
  path: string;
  /** The pane's view choice (plugin view id, or null for built-in). */
  fileView: string | null | undefined;
  peeks: readonly string[];
  ts: number;
}

export const MAX_CLOSED_PANES = 20;

/** The stack with `snapshot` on top, dropping the oldest beyond `max`. */
export function pushClosedPane(
  stack: readonly ClosedPaneSnapshot[],
  snapshot: ClosedPaneSnapshot,
  max = MAX_CLOSED_PANES,
): ClosedPaneSnapshot[] {
  const next = [...stack, snapshot];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Whether the newest closed pane is restored before the newest closed tab
 *  (it closed at the same time or later). */
export function prefersPaneRestore(pane: { ts: number } | undefined, lastTabClosedTs: number | undefined): boolean {
  return !!pane && pane.ts >= (lastTabClosedTs ?? 0);
}

interface WindowCloseSnapshot {
  fromClosedWindow?: boolean;
  path: string;
  closedAt: number;
}

/** Closing the last tab snapshots it, then attempts native destruction,
 *  which can fail silently: a repeated Ctrl+W must not stack an identical
 *  closed-window snapshot. */
export function repeatsWindowClose(top: WindowCloseSnapshot | undefined, next: WindowCloseSnapshot): boolean {
  return !!top && !!top.fromClosedWindow && !!next.fromClosedWindow
    && top.path === next.path && top.closedAt === next.closedAt;
}
