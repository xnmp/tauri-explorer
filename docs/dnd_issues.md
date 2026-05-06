# Drag and Drop Issues on macOS (Tauri v2 + WKWebView)

This document catalogs all DnD issues encountered and their resolutions.

## Fundamental Constraint

`@crabnebula/tauri-plugin-drag`'s `startDrag()` creates a native `NSDraggingSession` that **kills all HTML5 DnD events** for the duration of the drag. HTML5 DnD alone cannot reach external apps (Finder, VSCode, etc.). These are mutually exclusive during a single gesture.

**Solution architecture:** Use mouse events for same-window internal drag, trigger native drag only when cursor exits the window.

---

## Issue 1: setPointerCapture Unreliable at Viewport Boundaries

**Symptom:** Drag exit to external apps only works intermittently — cursor doesn't always change to indicate native drag started. Console logs only appear when the cursor does change.

**Root cause:** `setPointerCapture` in WKWebView does NOT reliably deliver `pointermove` events when the pointer is at or beyond viewport boundaries. Events are swallowed silently, so exit detection fails.

**Fix:** Switched from `pointermove`/`pointerup` with `setPointerCapture` to `mousemove`/`mouseup` listeners on `window` with capture phase (`true`). Implicit mouse capture (button held) reliably delivers mouse events with accurate coordinates — including negative values and values beyond `innerWidth`/`innerHeight` — even after the cursor leaves the viewport.

**File:** `src/lib/composables/use-pointer-drag.svelte.ts`

---

## Issue 2: Ghost Label Positioned Incorrectly with CSS Zoom

**Symptom:** The drag ghost element appears offset from the cursor, sometimes far away.

**Root cause:** The app uses `document.documentElement.style.zoom` for UI scaling. CSS zoom affects the coordinate space of `position: fixed` elements — a fixed element at `left: 100px` renders at `100 * zoom` physical pixels from the viewport edge. But `clientX/Y` from mouse events are in CSS viewport pixels (unaffected by zoom).

**Fix:** Divide ghost coordinates by the zoom factor:
```typescript
const zoom = settingsStore.zoomLevel / 100;
ghostEl.style.left = `${(event.clientX + 12) / zoom}px`;
ghostEl.style.top = `${(event.clientY + 12) / zoom}px`;
```

**File:** `src/lib/composables/use-pointer-drag.svelte.ts`

---

## Issue 3: App Crash on Cross-Pane Drop

**Symptom:** Dragging a file to a folder in another pane sometimes crashes the app and restarts it.

**Root cause:** Race condition from firing multiple async `handleFileDrop` operations without awaiting sequentially. Multiple simultaneous file-system mutations on the same paths caused panics in the Rust backend.

**Fix:** Await each `handleFileDrop` call sequentially in a loop. Call `cleanup(true)` before entering the async loop to prevent further event handling during the operation.

**File:** `src/lib/composables/use-pointer-drag.svelte.ts` (`onMouseUp`)

---

## Issue 4: Cross-Window Drag Fails with Stale dragState

**Symptom:** Cross-window drag "works once then stops." First drop after a failed attempt uses wrong source path (e.g., path from a previous drag).

**Root cause:** `dragState` (localStorage-based, shared across windows) was never cleared after native drops. The target window then reads stale `dragState.current` paths on the next drop event.

**Fix:** 
1. Added `dragState.clear()` to ALL exit paths in `handleNativeDrop` (`+page.svelte`).
2. Added validation: check `internalPaths.includes(droppedPaths[0])` before treating a native drop as an internal cross-window drag. If validation fails, treat as external (Finder) drop.

**Files:** `src/routes/+page.svelte`, `src/lib/composables/use-drop-target.svelte.ts`

---

## Issue 5: onDragDropEvent Does Not Fire for Child Windows

**Symptom:** Dragging files between windows works when the destination is the main "tauri-explorer" window but fails silently when dropping on a child "Tauri App" window.

**Root cause:** `getCurrentWebview().onDragDropEvent()` internally calls `this.listen(TauriEvent.DRAG_DROP, ...)` scoped to the specific webview label. For child windows created via the JS `WebviewWindow` API, the Tauri event system apparently does not route drag-drop events to the label-scoped listener.

**Attempted workarounds:**
- Setting `dragDropEnabled: false` on child windows — lets HTML5 DnD work for internal cross-window (via dragState), but breaks Finder drops (see Issue 6).
- Using global `listen("tauri://drag-drop", handler)` from `@tauri-apps/api/event` — bypasses webview-label scoping. **Planned fix, not yet implemented.**

**Status:** Open. Need to use global `listen` for drag-drop events instead of webview-scoped `onDragDropEvent`.

**File:** `src/lib/composables/use-external-drop.svelte.ts`, `src/lib/state/command-definitions.ts`

---

## Issue 6: Finder Drops Broken When dragDropEnabled: false

**Symptom:** After setting child windows to `dragDropEnabled: false`, dragging files FROM Finder INTO the app no longer works on those windows.

**Root cause:** With `dragDropEnabled: false`, Tauri doesn't intercept native drops, so they fall through as HTML5 DnD events. However, WKWebView's HTML5 DnD does not expose full file paths from native OS drops — `dataTransfer.files` contains File objects but `webkitGetAsEntry()` paths are sandboxed/virtualized. The app needs the real filesystem path, which only `onDragDropEvent` provides.

**Fix:** Must keep `dragDropEnabled: true` on all windows and use global `listen` (see Issue 5) to receive events reliably.

**File:** `src/lib/state/command-definitions.ts`

---

## Issue 7: Finder Drops Copy Instead of Move

**Symptom:** Dragging files from Finder into the app copies them instead of moving.

**Root cause:** macOS Finder defaults to "copy" when dragging between applications. This is standard OS behavior — inter-app drag defaults to copy unless the source app explicitly sets `NSDragOperationMove`.

**Status:** Accepted behavior. Copy-on-drop from Finder is the macOS convention. Users expect this.

---

## Issue 8: Two Coordinate Spaces for elementFromPoint

**Symptom:** Drop target highlighting and resolution work for pointer-based drags but not for native `onDragDropEvent` drops (targets always resolve to wrong element).

**Root cause:** Two different coordinate systems feed into `elementFromPoint`:
- `onDragDropEvent` provides positions in **physical pixels** → must divide by DPR AND zoom
- `MouseEvent.clientX/Y` provides **CSS viewport pixels** → must divide by zoom only

**Fix:** Two adjustment functions in `use-native-drop-target.svelte.ts`:
```typescript
// For onDragDropEvent (Tauri native events)
function adjustForZoom(pos) { return { x: pos.x / dpr / zoom, y: pos.y / dpr / zoom }; }

// For mouse/pointer events
function adjustForPointerZoom(pos) { return { x: pos.x / zoom, y: pos.y / zoom }; }
```

**File:** `src/lib/composables/use-native-drop-target.svelte.ts`

---

## Issue 9: Background Drop Target Missing Path Context

**Symptom:** Cross-pane drag dropping onto the background of the other pane does nothing (no move/copy).

**Root cause:** `resolveDropTargetAtPoint` returned `{ type: "background" }` without a `path` property. The drop handler then used `explorer.currentPath` which pointed to the SOURCE pane, not the target.

**Fix:** Added `data-current-path={explorer.currentPath}` attribute to the `.content` div in `FileList.svelte`. The target resolver now reads this attribute: `{ type: "background", path: contentEl.dataset.currentPath }`.

**Files:** `src/lib/components/FileList.svelte`, `src/lib/composables/use-native-drop-target.svelte.ts`

---

## Issue 10: Marquee Selection Conflicts with Drag

**Symptom:** Attempting to drag a file starts marquee selection instead.

**Root cause:** `FileList.svelte` listens for `mousedown` on the `.content` container to initiate marquee selection. File items are inside this container, so mousedown on items bubbles up.

**Fix:** On Mac, add `onmousedown={(e) => e.stopPropagation()}` to file item buttons. This prevents marquee initiation while preserving click (separate `onclick` event) and pointer-drag (separate `onpointerdown` event).

**Files:** `FileItem.svelte`, `ListView.svelte`, `TilesView.svelte`

---

## Summary of Current State

| Scenario | Status |
|----------|--------|
| Same-pane drag onto folder | Working |
| Cross-pane drag | Working |
| Drag out to Finder/VSCode/Chrome | Working (when exit detected) |
| Exit detection reliability | Fixed (mousemove approach) — needs testing |
| Cross-window drag (main → child) | Partially working (HTML5 DnD + dragState) |
| Finder drops on main window | Needs fix (global listen) |
| Finder drops on child windows | Needs fix (global listen + dragDropEnabled: true) |
| Escape cancels drag | Working |
| Option+drop = copy | Working |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    pointerdown on item                    │
│                           │                              │
│                    ┌──────┴──────┐                       │
│                    │ < 5px move? │                       │
│                    └──────┬──────┘                       │
│               no drag──┘     └──threshold met            │
│               (click)              │                     │
│                         ┌──────────┴──────────┐         │
│                         │ dragState.start()    │         │
│                         │ create ghost         │         │
│                         └──────────┬──────────┘         │
│                                    │                     │
│                    ┌───────────────┼───────────────┐     │
│                    │ mousemove     │               │     │
│                    │               │               │     │
│            ┌───────┴───────┐ ┌────┴────┐  ┌──────┴──┐  │
│            │ inside window │ │ mouseup  │  │ exit    │  │
│            │ highlight     │ │ drop     │  │ window  │  │
│            │ target        │ │ on target│  │ bounds  │  │
│            └───────────────┘ └─────────┘  └────┬────┘  │
│                                                 │       │
│                                     startExternalDrag() │
│                                     (native session)    │
└─────────────────────────────────────────────────────────┘
```
