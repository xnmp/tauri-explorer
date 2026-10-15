import type { FileEntry } from "./file";

export interface ClickModifiers {
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly button?: number;
}

/** Only the target pane's selection changes. Shift retains its range behavior. */
export function clickSelectionEffect(modifiers: ClickModifiers, targetPane: string, focusedPane: string) {
  return {
    focusPane: !((modifiers.button ?? 0) === 0 && targetPane !== focusedPane
      && (modifiers.ctrlKey || modifiers.metaKey) && !modifiers.shiftKey),
    selectionModifiers: {
      ctrlKey: !!(modifiers.ctrlKey || modifiers.metaKey),
      shiftKey: !!modifiers.shiftKey,
    },
  };
}

export interface PaneSelection {
  readonly id: string;
  /** Entries in the pane's existing selection order. */
  readonly entries: readonly FileEntry[];
}

/** Panes arrive in visual order; focused pane wins duplicate paths. */
export function combinedSelection(panes: readonly PaneSelection[], focusedId: string): FileEntry[] {
  const focused = panes.find((pane) => pane.id === focusedId);
  const ordered = focused ? [focused, ...panes.filter((pane) => pane.id !== focusedId)] : panes;
  const seen = new Set<string>();
  const result: FileEntry[] = [];
  for (const pane of ordered) {
    for (const entry of pane.entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      result.push(entry);
    }
  }
  return result;
}
