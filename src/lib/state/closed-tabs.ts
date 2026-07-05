/**
 * Closed-tab snapshot stack for Ctrl+Shift+T restoration.
 * Issues: tauri-explorer-ldfx (window tabs), #140 (dual-pane-as-windows)
 * Issue: refactor/audit-tier4-splits (#212)
 *
 * A localStorage-backed, capped LIFO stack of recently closed tabs. Shared
 * across windows via localStorage: each window reloads on focus so a tab
 * closed elsewhere becomes restorable here. Holds only the serializable
 * snapshots — the restore orchestration that touches live tabs/explorers
 * stays in the window-tabs manager.
 */

import { loadPersisted, savePersisted } from "./persisted";
import { type ClosedTabSnapshot, normalizeClosedSnapshot } from "./window-tabs-persistence";

const CLOSED_TABS_KEY = "explorer-closed-tabs";
const MAX_CLOSED_TABS = 20;

function loadClosedTabs(): ClosedTabSnapshot[] {
  return loadPersisted<unknown[]>(CLOSED_TABS_KEY, [])
    .map(normalizeClosedSnapshot)
    .filter((s): s is ClosedTabSnapshot => s !== null);
}

/** The stack of recently closed tabs, persisted to localStorage. */
export interface ClosedTabsStore {
  /** Reload from localStorage (picks up snapshots closed in other windows). */
  refresh(): void;
  /** Push a snapshot onto the stack (enforcing the cap) and persist. */
  push(snapshot: ClosedTabSnapshot): void;
  /** Pop the most recent snapshot and persist; undefined when empty. */
  pop(): ClosedTabSnapshot | undefined;
  /** Peek the most recent snapshot without removing it. */
  peek(): ClosedTabSnapshot | undefined;
  /** Number of snapshots currently on the stack. */
  readonly size: number;
}

/** Create a closed-tab stack backed by localStorage. */
export function createClosedTabsStore(): ClosedTabsStore {
  let stack: ClosedTabSnapshot[] = loadClosedTabs();

  function save(): void {
    savePersisted(CLOSED_TABS_KEY, stack);
  }

  return {
    refresh(): void {
      stack = loadClosedTabs();
    },
    push(snapshot: ClosedTabSnapshot): void {
      stack.push(snapshot);
      if (stack.length > MAX_CLOSED_TABS) {
        stack.shift();
      }
      save();
    },
    pop(): ClosedTabSnapshot | undefined {
      const snapshot = stack.pop();
      if (snapshot) save();
      return snapshot;
    },
    peek(): ClosedTabSnapshot | undefined {
      return stack[stack.length - 1];
    },
    get size(): number {
      return stack.length;
    },
  };
}
