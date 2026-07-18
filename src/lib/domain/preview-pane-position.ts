/**
 * Preview pane docking position: right (default), bottom, or top.
 *
 * Pure helpers used by the settings store to validate a persisted value and to
 * cycle through positions. Kept framework-free so the logic is unit-testable in
 * isolation from Svelte state.
 */

export type PreviewPanePosition = "right" | "bottom" | "top";

export const PREVIEW_PANE_POSITIONS: readonly PreviewPanePosition[] = [
  "right",
  "bottom",
  "top",
] as const;

const DEFAULT_POSITION: PreviewPanePosition = "right";

/**
 * Coerce any value to a valid position. Anything unrecognized (undefined, a
 * typo in a hand-edited config, a future/removed variant) falls back to
 * "right" so a malformed persisted blob can never break the layout.
 */
export function normalizePreviewPanePosition(value: unknown): PreviewPanePosition {
  return value === "bottom" || value === "top" ? value : DEFAULT_POSITION;
}

/** Cycle right -> bottom -> top -> right. Malformed input normalizes first. */
export function cyclePreviewPanePosition(current: unknown): PreviewPanePosition {
  switch (normalizePreviewPanePosition(current)) {
    case "right":
      return "bottom";
    case "bottom":
      return "top";
    case "top":
      return "right";
  }
}
