# 863: In-app Trash location

- A virtual location only needs a built-in `FsProvider` (`registerFsProvider`):
  navigation, tabs, back/forward, sorting, selection and all three views then
  work unchanged. Register it before tab restore can navigate to it
  (`+page.svelte` calls `installTrashLocation()` at script init).
- The startup gzip cap had 18 bytes of headroom. Keep feature code in a
  lazily imported module and pass it startup-graph services (such as the
  context-menu registry) from the eager side: a lazy module that statically
  imports a shared startup module can split that module into a new chunk,
  and every extra dynamic-import call site adds a Vite preload wrapper.
  Contributed menu actions (`contextMenuItems` with `scope: "trash"`) cost
  far less startup code than new markup in `ContextMenu.svelte`.
- Breadcrumb root clicks navigate to `scheme://`, not `scheme:///`, so the
  provider returns the canonical `trash://` as its listing path; refresh and
  `directoryChanged` match the committed path exactly.
- Virtual locations have no watcher. Mutations that change the trash publish
  `trash://` with `broadcastFileChange`; the Trash location subscribes to local
  file changes to refresh this window's views, and other windows refresh
  through the BroadcastChannel listener. Do not import pane state from
  `pane-mutations.ts` to do this (circular import).
- A failed provider listing leaves the pane on its previous path and is not a
  history entry, so "Go back" after a failed Trash open goes further back.
- The exact Linux restore engine recreates missing parent folders (Undo needs
  that). The Trash view pre-checks and refuses an occupied destination or a
  missing original folder so the user is told instead; the engine still
  enforces no-replace atomically.
- Trash listing IDs are opaque hashes of the trash slot; the native registry
  is replaced on each listing. Tests that publish listings share that
  process-wide registry, so keep them in one test or test `plan_restore_in`
  against a local registry.
