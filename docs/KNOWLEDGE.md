# Knowledge Base

Lessons learned during development of the Tauri Explorer app.

## HTML5 Drag and Drop in Svelte 5 + Tauri

**Issue:** tauri-0gre | **Branch:** fix-drag-drop-pin | **Date:** 2026-02-13

### Problem

Dragging files from the file list to the Quick Access sidebar to pin them as bookmarks did not work. The `dragover` event fired correctly (visual feedback appeared), but the `drop` event never fired — not on the target element, not even on a document-level listener.

### Investigation Timeline

1. **Initial hypothesis — `effectAllowed`/`dropEffect` mismatch:** The drag source set `effectAllowed = "move"` but the drop target set `dropEffect = "link"`. Fixed by changing to `effectAllowed = "all"`. This was necessary but not sufficient.

2. **UI tester false positive:** Playwright's `drag` command uses synthetic event dispatch, which bypasses the browser's native DnD state machine. Tests passed but real user interaction still failed. **Lesson: Playwright DnD tests do not validate real browser DnD behavior.**

3. **Tauri `dragDropEnabled` config:** Tauri v2's webview intercepts drag events by default for native OS file drops. Set `dragDropEnabled: false` in `tauri.conf.json` window config to allow HTML5 DnD in the webview. Required, but didn't fix the core issue alone.

4. **Missing `dragenter` handler:** Chrome requires `preventDefault()` on both `dragenter` and `dragover` for a valid drop target. Added `ondragenter` handler. Didn't fix it.

5. **Child element interference:** Bookmark reorder handlers on child elements returned early without calling `preventDefault()` for non-bookmark drags, potentially invalidating the drop zone. Fixed, but still didn't work.

6. **Native `addEventListener` (bubble phase):** Attached listeners directly to the DOM element to bypass Svelte's event system. Still no `drop` event.

7. **Capture-phase document listeners:** Used `addEventListener(..., true)` on the document to intercept events before any child handler. Still no `drop` event.

8. **Plain HTML control test:** A minimal `test-dnd.html` with `<div>` drag source and drop target worked perfectly in the same browser (Chrome on Wayland). Confirmed the issue is specific to the Svelte 5 app, not the browser or platform.

### Root Cause (Best Understanding)

Svelte 5 uses **event delegation** — instead of attaching event handlers directly to elements, it attaches a single handler to the document root. The browser's DnD state machine evaluates whether `preventDefault()` was called during the normal event dispatch on the actual element. Svelte's delegated handlers run at the document level, which appears to be too late for the browser to recognize the element as a valid drop target.

Key evidence:
- `dragover` events fire and Svelte handlers execute (visual state updates work)
- But `preventDefault()` called from Svelte's delegated position doesn't register with the DnD state machine
- Even native `addEventListener` on the element didn't work, possibly because Svelte's delegated handlers interfere with event propagation
- Plain HTML with direct listeners works fine

**This may be a Svelte 5 bug** worth reporting upstream.

### Working Solution

Bypass the `drop` event entirely using a **dragend detection pattern**:

1. **Shared drag state** (`src/lib/state/drag.svelte.ts`): A module-level store that holds the dragged item's `path`, `name`, and `kind`. Set on `dragstart`, cleared on `dragend`.

2. **Native `dragover` listeners** on the Quick Access element (via `addEventListener` in `onMount`): Provide visual feedback by setting `isDragOver = true`.

3. **Document-level `dragend` listener**: When any drag ends, check if `isDragOver` is true and `dragState` has data. If so, treat it as a successful drop and add the bookmark.

```
FileItem dragstart → dragState.start({path, name, kind})
                   → native dragover on Quick Access → isDragOver = true
                   → user releases mouse
                   → dragend fires → isDragOver && dragState.current → addBookmark()
```

### Known Limitations

- **No true drop/cancel distinction:** If the browser fails to fire `dragleave` on Escape in some edge case, a false positive bookmark could be added. In practice, Escape triggers `dragleave` which clears `isDragOver`.
- **All in-app DnD is affected:** Any feature using Svelte 5's `ondrop` handler will have the same problem (e.g., file-to-directory drops, bookmark reordering). Each needs the dragend pattern or a shared drag state approach.
- **Playwright tests don't catch this:** Automated DnD tests pass because they use synthetic events. Manual testing is required for DnD validation.

### Key Files

| File | Role |
|------|------|
| `src/lib/state/drag.svelte.ts` | Shared drag state store |
| `src/lib/components/FileItem.svelte` | Drag source — sets `dragState` on `dragstart` |
| `src/lib/components/Sidebar.svelte` | Drop target — native listeners + `dragend` detection |
| `src-tauri/tauri.conf.json` | `dragDropEnabled: false` for Tauri webview |

### Takeaways

1. **Svelte 5 event delegation breaks HTML5 DnD** in complex component trees. Use native `addEventListener` for drag-and-drop, and avoid relying on the `drop` event.
2. **Playwright DnD !== real DnD.** Synthetic events bypass browser validation. Always manually test drag-and-drop.
3. **Tauri requires `dragDropEnabled: false`** for any in-webview HTML5 DnD to work.
4. **Shared state > `dataTransfer`** for in-app DnD. `dataTransfer.getData()` is unreliable across webviews and has security restrictions. A simple module-level store is more reliable.
5. **The dragend pattern** (check hover state when drag ends) is a robust workaround when `drop` events are unreliable.
