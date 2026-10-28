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

/** Replace listed paths. Marquee updates preserve the range anchor and cursor,
 * even when the cursor is no longer selected; focus is ignored in that mode. */
export function selectPaths(
  entries: readonly FileEntry[],
  paths: readonly string[],
  anchorPath: string | null,
  cursorPath: string | null,
  focus: string | null = null,
  options: { keepAnchor?: boolean } = {},
): { selectedPaths: Set<string>; anchorPath: string | null; cursorPath: string | null } {
  const listed = new Set(entries.map((entry) => entry.path));
  const selectedPaths = new Set(paths.filter((path) => listed.has(path)));
  if (options.keepAnchor) return { selectedPaths, anchorPath, cursorPath };
  const primary = focus !== null && selectedPaths.has(focus) ? focus : [...selectedPaths].at(-1) ?? null;
  return { selectedPaths, anchorPath: primary, cursorPath: primary ?? cursorPath };
}

/**
 * Get selected entries from displayEntries.
 */
export function getSelectedEntries(
  displayEntries: readonly FileEntry[],
  selectedPaths: ReadonlySet<string>
): FileEntry[] {
  if (selectedPaths.size === 0) return [];
  // A reactive set tracks every lookup, so one plain copy serves the scan.
  // Comparing lengths first skips hashing most paths: a decoded path is a
  // prefix + name concatenation that hashing would flatten, which over a
  // 100k+ listing costs more than the rest of the scan (#1417).
  const selected = new Set(selectedPaths);
  const lengths = new Set<number>();
  for (const path of selected) lengths.add(path.length);
  return displayEntries.filter((e) => lengths.has(e.path.length) && selected.has(e.path));
}
