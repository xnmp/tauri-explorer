/**
 * Fullscreen image viewing for the Preview pane (#219, #236, #1033).
 *
 * One controller serves every image subject: a file image and a plugin
 * Preview target. Double-click on the pane, or a clean click on the image at
 * fit zoom, toggles it; Esc exits; +/- and 0 zoom; Ctrl+wheel zooms at the
 * cursor; drag and the arrow keys pan while zoomed. At the base zoom,
 * Left/Right call `navigate` (file sibling stepping), and do nothing without it.
 * The math lives in `domain/image-viewer-zoom.ts`.
 *
 * `createPreviewFullscreen` is the state and event handling, with no effects,
 * so it can be tested directly. `usePreviewFullscreen` adds the window
 * keyboard listener and the `data-preview-fullscreen` document attribute
 * (global CSS hides the window chrome off it), and must run during component
 * initialisation.
 */
import {
  BASE_VIEW,
  centerOffset,
  exceedsDragSlop,
  fullscreenKeyAction,
  panBy,
  wheelZoom,
  withZoom,
  zoomAround,
  zoomTransform,
  type ZoomView,
} from "$lib/domain/image-viewer-zoom";
import { dialogStore } from "$lib/state/dialogs.svelte";

/** The parts of a DOM event the handlers read, so tests can pass plain objects. */
type KeyInput = Pick<KeyboardEvent, "key" | "preventDefault" | "stopImmediatePropagation">;
type WheelInput = Pick<WheelEvent, "deltaY" | "clientX" | "clientY" | "preventDefault">;
type PointerInput = Pick<PointerEvent, "button" | "clientX" | "clientY" | "pointerId" | "currentTarget">;
type ClickInput = Pick<MouseEvent, "stopPropagation">;

export interface PreviewFullscreenOptions {
  /** Runs before every toggle (the pane cancels an in-progress resize). */
  onToggle?(): void;
  /** Steps to a sibling subject at the base zoom. Without it, Left/Right do nothing. */
  navigate?(delta: -1 | 1): void;
  /** True while the subject handles its own keys (PDF, video): only Esc stays ours. */
  subjectOwnsKeys?(): boolean;
  /** True while keys belong to something else entirely (a modal dialog). */
  keysBlocked?(): boolean;
}

export function createPreviewFullscreen(options: PreviewFullscreenOptions = {}) {
  let active = $state(false);
  let view = $state.raw<ZoomView>(BASE_VIEW);
  let panning = $state(false);
  let container = $state<HTMLElement | null>(null);
  // Plain fields: drag bookkeeping that nothing renders.
  let panMoved = false;
  let lastX = 0;
  let lastY = 0;

  const transform = $derived(zoomTransform(active, view));

  function resetZoom(): void {
    view = BASE_VIEW;
  }

  function toggle(): void {
    options.onToggle?.();
    active = !active;
    resetZoom();
  }

  function exit(): void {
    active = false;
    resetZoom();
  }

  function zoomAt(zoom: number, clientX: number, clientY: number): void {
    const offset = container ? centerOffset(container.getBoundingClientRect(), clientX, clientY) : null;
    view = zoomAround(view, zoom, offset);
  }

  /** Window keydown (capture phase) while fullscreen; consumes the keys it handles. */
  function handleKey(event: KeyInput): void {
    if (!active || options.keysBlocked?.()) return;
    if (options.subjectOwnsKeys?.() && event.key !== "Escape") return;
    const action = fullscreenKeyAction(event.key, view.zoom);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    switch (action.kind) {
      case "exit": exit(); break;
      case "zoom": view = withZoom(view, view.zoom * action.factor); break;
      case "reset": resetZoom(); break;
      case "pan": view = panBy(view, action.dx, action.dy); break;
      case "step": options.navigate?.(action.delta); break;
    }
  }

  function wheel(event: WheelInput): void {
    if (!active) return;
    event.preventDefault();
    zoomAt(wheelZoom(view.zoom, event.deltaY), event.clientX, event.clientY);
  }

  function pointerDown(event: PointerInput): void {
    if (!active || view.zoom <= 1 || event.button !== 0) return;
    panning = true;
    panMoved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId);
    } catch {
      // Pointer already released (or synthetic event) — pan still works, the
      // capture is just a nicety for drags that leave the container.
    }
  }

  function pointerMove(event: Pick<PointerEvent, "clientX" | "clientY">): void {
    if (!panning) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (exceedsDragSlop(dx, dy)) panMoved = true;
    view = panBy(view, dx, dy);
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function pointerUp(): void {
    panning = false;
  }

  /** A clean click at fit zoom toggles; a drag release or a click while zoomed does not. */
  function click(event: ClickInput): void {
    event.stopPropagation();
    if (panMoved) {
      panMoved = false;
      return;
    }
    if (active && view.zoom > 1) return;
    toggle();
  }

  return {
    get active() { return active; },
    get zoom() { return view.zoom; },
    get panX() { return view.panX; },
    get panY() { return view.panY; },
    get panning() { return panning; },
    get transform() { return transform; },
    /** The image container, for cursor-anchored wheel zoom (`bind:this`). */
    get container() { return container; },
    set container(element: HTMLElement | null) { container = element; },
    toggle,
    exit,
    resetZoom,
    handleKey,
    wheel,
    pointerDown,
    pointerMove,
    pointerUp,
    click,
  };
}

export type PreviewFullscreen = ReturnType<typeof createPreviewFullscreen>;

/** `createPreviewFullscreen` plus its window listener and chrome-hiding attribute. */
export function usePreviewFullscreen(options: PreviewFullscreenOptions = {}): PreviewFullscreen {
  const fullscreen = createPreviewFullscreen({ keysBlocked: () => dialogStore.hasModalOpen, ...options });

  // Capture phase + stopImmediatePropagation so the viewer's keys win over the
  // global keyboard handler in +page.svelte.
  $effect(() => {
    if (!fullscreen.active) return;
    const onKey = (event: KeyboardEvent) => fullscreen.handleKey(event);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // The window tab bar lives far up the tree, outside the pane; global CSS
  // hides it (and other chrome) off this document attribute.
  $effect(() => {
    if (!fullscreen.active) return;
    document.documentElement.setAttribute("data-preview-fullscreen", "");
    return () => document.documentElement.removeAttribute("data-preview-fullscreen");
  });

  return fullscreen;
}
