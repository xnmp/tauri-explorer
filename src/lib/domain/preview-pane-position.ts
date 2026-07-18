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

/**
 * Dock *mode*: the persisted setting value, which is either a concrete edge
 * or "auto" — let the window's own geometry pick the edge (#467). Kept as a
 * separate type from `PreviewPanePosition` (the concrete/resolved value)
 * because most consumers (layout CSS, resize math) only ever want a concrete
 * edge and should never have to think about "auto" themselves — see
 * `resolveEffectivePreviewPanePosition`.
 */
export type PreviewPanePositionMode = PreviewPanePosition | "auto";

export const PREVIEW_PANE_POSITION_MODES: readonly PreviewPanePositionMode[] = [
  "right",
  "bottom",
  "top",
  "auto",
] as const;

const DEFAULT_MODE: PreviewPanePositionMode = DEFAULT_POSITION;

/** Coerce any value to a valid mode (adds "auto" to the three concrete
 *  positions). Malformed input falls back to "right", same as
 *  `normalizePreviewPanePosition`. */
export function normalizePreviewPanePositionMode(value: unknown): PreviewPanePositionMode {
  return value === "auto" || value === "bottom" || value === "top" || value === "right"
    ? value
    : DEFAULT_MODE;
}

/** Cycle right -> bottom -> top -> auto -> right. Malformed input normalizes
 *  first. Used by the Alt+Shift+P cycle command (#460) now that "auto" is a
 *  selectable mode (#467) — appended after the existing three-way cycle so
 *  users who never touch auto see unchanged right/bottom/top behavior except
 *  for one extra stop before wrapping back to "right". */
export function cyclePreviewPanePositionMode(current: unknown): PreviewPanePositionMode {
  switch (normalizePreviewPanePositionMode(current)) {
    case "right":
      return "bottom";
    case "bottom":
      return "top";
    case "top":
      return "auto";
    case "auto":
      return "right";
  }
}

// Aspect-ratio (width / height) thresholds for the auto-dock heuristic,
// loosely modeled on VS Code's own panel placement: a wide/landscape window
// has room for a side panel without crushing the main content, so it docks
// right; a narrow window doesn't, so the preview drops to a horizontal edge
// instead. Within "narrow", a merely-narrow-ish (closer to square) window
// docks bottom (the common "drawer" placement); a genuinely tall/narrow
// window (portrait-ish) docks top instead, keeping the preview near the
// window's top rather than pushed far below the fold.
const WIDE_ASPECT_THRESHOLD = 1.3; // width/height >= this -> "right"
const TALL_ASPECT_THRESHOLD = 0.6; // width/height <= this -> "top"

/**
 * Pure geometry -> dock-edge heuristic for "auto" mode. Framework-free and
 * total: any non-positive or non-finite dimension (zero/negative/NaN, e.g.
 * before the window has laid out) falls back to the default "right" rather
 * than throwing or dividing into an unusable result.
 */
export function resolveAutoDockPosition(
  windowWidth: number,
  windowHeight: number,
): PreviewPanePosition {
  if (!(windowWidth > 0) || !(windowHeight > 0)) return DEFAULT_POSITION;
  const aspect = windowWidth / windowHeight;
  if (aspect >= WIDE_ASPECT_THRESHOLD) return "right";
  if (aspect <= TALL_ASPECT_THRESHOLD) return "top";
  return "bottom";
}

/** Resolve a stored mode to the concrete edge components should render at —
 *  "auto" resolves via window geometry, everything else passes through
 *  unchanged. This is the single seam `+page.svelte`/`PreviewPane.svelte`
 *  read so neither has to know "auto" exists. */
export function resolveEffectivePreviewPanePosition(
  mode: PreviewPanePositionMode,
  windowWidth: number,
  windowHeight: number,
): PreviewPanePosition {
  return mode === "auto" ? resolveAutoDockPosition(windowWidth, windowHeight) : mode;
}
