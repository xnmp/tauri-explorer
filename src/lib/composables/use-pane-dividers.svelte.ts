import { onDestroy } from "svelte";
import { splitRatioFromKey, type PaneGeometry } from "$lib/domain/pane-viewport";
import type { PaneSplit } from "$lib/domain/pane-layout";
import { createPaneResize } from "$lib/state/pane-resize";

/** One captured gesture per viewport, regardless of the split-tree depth. */
export function usePaneDividers(deps: {
  geometry(): PaneGeometry | undefined;
  begin(splitId: string): (ratio: number) => boolean;
}) {
  let activeId = $state<string>();
  let pointer: number | undefined;
  let release: (() => void) | undefined;
  let valid: (() => boolean) | undefined;
  const resize = createPaneResize({
    schedule: callback => {
      const frame = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frame);
    },
    publishActive: active => {
      if (active) return;
      const previous = release;
      activeId = undefined; pointer = undefined; release = undefined; valid = undefined;
      previous?.();
    },
  });
  onDestroy(resize.cancel);

  function start(event: PointerEvent, node: PaneSplit) {
    if (!event.isPrimary || event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const container = handle.parentElement;
    const geometry = deps.geometry()?.splits.get(node.id);
    if (!container || !geometry) return;
    event.preventDefault();
    resize.cancel();
    // Both DOM rectangles use the same visual coordinate space under root zoom.
    const rect = container.getBoundingClientRect();
    const dividerRect = handle.getBoundingClientRect();
    const horizontal = node.direction === "row";
    const gap = horizontal ? dividerRect.width : dividerRect.height;
    const commit = deps.begin(node.id);
    const captured = geometry.rect;
    const unchanged = () => {
      const current = deps.geometry()?.splits.get(node.id);
      return !!current && current.min === geometry.min && current.max === geometry.max
        && current.rect.x === captured.x && current.rect.y === captured.y
        && current.rect.w === captured.w && current.rect.h === captured.h;
    };
    resize.start({
      direction: node.direction,
      start: (horizontal ? rect.left : rect.top) + gap / 2,
      extent: (horizontal ? rect.width : rect.height) - gap,
      commit: ratio => unchanged() && commit(Math.max(geometry.min, Math.min(geometry.max, ratio))),
    });
    activeId = node.id;
    valid = unchanged;
    pointer = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    release = () => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); };
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    if ((event.buttons & 1) === 0) resize.cancel();
    else resize.move(event.clientX, event.clientY);
  }
  function finish(event: PointerEvent) { if (event.pointerId === pointer) resize.finish(); }
  function cancelPointer(event: PointerEvent) { if (event.pointerId === pointer) resize.cancel(); }
  function key(event: KeyboardEvent, node: PaneSplit) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const geometry = deps.geometry()?.splits.get(node.id);
    if (!geometry) return;
    const value = splitRatioFromKey(node.direction, event.key, geometry);
    if (value === undefined) return;
    event.preventDefault();
    resize.cancel();
    deps.begin(node.id)(value);
  }
  return { get activeId() { return activeId; }, start, move, finish, cancelPointer, key,
    cancel: resize.cancel, reconcile() { if (valid && !valid()) resize.cancel(); } };
}
export type PaneDividers = ReturnType<typeof usePaneDividers>;
