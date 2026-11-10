# Dragging out of the Trash (#1554)

Trash rows are `trash://<id>` entries. Every drop pipeline validates its
sources with `isNativeDropPath`, so a Trash drag silently produced no paths
and every drop did nothing. Worse, neither source noticed the Trash: the
Linux HTML5 source handed `trash://` strings to a native drag
(`startExternalDrag`) at dragstart and exported them as `file:///trash://…`
URIs, and the macOS/Windows pointer drag did the same on leaving the window.

- Route by source, before path validation: each surface (pointer
  `onMouseUp`, `dropIntoDirectory`, `dropOnQuickAccess`) checks
  `isTrashPath(source.path)` and hands the gesture to `dropTrashEntries`. A
  Trash drop must never reach `handleFileDropMany` or bookmark pinning.
- Keep the routing lazy (`domain/trash-drop.ts` is imported only by
  `state/trash-location.ts`). Routing eagerly cost +758 bytes of startup gzip,
  and importing `native-drop-paths` from the lazy route split that startup
  module into its own chunk; measure with `bun run check:bundle`.
- Trash drags are private sources (`isPrivateDragSource`, like Recent): a
  session URN instead of file URIs, and no native handoff. On Linux the
  native receiver then sees no paths and the DOM drop owns the gesture.
- The renderer still names only opaque IDs (ADR 0019); the destination is an
  ordinary folder. Native `restore_to` retargets the listed artifact and runs
  the same exact engine, so the payload is re-verified before publication.
- The Linux engine restores by one same-filesystem rename and never copies:
  refuse another filesystem up front with an actionable message, as the
  engine would otherwise fail with EXDEV.
- Not undoable, exactly like Restore from the context menu.
