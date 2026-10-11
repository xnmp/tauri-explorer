/**
 * Composable for handling native (external) file drops.
 *
 * Extracts the drop handling logic from +page.svelte: modifier key tracking,
 * Tauri onDragDropEvent setup, and position-based drop target resolution.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { useExternalDrop } from "$lib/composables/use-external-drop.svelte";
import { resolveDropTarget, resolveDropTargetFromElement, highlightTarget, highlightTargetAtPoint, clearHighlights, captureHighlightCleanup } from "$lib/composables/use-native-drop-target.svelte";
import { dragState, type DragData } from "$lib/state/drag.svelte";
import { handleFileDropMany } from "$lib/state/drop-operations";
import { isCopyModifier as isCopyMod, isWindows } from "$lib/domain/platform";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { terminalPanelStore } from "$lib/state/terminal.svelte";
import { parentDir, isInsideDir, samePath } from "$lib/domain/path";
import { dispatchFileDrop } from "$lib/state/dispatch-file-drop";
import { internalDragPaths, sameDropPathSet, domDropPaths, domOwnsFileDrop } from "$lib/domain/file-drop";
import { nativeDropPaths } from "$lib/domain/native-drop-paths";

export interface NativeDropDeps {
  getActiveExplorer: () => ExplorerInstance | undefined;
  refreshAllPanes: () => void;
}

export function useNativeDropHandler(deps: NativeDropDeps) {
  let copyModifierHeld = false;
  // Receiver-owned snapshot of the live source at native Enter. Source result
  // and destination Drop use different IPC channels and can arrive reordered.
  let nativeGesture: { data: DragData | null } | null = null;
  let nativeDomSession: string | undefined;
  const deferredDomSources = new WeakMap<DragEvent, DragData>();
  const pendingDomDrops = new Set<() => void>();
  let clearNativeHighlights: (() => void) | null = null;

  function handleNativeEnter(rawPaths: string[], _position: { x: number; y: number }, source?: DragData | null, copyModifier?: boolean | null): void {
    if (copyModifier != null) copyModifierHeld = copyModifier;
    const data = source === undefined ? dragState.current ?? dragState.readCrossWindow() : source;
    const livePaths = internalDragPaths(data, isWindows);
    const paths = nativeDropPaths(rawPaths, isWindows);
    nativeGesture = { data: livePaths && sameDropPathSet(paths, livePaths, isWindows) && data
      ? { ...data, paths: [...livePaths] } : null };
    nativeDomSession = nativeGesture.data?.sessionId;
  }

  async function handleNativeDrop(rawPaths: string[], position: { x: number; y: number }, source?: DragData | null, copyModifier?: boolean | null): Promise<void> {
    const target = resolveDropTarget(position);
    const paths = nativeDropPaths(rawPaths, isWindows);
    const dragData = source === undefined ? (nativeGesture ? nativeGesture.data : dragState.current ?? dragState.readCrossWindow()) : source;
    nativeGesture = null;
    const internalPaths = internalDragPaths(dragData, isWindows);
    const isInternalDrag = internalPaths !== null && sameDropPathSet(paths, internalPaths, isWindows);
    if (isInternalDrag) nativeDomSession = dragData?.sessionId;
    const sourcePaths = isInternalDrag ? internalPaths : paths;
    const delivery = dispatchFileDrop(target, sourcePaths, isInternalDrag ? "pane" : "external", isInternalDrag ? dragData : null);
    if (delivery) { await delivery; return; }

    const lease = dragState.claim(isInternalDrag ? dragData : null);
    if (!lease) return;
    const clear = captureHighlightCleanup();
    try {
      if (!sourcePaths.length) return;
      const explorer = deps.getActiveExplorer();
      if (!explorer) return;
      // Miller/Recent retain their former DOM target rules. Linux listings
      // keep the native move-only routing and cross-window refresh policy.
      const domSource = isInternalDrag && dragData?.nativeCopyPolicy === "modifier";
      if (domSource && (!target || (target.type === "background" && target.domDisabled))) return;
      const isCopy = (copyModifier ?? copyModifierHeld) && (!isInternalDrag || dragData?.nativeCopyPolicy !== "move");

      // Terminal drop: type the paths into the shell prompt (#265).
      if (target?.type === "terminal") {
        terminalPanelStore.insertPaths(sourcePaths);
        return;
      }

      // Sidebar bookmark drop
      if (target?.type === "sidebar") {
        // Empty Bookmarks space is a pinning surface for Explorer folders only.
        // Files require a specific bookmark destination, resolved as a folder above.
        if (isInternalDrag && dragData?.kind === "directory") {
          for (const p of sourcePaths) {
            bookmarksStore.addBookmark(p);
          }
        }
        return;
      }

      // Determine source paths (validated internal drag state or external paths)
      const dropOptions = {
        onRefresh: deps.refreshAllPanes,
        broadcastToOtherWindows: isInternalDrag && !domSource,
      };

      // A bookmark row pins directories but receives files through the normal
      // transfer operation. Empty Bookmarks space is handled separately above.
      if (target?.type === "bookmark" && isInternalDrag && dragData?.kind === "directory") {
        for (const path of sourcePaths) bookmarksStore.addBookmark(path);
        return;
      }

      // Drop onto a specific folder, bookmark, or tab.
      if (target?.type === "folder" || target?.type === "bookmark" || target?.type === "tab") {
        // Skip dropping onto self or into one's own descendant; multi-item
        // drops are a single undoable batch (#163).
        const valid = sourcePaths.filter((sourcePath) => !isInsideDir(target.path, sourcePath));
        await handleFileDropMany(valid, target.path, domSource && target.type === "folder" && target.domMoveOnly ? false : isCopy, dropOptions);
        return;
      }

      // Background drop — move/copy to the target pane's directory
      const destDir = (target?.type === "background" ? target.path : undefined) || explorer.currentPath;

      const millerDomBackground = domSource && target?.type === "background" && target.miller;
      const movable = sourcePaths.filter(path => millerDomBackground
        ? !isInsideDir(destDir, path) : !samePath(parentDir(path), destDir));
      await handleFileDropMany(movable, destDir, domSource && !millerDomBackground ? false : isCopy, dropOptions);
    } finally {
      clear();
      lease.finish();
    }
  }

  function handleNativeOver(position: { x: number; y: number }, copyModifier?: boolean | null): void {
    if (copyModifier != null) copyModifierHeld = copyModifier;
    const explorer = deps.getActiveExplorer();
    if (explorer) {
      const dragData = dragState.current ?? dragState.readCrossWindow();
      if (dragData) {
        const target = resolveDropTarget(position);
        if (target?.type === "background") {
          const destDir = target.path || explorer.currentPath;
          const paths = internalDragPaths(dragData, isWindows);
          const sameDirectoryCopy = target.miller && dragData.nativeCopyPolicy === "modifier" && copyModifierHeld;
          if (!sameDirectoryCopy && paths?.every((p) => samePath(parentDir(p), destDir))) {
            clearHighlights();
            clearNativeHighlights = captureHighlightCleanup();
            return;
          }
        }
      }
    }
    highlightTarget(position);
    clearNativeHighlights = captureHighlightCleanup();
  }

  const externalDrop = useExternalDrop({
    onDrop: handleNativeDrop,
    onEnter: handleNativeEnter,
    onOver: handleNativeOver,
    onLeave: () => { nativeGesture = null; clearNativeHighlights?.(); clearNativeHighlights = null; },
  });

  function trackModifierDown(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
  function trackModifierUp(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
  function trackDragModifiers(event: DragEvent): void { copyModifierHeld = isCopyMod(event); }

  function handleDomDragOver(event: DragEvent): void {
    trackDragModifiers(event);
    event.preventDefault();
    const target = resolveDropTargetFromElement(event.target as Element | null);
    if (target?.type === "plugin" || target?.type === "blocked") {
      event.stopImmediatePropagation();
      highlightTargetAtPoint(event.clientX, event.clientY);
    }
  }

  function handleDomDrop(event: DragEvent): void {
    if (!deferredDomSources.has(event)) trackDragModifiers(event);
    event.preventDefault();
    const target = resolveDropTargetFromElement(event.target as Element | null);
    const terminal = target?.type === "plugin" || target?.type === "blocked";
    const fileGesture = event.dataTransfer?.types.some(type => type === "Files" || type.startsWith("application/x-explorer-"));
    const source = deferredDomSources.get(event) ?? dragState.current ?? dragState.readCrossWindow();
    const pending = deferredDomSources.has(event) ? undefined : dragState.pendingNative();
    if (pending && fileGesture) {
      // A Drop can beat the start-command reply. Reserve routing until the
      // handoff is known; snapshot while the DOM drag data store is readable.
      event.stopImmediatePropagation();
      const dataTransfer = new DataTransfer();
      for (const type of event.dataTransfer!.types) dataTransfer.setData(type, event.dataTransfer!.getData(type));
      dataTransfer.effectAllowed = event.dataTransfer!.effectAllowed;
      let targetElement = event.target;
      const replay = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer,
        clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey });
      const owner = domGeneration;
      const release = dragState.retain(source);
      const cancel = () => { targetElement = null; pending.dispose(); release(); };
      pendingDomDrops.add(cancel);
      void pending.result.then(accepted => {
        try {
          if (!accepted && owner === domGeneration) {
            if (source) deferredDomSources.set(replay, source);
            if (source) dragState.bindDomSource(dataTransfer, source);
            targetElement?.dispatchEvent(replay);
          }
        } finally { pendingDomDrops.delete(cancel); release(); }
      });
      return;
    }
    // Acknowledged native handoff owns this gesture. Rejected native starts
    // retain HTML5 authority, including built-in folder/breadcrumb/tab drops.
    const session = event.dataTransfer?.getData("application/x-explorer-session") || undefined;
    if (!domOwnsFileDrop(nativeGesture !== null || dragState.nativeOwns(session)
        || (!!session && session === nativeDomSession))) {
      if (terminal || fileGesture) event.stopImmediatePropagation();
      return;
    }
    if (!terminal) return;
    event.stopImmediatePropagation();
    const data = source;
    const livePaths = internalDragPaths(data, isWindows);
    const payload = event.dataTransfer ? domDropPaths(event.dataTransfer, isWindows) : null;
    const paths = livePaths && payload && sameDropPathSet(payload, livePaths, isWindows) ? livePaths : [];
    void dispatchFileDrop(target, paths, "pane", paths.length ? data : null);
  }

  let domGeneration = 0;
  function setup(): void {
    domGeneration++;
    externalDrop.setup();
    window.addEventListener("keydown", trackModifierDown, true);
    window.addEventListener("keyup", trackModifierUp, true);
    window.addEventListener("dragstart", trackDragModifiers, true);
    window.addEventListener("dragover", handleDomDragOver, { capture: true });
    window.addEventListener("drop", handleDomDrop, { capture: true });
    window.addEventListener("dragend", clearHighlights);
  }

  function cleanup(): void {
    domGeneration++;
    for (const cancel of pendingDomDrops) cancel();
    pendingDomDrops.clear();
    nativeGesture = null;
    nativeDomSession = undefined;
    externalDrop.cleanup();
    window.removeEventListener("keydown", trackModifierDown, true);
    window.removeEventListener("keyup", trackModifierUp, true);
    window.removeEventListener("dragstart", trackDragModifiers, true);
    window.removeEventListener("dragover", handleDomDragOver, { capture: true });
    window.removeEventListener("drop", handleDomDrop, { capture: true });
    window.removeEventListener("dragend", clearHighlights);
    clearHighlights();
  }

  return { setup, cleanup };
}
