import { onDestroy } from "svelte";
import { resizeActivity } from "$lib/state/resize-activity.svelte";
import type { ResizeEffects, ScalarResize } from "$lib/state/scalar-resize";

export interface ResizePresentation {
  element?(handle: HTMLElement): HTMLElement | null;
  /** Visual pixels per model unit; supply for counter-zoomed geometry. */
  scale?(element: HTMLElement): number;
}

/** DOM lifetime shared by width/height preference adapters. Global cancellation
 * listeners exist only while one primary pointer owns capture. */
export function useResizeOwner(create: (effects: ResizeEffects) => ScalarResize, presentation: ResizePresentation = {}) {
  let revision = $state(0), isResizing = $state(false);
  let retireActivity: (() => void) | undefined;
  let pointer: number | undefined;
  let capturedHandle: HTMLElement | undefined;
  let release: (() => void) | undefined;
  const owner = create({
    schedule: callback => { const frame = requestAnimationFrame(callback); return () => cancelAnimationFrame(frame); },
    retire() {
      const cleanup = release; release = undefined; pointer = undefined; capturedHandle = undefined; cleanup?.();
      retireActivity?.(); retireActivity = undefined;
      isResizing = false;
    },
    publish(_value, active) {
      revision += 1; isResizing = active;
      if (active) retireActivity ??= resizeActivity.begin();
    },
  });
  const value = $derived.by(() => { revision; return owner.value; });
  onDestroy(owner.cancel);

  function startResize(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const element = presentation.element ? presentation.element(handle) : handle.parentElement;
    if (!element) return;
    owner.cancel();
    const dimension = owner.axis === "x" ? "width" : "height";
    const scale = presentation.scale?.(element)
      ?? element.getBoundingClientRect()[dimension] / parseFloat(getComputedStyle(element)[dimension]);
    if (!owner.start(owner.axis === "x" ? event.clientX : event.clientY, scale)) return;
    event.preventDefault();
    pointer = event.pointerId;
    capturedHandle = handle;
    const controller = new AbortController();
    const zoom = new MutationObserver(owner.cancel);
    zoom.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("blur", owner.cancel, { signal: controller.signal });
    window.addEventListener("resize", owner.cancel, { signal: controller.signal });
    window.addEventListener("scroll", owner.cancel, { signal: controller.signal, capture: true });
    release = () => {
      controller.abort(); zoom.disconnect();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    try { handle.setPointerCapture(event.pointerId); }
    catch { owner.cancel(); }
  }
  // One owner can serve several keyed handles. Loss from a retired target may
  // arrive after the same pointer has been captured by its replacement.
  function owns(event: PointerEvent) {
    return event.pointerId === pointer && event.currentTarget === capturedHandle;
  }
  function move(event: PointerEvent) {
    if (!owns(event)) return;
    if ((event.buttons & 1) === 0) owner.cancel();
    else owner.move(owner.axis === "x" ? event.clientX : event.clientY);
  }
  function finish(event: PointerEvent) { if (owns(event)) owner.finish(); }
  function cancelPointer(event: PointerEvent) { if (owns(event)) owner.cancel(); }
  function keydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (owner.key(event.key)) event.preventDefault();
  }
  return { get value() { return value; }, get isResizing() { return isResizing; },
    get axis() { return owner.axis; }, get min() { return owner.min; }, get max() { return owner.max; },
    startResize, move, finish, cancelPointer, keydown, cancel: owner.cancel, reconcile: owner.reconcile };
}
export type ResizeController = ReturnType<typeof useResizeOwner>;
