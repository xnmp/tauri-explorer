/**
 * The mock filesystem's change feed: every place that changes the mock
 * listings publishes what it did here, once, whether the change came from a
 * command, a copy/move session, or undo/redo re-executing one. Observers (the
 * site demo's media map and its host bridge) subscribe here rather than to
 * commands, so no execution path can bypass them.
 *
 * Observers never change an outcome: each runs isolated, and a throwing
 * observer is reported and skipped while the change it was told about stands.
 */

export type MockFsOp =
  | "mkdir" | "create" | "write" | "rename" | "move" | "copy" | "symlink"
  | "trash" | "delete" | "restore" | "purge" | "compress" | "extract";

export interface MockFsChange {
  readonly op: MockFsOp;
  /** The path the change produced (or removed, for trash/delete/purge). */
  readonly path: string;
  /** The previous path, for rename/move/copy. */
  readonly from?: string;
}

type Listener = (change: MockFsChange) => void;
const listeners = new Set<Listener>();

/** Observe every mock filesystem change; returns the unsubscribe function. */
export function onMockFsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishMockFsChange(change: MockFsChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error("[mock] filesystem change observer failed", change, error);
    }
  }
}
