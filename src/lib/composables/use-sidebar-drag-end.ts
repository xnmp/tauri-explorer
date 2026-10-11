import { dragState, type DragData } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { isExplorerFileTransfer } from "$lib/domain/file-drop";

/** Document capture runs before a source's bubble-phase dragend handler. */
export function listenSidebarDragEnd(deps: {
  quickAccess: () => HTMLElement | undefined;
  isDragOver: () => boolean;
  reset: () => void;
}): () => void {
  const sources = new WeakMap<EventTarget, DragData>();
  const onDragStart = (event: DragEvent) => {
    if (!event.target) return;
    sources.delete(event.target);
    if (!isExplorerFileTransfer(event.dataTransfer) || !event.dataTransfer) return;
    const source = dragState.domSource(event.dataTransfer);
    if (source) sources.set(event.target, source);
  };
  function onDragEnd(event: DragEvent): void {
    // dragend receives a fresh, protected DataTransfer: getData cannot recover
    // the source identity. The source node is stable across its drag events.
    const endedSource = event.target ? sources.get(event.target) ?? null : null;
    let overQuickAccess = deps.isDragOver();
    const quickAccess = deps.quickAccess();
    if (!overQuickAccess && quickAccess && event.clientX > 0 && event.clientY > 0) {
      overQuickAccess = quickAccess.contains(document.elementFromPoint(event.clientX, event.clientY));
    }
    if (overQuickAccess && endedSource) {
      const { kind, path, name } = endedSource;
      if (kind === "directory" && path) bookmarksStore.addBookmark(path, name);
    }
    deps.reset();
    dragState.finish(endedSource);
    if (event.target) sources.delete(event.target);
  }
  document.addEventListener("dragstart", onDragStart as EventListener);
  document.addEventListener("dragend", onDragEnd, { capture: true });
  return () => {
    document.removeEventListener("dragstart", onDragStart as EventListener);
    document.removeEventListener("dragend", onDragEnd, { capture: true });
  };
}
