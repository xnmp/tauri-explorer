import { admitFileDrop } from "$lib/state/dispatch-file-drop";
import { resolveDropTargetFromElement } from "./use-native-drop-target.svelte";
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
    if (overQuickAccess && quickAccess?.isConnected && endedSource) {
      // Route dragend-only completion through window capture too. It owns
      // pending-start snapshots, destination leases and rejection redispatch.
      const target = resolveDropTargetFromElement(quickAccess);
      const live = dragState.latestSource();
      if (target?.type === "sidebar" && live?.sessionId === endedSource.sessionId && live?.transport === "native-pending") {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData("application/x-explorer-kind", endedSource.kind);
        dataTransfer.setData("application/x-explorer-session", endedSource.sessionId!);
        dragState.bindDomSource(dataTransfer, endedSource);
        quickAccess.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer,
          clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, altKey: event.altKey,
          shiftKey: event.shiftKey, metaKey: event.metaKey }));
      }
      const receipt = admitFileDrop(target, endedSource, "dom");
      if (receipt) {
        try {
          const { kind, path, name } = endedSource;
          if (target?.type === "sidebar" && kind === "directory" && path) bookmarksStore.addBookmark(path, name);
        } finally { receipt.finish(); }
      }
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
