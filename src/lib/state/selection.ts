/**
 * Pure selection logic utilities.
 * Stateless functions for calculating selection state.
 */

import type { FileEntry } from "$lib/domain/file";
import type { SelectOptions } from "./types";

/**
 * Calculate new selection based on click action.
 * Returns the new Set of selected paths and optional new anchor index.
 */
export function calculateSelection(
  displayEntries: FileEntry[],
  clickedEntry: FileEntry,
  currentSelection: Set<string>,
  anchorIndex: number | null,
  options: SelectOptions
): { selectedPaths: Set<string>; anchorIndex: number | null } {
  const clickedIndex = displayEntries.findIndex((e) => e.path === clickedEntry.path);
  if (clickedIndex === -1) {
    return { selectedPaths: currentSelection, anchorIndex };
  }

  if (options.shiftKey && anchorIndex !== null) {
    // Shift+click: select range from anchor to clicked item
    const start = Math.min(anchorIndex, clickedIndex);
    const end = Math.max(anchorIndex, clickedIndex);
    const newSelection = new Set<string>();
    for (let i = start; i <= end; i++) {
      newSelection.add(displayEntries[i].path);
    }
    return { selectedPaths: newSelection, anchorIndex }; // Keep anchor unchanged
  }

  if (options.ctrlKey) {
    // Ctrl+click: toggle selection
    const newSelection = new Set(currentSelection);
    if (newSelection.has(clickedEntry.path)) {
      newSelection.delete(clickedEntry.path);
    } else {
      newSelection.add(clickedEntry.path);
    }
    return { selectedPaths: newSelection, anchorIndex: clickedIndex };
  }

  // Normal click: single select
  return {
    selectedPaths: new Set([clickedEntry.path]),
    anchorIndex: clickedIndex,
  };
}

/**
 * Select entries by their indices in displayEntries.
 * Used for marquee/drag selection.
 */
export function selectByIndices(
  displayEntries: FileEntry[],
  indices: number[],
  currentSelection: Set<string>,
  addToSelection: boolean
): Set<string> {
  const pathsToSelect = indices
    .filter((i) => i >= 0 && i < displayEntries.length)
    .map((i) => displayEntries[i].path);

  if (addToSelection) {
    const newSelection = new Set(currentSelection);
    for (const path of pathsToSelect) {
      newSelection.add(path);
    }
    return newSelection;
  }

  return new Set(pathsToSelect);
}

/**
 * Get selected entries from displayEntries.
 */
export function getSelectedEntries(
  displayEntries: FileEntry[],
  selectedPaths: Set<string>
): FileEntry[] {
  return displayEntries.filter((e) => selectedPaths.has(e.path));
}
