/** The panel edge a resize handle sits on (#1925). A handle on a left or right
 * edge is a vertical line that resizes width; one on a top or bottom edge is a
 * horizontal line that resizes height. */
export type ResizeEdge = "left" | "right" | "top" | "bottom";

/** WAI-ARIA `aria-orientation` of a separator on `edge`. */
export function resizeOrientation(edge: ResizeEdge): "vertical" | "horizontal" {
  return edge === "left" || edge === "right" ? "vertical" : "horizontal";
}
