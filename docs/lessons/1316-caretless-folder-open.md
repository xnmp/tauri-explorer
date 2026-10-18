# #1316 — Mouse navigation with peek carets hidden

Caretless Folder Peek assigns folder row clicks to expansion and blocks double-click navigation. Enter and the context menu still worked, but neither supplied an obvious mouse action for entering the hovered folder.

Details and List now share a small Open button, visible on row hover or focus. It navigates the button's own pane and full folder path, including nested peek rows. The existing row-control admission checks keep this action out of row selection, peek toggling and drag acquisition. Rename inputs suppress it, and the existing Enter command remains the keyboard equivalent within the roving row focus model.

The behavioral regression failed on both views before the fix because no Open action existed. It verifies hover/focus disclosure, nested-folder navigation without expansion, file/settings exclusions and rename ownership.
