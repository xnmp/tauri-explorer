import type { PreviewPanePosition } from "$lib/domain/preview-pane-position";
import type { ResizeSizeOptions } from "$lib/domain/resize-size";
import { NUMERIC_SETTINGS } from "$lib/domain/settings-numbers";

/** One resolved dock selects both the committed source and its gesture geometry.
 * Keep the stored zero sentinel intact; the scalar owner decodes it for display. */
export function previewResizeSpec(position: PreviewPanePosition): {
  setting: "previewPaneWidth" | "previewPaneHeight";
  options: ResizeSizeOptions;
} {
  return position === "right"
    ? { setting: "previewPaneWidth", options: { ...NUMERIC_SETTINGS.previewPaneWidth, default: 280, axis: "x", invert: true } }
    : { setting: "previewPaneHeight", options: { ...NUMERIC_SETTINGS.previewPaneHeight, default: 240, axis: "y", invert: position === "bottom" } };
}
