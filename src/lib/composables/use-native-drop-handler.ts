/**
 * Composable for handling native (external) file drops.
 *
 * Extracts the drop handling logic from +page.svelte: modifier key tracking,
 * Tauri onDragDropEvent setup, and position-based drop target resolution.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { useExternalDrop } from "$lib/composables/use-external-drop.svelte";
import { resolveDropTarget, resolveDropTargetFromElement, captureDropDestination, highlightTarget, highlightTargetAtPoint, highlightTargetElement, elementAtNativePosition, clearHighlights, captureHighlightCleanup, claimSpringEvent, type DropTargetResult } from "$lib/composables/use-native-drop-target.svelte";
import { dropIntoDirectory } from "$lib/composables/use-dom-directory-drop";
import { retireDropFeedback } from "$lib/composables/use-drop-target.svelte";
import { springEnd, springEndSoon, springGesture, springHold, springHover, springRevision, springSettle } from "$lib/composables/spring-load";
import { dropHover } from "$lib/state/drop-hover";
import { shouldRetireOnDragEnd } from "$lib/domain/drop-feedback";
import { dragState, type DragData } from "$lib/state/drag.svelte";
import { handleFileDropMany } from "$lib/state/drop-operations";
import { isCopyModifier as isCopyMod, isMac, isWindows } from "$lib/domain/platform";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { terminalPanelStore } from "$lib/state/terminal.svelte";
import { pathComparison } from "$lib/domain/path";
import { dispatchFileDrop, admitFileDrop } from "$lib/state/dispatch-file-drop";
import { internalDragPaths, sameDropPathSet, domDropPaths, domOwnsFileDrop, isFileTransfer, nativeDragSession, resolveNativeDragPaths } from "$lib/domain/file-drop";
import { verifyPathsExist } from "$lib/api/files";
import { toastStore } from "$lib/state/toast.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

export interface NativeDropDeps {
  getActiveExplorer: () => ExplorerInstance | undefined;
  refreshAllPanes: () => void;
}
const pathsForPlatform = pathComparison(isWindows);

/** The filesystem folder a captured target names, when it names one. */
function capturedFolderPath(target: DropTargetResult): string | null {
  if (target?.type !== "folder" && target?.type !== "bookmark") return null;
  // Provider locations (trash://) are not filesystem folders.
  return target.path && !target.path.includes("://") ? target.path : null;
}

/** Fail-closed: an unverifiable check counts as gone. */
const folderExists = async (path: string) => {
  const r = await verifyPathsExist([path], "directory");
  return r.ok && r.data;
};

export function useNativeDropHandler(deps: NativeDropDeps) {
  let copyModifierHeld = false;
  let hoverSession: string | undefined;
  // The receiver's report of the current gesture (Enter until Leave or Drop).
  // A Leave can be lost, so a new drag session (a native Enter, a DOM
  // dragstart) clears what an earlier one left behind.
  let hoverPosition: { x: number; y: number } | null = null;
  let receiverReports = false;
  // Drags whose source ended while the native receiver still owes their Drop
  // or Leave (Linux), by session: the drop target each was over, captured while
  // the layout was still its own. Once the temporary peeks changed since (the
  // lost-Leave fallback, a newer drag, a Leave) a position no longer names
  // that target, so the Drop routes to the capture instead (#1269). Any
  // layout change (navigation, refresh, view mode) does the same, so a
  // Drop after dragend always routes to the capture (#1283). A newer
  // drag never clears an older one's capture; the map is bounded.
  const endedDrags = new Map<string, { target: DropTargetResult; revision: number; paths: readonly string[] | null }>();
  const MAX_ENDED_DRAGS = 8;
  const refreshHover = () => { if (hoverPosition) handleNativeOver(hoverPosition); };
  // Receiver-owned snapshot of the live source at native Enter. Source result
  // and destination Drop use different IPC channels and can arrive reordered.
  let nativeGesture: { data: DragData | null; hasPaths: boolean; expired?: boolean } | null = null;
  let nativeDomSession: string | undefined;
  const deferredDomSources = new WeakMap<DragEvent, DragData>();
  /** The spring gesture a replayed drop was dropped in. */
  const replayGestures = new WeakMap<DragEvent, string>();
  const pendingDomDrops = new Set<() => void>();
  let clearNativeHighlights: (() => void) | null = null;

  function nativeSource(rawPaths: readonly string[], source: DragData | null | undefined, observedAt?: number, completedGestureSequence?: number, observationClock?: string): DragData | null {
    const session = nativeDragSession(rawPaths);
    // Recent never starts an OS file drag. GTK identifies its HTML5 gesture
    // with the URI session; retain the same clock/interval/completion fences.
    if (!isMac && !isWindows && session) return dragState.survivingHtml5Source(observedAt, completedGestureSequence, observationClock, session);
    if (source !== null) return source ?? dragState.latestSource();
    // Explicit source:null is external except for WebKitGTK's surviving HTML5
    // gesture. Never infer provenance from an asynchronous consumer's retained
    // source. Admission below still requires the entire native path multiset
    // or the exact session URI of a link-only source.
    return !isMac && !isWindows ? dragState.survivingHtml5Source(observedAt, completedGestureSequence, observationClock) : null;
  }

  function handleNativeEnter(rawPaths: string[], _position: { x: number; y: number }, source?: DragData | null, copyModifier?: boolean | null, observedAt?: number, completedGestureSequence?: number, observationClock?: string, externalSource?: boolean): void {
    if (copyModifier != null) copyModifierHeld = copyModifier;
    hoverPosition = null; receiverReports = true;
    endedDrags.delete(""); // an earlier session-less drag's Drop is not this one's
    springSettle();
    // Native context identity outranks path/time inference from a pending renderer source.
    const data = externalSource ? null : nativeSource(rawPaths, source, observedAt, completedGestureSequence, observationClock);
    const paths = resolveNativeDragPaths(rawPaths, data, isWindows);
    const livePaths = internalDragPaths(data, isWindows);
    const verifiedSource = livePaths && sameDropPathSet(paths, livePaths, isWindows);
    // Explicit Rust provenance is already correlated at the platform callback.
    // Inferred HTML5 identity also needs timestamp admission: an end/start in
    // the same JS millisecond cannot identify which gesture made this event.
    if (!externalSource && dragState.expiredNativeObservation(observedAt, verifiedSource ? data : null, source == null, observationClock)) {
      nativeGesture = { data: null, hasPaths: paths.length > 0, expired: true };
      nativeDomSession = paths.length ? dragState.cancelledNativeSession(observedAt, paths, isWindows, observationClock) : undefined;
      return;
    }
    nativeGesture = { hasPaths: paths.length > 0, data: livePaths && sameDropPathSet(paths, livePaths, isWindows) && data
      ? { ...data, paths: [...livePaths] } : null };
    nativeDomSession = nativeGesture.data?.sessionId;
  }

  async function handleNativeDrop(rawPaths: string[], position: { x: number; y: number }, source?: DragData | null, copyModifier?: boolean | null, observedAt?: number, completedGestureSequence?: number, observationClock?: string, externalSource?: boolean): Promise<void> {
    // Spring peeks close a macrotask later: the target below resolves first.
    springEnd();
    retireDropFeedback();
    dropHover.clear(refreshHover);
    hoverPosition = null; receiverReports = false;
    if (externalSource) nativeDomSession = undefined;
    const dragData = externalSource ? null : nativeDragSession(rawPaths)
      ? nativeSource(rawPaths, source, observedAt, completedGestureSequence, observationClock)
      : source ?? (nativeGesture ? nativeGesture.data : nativeSource(rawPaths, source, observedAt, completedGestureSequence, observationClock));
    const paths = resolveNativeDragPaths(rawPaths, dragData, isWindows);
    // Only this drag's own capture: a Drop never borrows another drag's.
    let endedKey = dragData?.sessionId ?? "";
    let ended = endedDrags.get(endedKey);
    if (!ended && !dragData?.sessionId) {
      // A Drop that lost its source identity: its capture is the one ended
      // drag that carried exactly these paths. Several (or none) means it
      // cannot be told apart: resolve by position, as before.
      const same = [...endedDrags].filter(([, capture]) => capture.paths && sameDropPathSet(paths, capture.paths, isWindows));
      if (same.length === 1) [endedKey, ended] = same[0];
    }
    endedDrags.delete(endedKey);
    if (!paths.length) {
      nativeGesture = null;
      nativeDomSession = undefined;
      clearNativeHighlights?.(); clearNativeHighlights = null;
      return;
    }
    const internalPaths = internalDragPaths(dragData, isWindows);
    const isInternalDrag = internalPaths !== null && sameDropPathSet(paths, internalPaths, isWindows);
    // The final platform Drop can carry verified provenance after an early
    // Enter arrived before native source adoption. Recheck that proof instead
    // of preserving the earlier inference's ambiguity.
    const explicitSource = source != null && isInternalDrag;
    if (!externalSource && ((nativeGesture?.expired && !explicitSource) || dragState.expiredNativeObservation(observedAt, isInternalDrag ? dragData : null,
        source == null && !nativeGesture?.data, observationClock))) {
      nativeDomSession ??= dragState.cancelledNativeSession(observedAt, paths, isWindows, observationClock);
      nativeGesture = null;
      clearHighlights();
      toastStore.show("Drop cancelled because its gesture identity expired. Drop the files again.");
      return;
    }
    // The pointer position of a Drop after dragend names whatever the layout
    // became since: the peeks closing, a navigation, a refresh, a view-mode
    // change. The capture was hit-tested at dragend against the layout the
    // user saw, so it is the only trustworthy destination (#1269, #1283).
    // Route to it, or cancel rather than guess.
    const target = ended ? ended.target : resolveDropTarget(position);
    nativeGesture = null;
    // The captured folder may also have been deleted or renamed since dragend.
    const folder = ended && target ? capturedFolderPath(target) : null;
    if (ended && (!target || (folder !== null && !(await folderExists(folder))))) {
      nativeDomSession = undefined;
      clearHighlights();
      // Settle the source like a completed drop would, so it is not left as the latest one.
      dragState.claim(isInternalDrag ? dragData : null)?.finish();
      toastStore.show("Drop cancelled because its destination could not be confirmed. Drop the files again.");
      return;
    }
    if (isInternalDrag) nativeDomSession = dragData?.sessionId;
    const sourcePaths = isInternalDrag ? internalPaths : paths;
    const delivery = dispatchFileDrop(target, sourcePaths, isInternalDrag ? "pane" : "external", isInternalDrag ? dragData : null);
    if (delivery) { await delivery; return; }

    const lease = admitFileDrop(target, isInternalDrag ? dragData : null);
    if (!lease) return;
    const clear = captureHighlightCleanup();
    try {
      if (!sourcePaths.length) return;
      const explorer = deps.getActiveExplorer();
      if (!explorer) return;
      // Inert hit testing can expose a workspace wrapper rather than the
      // covered content. An implicit destination must still obey pane modality.
      if ((!target || (target.type === "background" && !target.path))
          && dialogStore.isPaneBlocked(windowTabsManager.activePaneId)) return;
      // Miller retains its former DOM target rules. Linux listings
      // keep the native move-only routing and cross-window refresh policy.
      const domSource = isInternalDrag && dragData?.nativeCopyPolicy === "modifier";
      if (domSource && (!target || (target.type === "background" && target.domDisabled))) return;
      const isCopy = (copyModifier ?? copyModifierHeld) && (!isInternalDrag || dragData?.nativeCopyPolicy !== "move");
      // Recent is a shortcut source, not authority to mutate its folder or
      // insert its path into a terminal. Plugin delivery was resolved above.
      if (isInternalDrag && dragData?.nativeCopyPolicy === "link"
          && target?.type !== "sidebar" && target?.type !== "bookmark") return;

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
        if (pathsForPlatform.key(target.path) === null) return;
        const valid = sourcePaths.filter(sourcePath => !pathsForPlatform.contains(target.path, sourcePath)
          && !(isInternalDrag && dragData?.nativeCopyPolicy !== "move" && target.type === "tab"
            && pathsForPlatform.sameParent(sourcePath, target.path)));
        await handleFileDropMany(valid, target.path, domSource && target.type === "folder" && target.domMoveOnly ? false : isCopy, dropOptions);
        return;
      }

      // Background drop — move/copy to the target pane's directory
      const destDir = (target?.type === "background" ? target.path : undefined) || explorer.currentPath;
      if (pathsForPlatform.key(destDir) === null) return;

      const millerDomBackground = domSource && target?.type === "background" && target.miller;
      const movable = sourcePaths.filter(path => millerDomBackground
        ? !pathsForPlatform.contains(destDir, path) : !pathsForPlatform.sameParent(path, destDir));
      await handleFileDropMany(movable, destDir, domSource && !millerDomBackground ? false : isCopy, dropOptions);
    } finally {
      clear();
      lease.finish();
    }
  }

  function handleNativeOver(position: { x: number; y: number }, copyModifier?: boolean | null): void {
    hoverPosition = position;
    springHover(() => elementAtNativePosition(position));
    hoverSession = nativeGesture?.data?.sessionId;
    dropHover.set(refreshHover);
    if (copyModifier != null) copyModifierHeld = copyModifier;
    const explorer = deps.getActiveExplorer();
    if (explorer) {
      const dragData = nativeGesture ? nativeGesture.data : dragState.latestSource();
      if (dragData) {
        const target = resolveDropTarget(position);
        if (target?.type === "background") {
          const destDir = target.path || explorer.currentPath;
          const paths = internalDragPaths(dragData, isWindows);
          const sameDirectoryCopy = target.miller && dragData.nativeCopyPolicy === "modifier" && copyModifierHeld;
          if (!sameDirectoryCopy && paths?.every(p => pathsForPlatform.sameParent(p, destDir))) {
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
    onLeave: () => { springHover(() => null); springSettle(); endedDrags.delete(""); retireDropFeedback(); dropHover.clear(refreshHover); hoverPosition = null; receiverReports = false; nativeGesture = null; clearNativeHighlights?.(); clearNativeHighlights = null; },
  });

  function trackModifierDown(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
  function trackModifierUp(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
  function trackDragModifiers(event: DragEvent): void { copyModifierHeld = isCopyMod(event); }
  function handleDomDragStart(event: DragEvent): void { trackDragModifiers(event); hoverPosition = null; receiverReports = false; springSettle(); }

  // ---- Spring-loaded peeks (#1242) -------------------------------------------
  // A row, row wrapper, peek-state row or bridge inside a drag's temporary
  // peek drops into that peek's folder. No component owns those rows as
  // targets, so the window capture phase accepts them (dragenter too: WebKit
  // delivers a drop only to a target whose dragenter was accepted). Hover
  // events still bubble, claimed, so the card or panel surface under them
  // retires its own folder feedback; only the drop is taken exclusively.
  let clearSpringHighlight: (() => void) | null = null;
  let enteredThisTask = false;
  function acceptSpringTarget(event: DragEvent, target: DropTargetResult): boolean {
    if (target?.type !== "folder" || !target.spring) {
      clearSpringHighlight?.(); clearSpringHighlight = null;
      return false;
    }
    event.preventDefault();
    claimSpringEvent(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = isCopyMod(event) ? "copy" : "move";
    highlightTargetElement(event.target as Element | null);
    clearSpringHighlight = captureHighlightCleanup();
    return true;
  }

  /** The element under a DOM drag event, for the spring hover. While the native
   * receiver reports this drag (Linux), its position is the one authority:
   * the native Drop resolves its target from it, and DOM and native points can
   * disagree by a fraction of a pixel at a row's edge. */
  function domSpringHover(element: Element | null): void {
    if (!hoverPosition) springHover(() => element);
  }

  function handleDomDragEnter(event: DragEvent): void {
    // An inner transition fires dragenter on the new element before dragleave
    // on the old one, in the same task; leaving the window fires no dragenter.
    if (!enteredThisTask) { enteredThisTask = true; setTimeout(() => { enteredThisTask = false; }, 0); }
    if (!dragState.acceptsFileDrag(event.dataTransfer)) return;
    domSpringHover(event.target as Element | null);
    acceptSpringTarget(event, resolveDropTargetFromElement(event.target as Element | null));
  }

  function handleDomDragLeave(event: DragEvent): void {
    if (event.relatedTarget || enteredThisTask) return;
    // The drag left the window (or was cancelled outside every element).
    domSpringHover(null);
    retireDropFeedback();
    clearSpringHighlight?.(); clearSpringHighlight = null;
  }

  function handleDomDragOver(event: DragEvent): void {
    if (!dragState.acceptsFileDrag(event.dataTransfer)) return;
    trackDragModifiers(event);
    event.preventDefault();
    domSpringHover(event.target as Element | null);
    const target = resolveDropTargetFromElement(event.target as Element | null);
    if (target?.type === "plugin" || target?.type === "blocked") {
      event.stopImmediatePropagation();
      highlightTargetAtPoint(event.clientX, event.clientY);
      return;
    }
    acceptSpringTarget(event, target);
  }

  function handleDomDrop(event: DragEvent): void {
    // A replay belongs to the drag that dropped: a newer drag's feedback and
    // springs are not its to end (#1269).
    const replayGesture = replayGestures.get(event);
    // Any drop ends the gesture: no folder keeps drop feedback, including one
    // whose surface unmounted (a closing spring peek) before a leave reached it.
    if (replayGesture === undefined || replayGesture === springGesture()) retireDropFeedback();
    if (!dragState.acceptsFileDrop(event.dataTransfer)) return;
    const bound = event.dataTransfer ? dragState.domSource(event.dataTransfer) : null;
    if (dragState.expiredDomSource(bound, event.dataTransfer)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (!deferredDomSources.has(event)) trackDragModifiers(event);
    event.preventDefault();
    const target = resolveDropTargetFromElement(event.target as Element | null);
    const terminal = target?.type === "plugin" || target?.type === "blocked";
    const source = deferredDomSources.get(event) ?? bound;
    const live = dragState.latestSource();
    // A decision belongs to its captured source session. An old drop cannot
    // borrow a successor's pending handoff and regain validity during replay.
    const pending = deferredDomSources.has(event) || !source || source.sessionId !== live?.sessionId ? undefined : dragState.pendingNative();
    // The replay below must find the row it was dropped on: hold temporary peeks.
    const releaseSpring = pending ? springHold() : null;
    // The replay ends this drag's springs, never a newer drag's (#1269).
    const springGestureAtDrop = springGesture();
    const session = event.dataTransfer?.getData("application/x-explorer-session") || undefined;
    const nativeOwned = !pending && !domOwnsFileDrop(!!nativeGesture?.hasPaths || dragState.nativeOwns(session)
        || (!!session && session === nativeDomSession));
    // A native Drop owns the gesture and ends its spring peeks once it has
    // resolved its own position; a pending drop ends them in its replay (or
    // leaves them to the accepted native Drop); every other drop ends them here.
    if (!nativeOwned && !pending) springEnd(replayGesture);
    if (pending) {
      // A Drop can beat the start-command reply. Reserve routing until the
      // handoff is known; snapshot while the DOM drag data store is readable.
      event.stopImmediatePropagation();
      const dataTransfer = new DataTransfer();
      for (const type of event.dataTransfer!.types) dataTransfer.setData(type, event.dataTransfer!.getData(type));
      dataTransfer.effectAllowed = event.dataTransfer!.effectAllowed;
      let targetElement = event.target;
      const destinationCurrent = captureDropDestination(targetElement as Element | null, deps.getActiveExplorer());
      const clearDeferredHighlights = captureHighlightCleanup();
      const replay = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer,
        clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey });
      replayGestures.set(replay, springGestureAtDrop);
      const owner = domGeneration;
      const release = dragState.retain(source);
      const cancel = () => { targetElement = null; pending.dispose(); release(); releaseSpring?.(); };
      pendingDomDrops.add(cancel);
      void pending.result.then(accepted => {
        try {
          if (!accepted && owner === domGeneration) {
            if (!destinationCurrent()) {
              toastStore.show("Drop cancelled because the destination changed. Drop the files again.");
              clearDeferredHighlights();
              return;
            }
            if (source) deferredDomSources.set(replay, source);
            if (source) dragState.bindDomSource(dataTransfer, source);
            if (target?.type === "folder" && target.spring) {
              // Its row may have unmounted with the peek: drop by its folder.
              springEnd(springGestureAtDrop);
              if (targetElement) void dropIntoDirectory(replay, target.path, "folder", { onRefresh: deps.refreshAllPanes });
            } else targetElement?.dispatchEvent(replay);
          }
        } finally { pendingDomDrops.delete(cancel); release(); releaseSpring?.(); }
      });
      return;
    }
    // Acknowledged native handoff owns this gesture. Rejected native starts
    // retain HTML5 authority, including built-in folder/breadcrumb/tab drops.
    if (nativeOwned) {
      event.stopImmediatePropagation();
      return;
    }
    if (target?.type === "folder" && target.spring) {
      // A row inside a temporary peek: the existing folder drop, same intent.
      event.stopImmediatePropagation();
      clearSpringHighlight?.(); clearSpringHighlight = null;
      void dropIntoDirectory(event, target.path, "folder", { onRefresh: deps.refreshAllPanes });
      return;
    }
    if (!terminal) return;
    event.stopImmediatePropagation();
    // The source window may already have handled its dragend and cleared the
    // live source (#1095). A session recovered from unexpired shared history
    // is then the only proof of identity; admission still claims it once.
    const data = deferredDomSources.has(event) || !live || source?.sessionId === live.sessionId ? source : null;
    const livePaths = internalDragPaths(data, isWindows);
    const payload = event.dataTransfer ? domDropPaths(event.dataTransfer, isWindows) : null;
    // WebKit strips the Explorer MIME payload; admission then rests on the
    // URI session checked by domSource, including captured deferred sources.
    const payloadStripped = !!event.dataTransfer && !isFileTransfer(event.dataTransfer);
    const paths = livePaths && (payloadStripped || (payload && sameDropPathSet(payload, livePaths, isWindows))) ? livePaths : [];
    void dispatchFileDrop(target, paths, "pane", paths.length ? data : null);
  }

  function handleDomDragEnd(event: DragEvent): void {
    const source = event.dataTransfer ? dragState.domSource(event.dataTransfer) : null;
    const endedSession = event.dataTransfer?.getData("application/x-explorer-session") || source?.sessionId;
    const live = dragState.latestSource();
    // Retire feedback only. Native Drop may still need its captured provenance,
    // and a delayed old DOM event cannot retire a successor's hover.
    if (!shouldRetireOnDragEnd({ endedSession: endedSession || undefined, liveSession: live?.sessionId, hoverSession, hovering: !!hoverPosition })) return;
    retireDropFeedback();
    // On Linux a DOM dragend can precede the native Drop, which resolves its
    // target by position: the native Drop or Leave ends spring peeks instead,
    // with a bounded fallback for a Leave that never comes (#1269).
    if (!receiverReports && !hoverPosition) springEnd();
    else {
      const key = endedSession || "";
      endedDrags.delete(key);
      endedDrags.set(key, { target: hoverPosition ? resolveDropTarget(hoverPosition) : null, revision: springRevision(), paths: internalDragPaths(source, isWindows) });
      for (const old of endedDrags.keys()) { if (endedDrags.size <= MAX_ENDED_DRAGS) break; endedDrags.delete(old); }
      springEndSoon();
    }
    dropHover.clear(refreshHover);
    hoverPosition = null;
    clearHighlights();
    clearNativeHighlights = null;
  }

  let domGeneration = 0;
  function setup(): void {
    domGeneration++;
    externalDrop.setup();
    window.addEventListener("keydown", trackModifierDown, true);
    window.addEventListener("keyup", trackModifierUp, true);
    window.addEventListener("dragstart", handleDomDragStart, true);
    window.addEventListener("dragenter", handleDomDragEnter, { capture: true });
    window.addEventListener("dragleave", handleDomDragLeave, { capture: true });
    window.addEventListener("dragover", handleDomDragOver, { capture: true });
    window.addEventListener("drop", handleDomDrop, { capture: true });
    window.addEventListener("dragend", handleDomDragEnd);
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
    window.removeEventListener("dragstart", handleDomDragStart, true);
    window.removeEventListener("dragenter", handleDomDragEnter, { capture: true });
    window.removeEventListener("dragleave", handleDomDragLeave, { capture: true });
    window.removeEventListener("dragover", handleDomDragOver, { capture: true });
    window.removeEventListener("drop", handleDomDrop, { capture: true });
    window.removeEventListener("dragend", handleDomDragEnd);
    dropHover.clear(refreshHover);
    hoverPosition = null; receiverReports = false; endedDrags.clear();
    springEnd();
    clearHighlights();
  }

  return { setup, cleanup };
}
