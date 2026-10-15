import { admitFileDrop } from "$lib/state/dispatch-file-drop";
import { resolveDropTargetFromElement } from "./use-native-drop-target.svelte";
import { dragState, type DragData } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { isExplorerFileTransfer } from "$lib/domain/file-drop";

function pinOnQuickAccess(quickAccess: HTMLElement, source: DragData): void {
  const target = resolveDropTargetFromElement(quickAccess);
  const receipt = admitFileDrop(target, source, "dom");
  if (!receipt) return;
  try {
    if (target?.type === "sidebar" && source.kind === "directory" && source.path) bookmarksStore.addBookmark(source.path, source.name);
  } finally { receipt.finish(); }
}

/** Document capture runs before a source's bubble-phase dragend handler. */
export function listenSidebarDragEnd(deps: {
  quickAccess: () => HTMLElement | undefined;
  isDragOver: () => boolean;
  reset: () => void;
}): () => void {
  const sources = new WeakMap<EventTarget, DragData>();
  const deferred = new Set<() => void>();
  let escaped = false;
  const onDragStart = (event: DragEvent) => {
    escaped = false;
    if (!event.target) return;
    sources.delete(event.target);
    if (!isExplorerFileTransfer(event.dataTransfer) || !event.dataTransfer) return;
    const source = dragState.domSource(event.dataTransfer);
    if (source) sources.set(event.target, source);
  };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") escaped = true; };

  /** Linux can deliver only dragend while the native start is still pending
   * (#1101). Defer the pin to a rejection only for a gesture known to have
   * ended on this Quick Access: a completed (not "none") drop effect, no
   * Escape, no source-owned deferred Drop, and the end point itself (not
   * cached hover) inside it. The destination must still be the same live,
   * sidebar-owned element when the decision arrives. GTK grabs the keyboard
   * during a drag, so Escape may never reach the page; dragend's dropEffect
   * is the spec's cancellation signal. */
  function deferUntilRejected(event: DragEvent, quickAccess: HTMLElement, source: DragData, point: Element | null): void {
    const live = dragState.latestSource();
    const pending = escaped || (event.dataTransfer?.dropEffect ?? "none") === "none" || source.kind !== "directory"
      || live?.sessionId !== source.sessionId || live?.transport !== "native-pending"
      || dragState.retains(source.sessionId!) || !quickAccess.contains(point) ? null : dragState.pendingNative();
    if (!pending) return;
    // Disposal clears the set, so membership is the abandonment flag.
    const cancel = () => pending.dispose();
    deferred.add(cancel);
    void pending.result.then(accepted => {
      if (!deferred.delete(cancel) || accepted) return;
      if (deps.quickAccess() === quickAccess && quickAccess.isConnected && point!.isConnected) pinOnQuickAccess(quickAccess, source);
      else toastStore.show("Drop cancelled because the destination changed. Drop the files again.");
    });
  }

  function onDragEnd(event: DragEvent): void {
    // dragend receives a fresh, protected DataTransfer: getData cannot recover
    // the source identity. The source node is stable across its drag events.
    const endedSource = event.target ? sources.get(event.target) ?? null : null;
    const quickAccess = deps.quickAccess();
    const point = event.clientX > 0 && event.clientY > 0 ? document.elementFromPoint(event.clientX, event.clientY) : null;
    if ((deps.isDragOver() || quickAccess?.contains(point)) && quickAccess?.isConnected && endedSource) {
      deferUntilRejected(event, quickAccess, endedSource, point);
      pinOnQuickAccess(quickAccess, endedSource);
    }
    escaped = false;
    deps.reset();
    dragState.finish(endedSource);
    if (event.target) sources.delete(event.target);
  }
  document.addEventListener("dragstart", onDragStart as EventListener);
  document.addEventListener("dragend", onDragEnd, { capture: true });
  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("dragstart", onDragStart as EventListener);
    document.removeEventListener("dragend", onDragEnd, { capture: true });
    window.removeEventListener("keydown", onKeyDown, true);
    // Release cross-window decision listeners; clearing abandons each pin.
    for (const cancel of deferred) cancel();
    deferred.clear();
  };
}
