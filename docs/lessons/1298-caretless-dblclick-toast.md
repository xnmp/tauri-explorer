# #1298 — caret-less Folder Peek refuses folder double-click

With carets off (Details/List), a plain click on a folder toggles its peek.
A double-click is two of those toggles. It used to navigate as well, so the
peek flickered open and shut before the pane left the directory. A folder
double-click now shows an info toast naming the Open command's key instead.

- One predicate, `rowClickOwnsPeek` in `domain/folder-peek-flat.ts`, decides
  both the click toggle (`shouldToggleOnRowClick` composes it) and the refused
  double-click. Explorer builds its input once (`rowPeekTarget`), so the two
  cannot drift.
- The predicate ignores modifiers and drag ends. Those only stop a click from
  toggling; navigation stays refused for the folder either way.
- Tiles (carets always shown), Folder Peek off, and virtual/provider locations
  still navigate on double-click, because a click there never toggles a peek.
- The toast reads the key from `getCommandShortcut("file.openSelected")`. If
  Open is unbound, it points to the context menu instead. Static settings copy
  must not hardcode "Enter".
- The startup gzip budget was 13 bytes above dev. This guard is eager
  (FileList's double-click handler), so the cap was raised with a recorded
  rationale in `scripts/check-bundle-size.mjs`. Measure `bun run check:bundle`
  before any FileList change: dev sits close to the cap.
