/** Per-pane facade; listing resources and tree policies load on the first peek. */
import type { FileEntry } from "$lib/domain/file";
import type { createFolderPeekSession } from "./folder-peek-session.svelte";

const emptyExpanded: ReadonlyMap<string, number> = new Map();
export function createFolderPeekState(windows: boolean) {
  let session = $state.raw<ReturnType<typeof createFolderPeekSession> | null>(null);
  let loading: Promise<void> | undefined;
  let disposed = false;
  return {
    get watchFactory() { return session?.watchFactory; },
    get policies() { return session?.policies; },
    get expanded() { return session?.expanded ?? emptyExpanded; },
    activate(): Promise<void> {
      if (session || disposed) return Promise.resolve();
      return loading ??= import("./folder-peek-session.svelte").then(({ createFolderPeekSession }) => {
        if (!disposed) session = createFolderPeekSession(windows);
      }).finally(() => { loading = undefined; });
    },
    toggle(path: string) { session?.toggle(path); },
    collapse(path: string) { session?.collapse(path); },
    collapseAll(root: string) { session?.collapseAll(root); },
    prune(parent: string, entries: readonly FileEntry[]) { session?.prune(parent, entries); },
    listing(path: string) { return session?.listing(path); },
    target(path: string) { return session?.target(path); },
    reconcile(paths: readonly string[]) { session?.reconcile(paths); },
    async dispose() {
      disposed = true;
      await loading;
      await session?.dispose();
    },
  };
}
