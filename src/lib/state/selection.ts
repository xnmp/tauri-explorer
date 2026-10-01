/**
 * Pure selection logic utilities.
 * Stateless functions for calculating selection state.
 */

import type { FileEntry } from "$lib/domain/file";
import type { SelectOptions } from "./types";

/**
 * Calculate new selection based on click action.
 * Returns the new Set of selected paths and path-based range anchor.
 */
export function calculateSelection(
  displayEntries: FileEntry[],
  clickedEntry: FileEntry,
  currentSelection: Set<string>,
  anchorPath: string | null,
  options: SelectOptions
): { selectedPaths: Set<string>; anchorPath: string | null } {
  const clickedIndex = displayEntries.findIndex((e) => e.path === clickedEntry.path);
  if (clickedIndex === -1) {
    return { selectedPaths: currentSelection, anchorPath };
  }

  const anchorIndex = displayEntries.findIndex((entry) => entry.path === anchorPath);
  if (options.shiftKey && anchorIndex >= 0) {
    // Shift+click: select range from anchor to clicked item
    const start = Math.min(anchorIndex, clickedIndex);
    const end = Math.max(anchorIndex, clickedIndex);
    const rangePaths = displayEntries.slice(start, end + 1).map((e) => e.path);
    return { selectedPaths: new Set(rangePaths), anchorPath };
  }

  if (options.ctrlKey) {
    // Ctrl+click: toggle selection
    const newSelection = new Set(currentSelection);
    if (newSelection.has(clickedEntry.path)) {
      newSelection.delete(clickedEntry.path);
    } else {
      newSelection.add(clickedEntry.path);
    }
    return { selectedPaths: newSelection, anchorPath: clickedEntry.path };
  }

  // Normal click: single select
  return {
    selectedPaths: new Set([clickedEntry.path]),
    anchorPath: clickedEntry.path,
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
    // Check if adding these paths actually changes the selection
    const allAlreadySelected = pathsToSelect.every((p) => currentSelection.has(p));
    if (allAlreadySelected) return currentSelection;

    const newSelection = new Set(currentSelection);
    for (const path of pathsToSelect) {
      newSelection.add(path);
    }
    return newSelection;
  }

  // Skip creating a new Set if the selection is identical
  if (
    pathsToSelect.length === currentSelection.size &&
    pathsToSelect.every((p) => currentSelection.has(p))
  ) {
    return currentSelection;
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
