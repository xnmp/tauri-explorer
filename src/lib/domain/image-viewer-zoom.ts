/**
 * Zoom and pan for the fullscreen image preview (#219, #236, #1033).
 *
 * A view is `translate(pan) scale(zoom)` applied around the image container's
 * centre. Zoom is clamped to [MIN_ZOOM, MAX_ZOOM]; at the base zoom the image
 * is centred, so pan is always zero there. Every function returns a new view.
 */

export interface ZoomView {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

/** An offset from the image container's centre, in CSS pixels. */
export interface CenterOffset {
  readonly x: number;
  readonly y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Multiplier per +/- key press. */
export const KEY_ZOOM_STEP = 1.25;
/** Multiplier per Ctrl+wheel notch. */
export const WHEEL_ZOOM_STEP = 1.15;
/** Pixels panned per arrow key press while zoomed. */
export const KEY_PAN_STEP = 60;
/** Pointer travel (|dx| + |dy| of one move) beyond which a press is a drag, not a click. */
export const DRAG_SLOP = 2;

export const BASE_VIEW: ZoomView = Object.freeze({ zoom: MIN_ZOOM, panX: 0, panY: 0 });

/** Clamps a requested zoom; a non-finite request falls back to the base zoom. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** Sets the zoom, keeping the pan, except at the base zoom where pan resets. */
export function withZoom(view: ZoomView, zoom: number): ZoomView {
  const next = clampZoom(zoom);
  return next === MIN_ZOOM ? BASE_VIEW : { zoom: next, panX: view.panX, panY: view.panY };
}

/**
 * Zooms keeping the image point under `offset` fixed (standard image-viewer
 * behaviour). For an offset c from the centre, the point stays put when
 * pan' = c - (c - pan) * zoom' / zoom. Without an offset (no container), the
 * zoom changes and the pan is kept.
 */
export function zoomAround(view: ZoomView, zoom: number, offset: CenterOffset | null): ZoomView {
  const next = withZoom(view, zoom);
  if (next.zoom === view.zoom || next.zoom === MIN_ZOOM || !offset) return next;
  const ratio = next.zoom / view.zoom;
  return {
    zoom: next.zoom,
    panX: offset.x - (offset.x - view.panX) * ratio,
    panY: offset.y - (offset.y - view.panY) * ratio,
  };
}

export function panBy(view: ZoomView, dx: number, dy: number): ZoomView {
  return { zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy };
}

/** The zoom a wheel notch asks for: scrolling up zooms in, anything else out. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return deltaY < 0 ? zoom * WHEEL_ZOOM_STEP : zoom / WHEEL_ZOOM_STEP;
}

/** Offset of a client point from the centre of a container rect. */
export function centerOffset(
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  clientX: number,
  clientY: number,
): CenterOffset {
  return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
}

/** Whether one pointer move travelled far enough to count as a drag. */
export function exceedsDragSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) + Math.abs(dy) > DRAG_SLOP;
}

/** CSS transform for the image: none outside fullscreen, identity at base zoom. */
export function zoomTransform(fullscreen: boolean, view: ZoomView): string {
  if (!fullscreen) return "";
  return view.zoom !== MIN_ZOOM ? `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` : "scale(1)";
}

export type FullscreenKeyAction =
  | { readonly kind: "exit" }
  | { readonly kind: "zoom"; readonly factor: number }
  | { readonly kind: "reset" }
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | { readonly kind: "step"; readonly delta: -1 | 1 };

/**
 * What a key does in fullscreen: Esc exits, +/- zoom, 0 resets, arrows pan
 * while zoomed; at the base zoom Left/Right step between siblings and
 * Up/Down do nothing. `null` means the key is not the viewer's.
 */
export function fullscreenKeyAction(key: string, zoom: number): FullscreenKeyAction | null {
  const zoomed = zoom > MIN_ZOOM;
  switch (key) {
    case "Escape":
      return { kind: "exit" };
    case "+":
    case "=":
      return { kind: "zoom", factor: KEY_ZOOM_STEP };
    case "-":
    case "_":
      return { kind: "zoom", factor: 1 / KEY_ZOOM_STEP };
    case "0":
      return { kind: "reset" };
    case "ArrowLeft":
      return zoomed ? { kind: "pan", dx: KEY_PAN_STEP, dy: 0 } : { kind: "step", delta: -1 };
    case "ArrowRight":
      return zoomed ? { kind: "pan", dx: -KEY_PAN_STEP, dy: 0 } : { kind: "step", delta: 1 };
    case "ArrowUp":
      return zoomed ? { kind: "pan", dx: 0, dy: KEY_PAN_STEP } : null;
    case "ArrowDown":
      return zoomed ? { kind: "pan", dx: 0, dy: -KEY_PAN_STEP } : null;
    default:
      return null;
  }
}
