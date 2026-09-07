import { onDestroy } from "svelte";
import { loadPersisted, savePersisted } from "$lib/state/persisted";
import { resizeActivity } from "$lib/state/resize-activity.svelte";
import { createPanelResize } from "$lib/state/panel-resize";
import type { PanelWidthOptions } from "$lib/domain/panel-width";

export type PanelResizeOptions = PanelWidthOptions;

/** DOM adapter for the importable panel-width owner. Only an active captured
 * gesture subscribes to global cancellation; no body style overrides survive it. */
export function usePersistedPanelWidth(key: string, options: PanelResizeOptions, presentation: {
  automaticWidth?(): number;
  /** Use when the controlled surface is not the handle's immediate parent. */
  element?(handle: HTMLElement): HTMLElement | null;
} = {}) {
  let revision = $state(0), isResizing = $state(false);
  let retireActivity: (() => void) | undefined;
  let pointer: number | undefined;
  let release: (() => void) | undefined;
  const owner = createPanelResize(loadPersisted<unknown>(key, presentation.automaticWidth ? null : options.default), options, {
    schedule: callback => { const frame = requestAnimationFrame(callback); return () => cancelAnimationFrame(frame); },
    persist: value => savePersisted(key, value),
    automaticWidth: presentation.automaticWidth,
    publish(_value, active) {
      revision += 1; isResizing = active;
      if (active) retireActivity ??= resizeActivity.begin();
      else {
        const cleanup = release; release = undefined; pointer = undefined; cleanup?.();
        retireActivity?.(); retireActivity = undefined;
      }
    },
  });
  const width = $derived.by(() => { revision; return owner.width; });
  onDestroy(owner.cancel);

  function startResize(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const panel = presentation.element ? presentation.element(handle) : handle.parentElement;
    if (!panel) return;
    owner.cancel();
    const cssWidth = parseFloat(getComputedStyle(panel).width);
    const scale = panel.getBoundingClientRect().width / cssWidth;
    if (!owner.start(event.clientX, scale)) return;
    event.preventDefault();
    pointer = event.pointerId;
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
  function move(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    if ((event.buttons & 1) === 0) owner.cancel();
    else owner.move(event.clientX);
  }
  function finish(event: PointerEvent) { if (event.pointerId === pointer) owner.finish(); }
  function cancelPointer(event: PointerEvent) { if (event.pointerId === pointer) owner.cancel(); }
  function keydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (owner.key(event.key)) event.preventDefault();
  }
  return { get width() { return width; }, get isResizing() { return isResizing; },
    min: options.min, max: options.max, startResize, move, finish, cancelPointer, keydown, cancel: owner.cancel };
}
export type PanelResize = ReturnType<typeof usePersistedPanelWidth>;
