/** Per-pane facade; listing resources and tree policies load on the first peek. */
import type { FileEntry } from "$lib/domain/file";
import type { BandSide } from "$lib/domain/tile-panels";
import type { createFolderPeekSession } from "./folder-peek-session.svelte";

const emptyExpanded: ReadonlyMap<string, number> = new Map();
const emptySides: ReadonlyMap<string, BandSide> = new Map();
const noPaths: readonly string[] = [];
export function createFolderPeekState(windows: boolean) {
  let session = $state.raw<ReturnType<typeof createFolderPeekSession> | null>(null);
  let loading: Promise<void> | undefined;
  let disposed = false;
  return {
    get watchFactory() { return session?.watchFactory; },
    get policies() { return session?.policies; },
    get expanded() { return session?.expanded ?? emptyExpanded; },
    /** Spring-loaded peeks (#1242); projected with `expanded`, never stored in it. */
    get temporary() { return session?.temporary ?? noPaths; },
    get projected() { return session?.projected ?? emptyExpanded; },
    setTemporary(paths: readonly string[]) { session?.setTemporary(paths); },
    activate(): Promise<void> {
      if (session || disposed) return Promise.resolve();
      return loading ??= import("./folder-peek-session.svelte").then(({ createFolderPeekSession }) => {
        if (!disposed) session = createFolderPeekSession(windows);
      }).finally(() => { loading = undefined; });
    },
    toggle(path: string) { session?.toggle(path); },
    collapse(path: string) { session?.collapse(path); },
    collapseAll(roots: readonly string[]) { session?.collapseAll(roots); },
    prune(parent: string, entries: readonly FileEntry[]) { session?.prune(parent, entries); },
    listing(path: string) { return session?.listing(path); },
    cardRows(path: string) { return session?.cardRows(path); },
    setCardRows(path: string, rows: number) { session?.setCardRows(path, rows); },
    panelHeight(path: string) { return session?.panelHeight(path); },
    setPanelHeight(path: string, height: number) { session?.setPanelHeight(path, height); },
    get panelSides() { return session?.panelSides ?? emptySides; },
    rememberPanelSides(placed: ReadonlyMap<string, BandSide>) { session?.rememberPanelSides(placed); },
    target(path: string) { return session?.target(path); },
    reconcile(paths: readonly string[], git = false) { session?.reconcile(paths, git); },
    async dispose() {
      disposed = true;
      await loading;
      await session?.dispose();
    },
  };
}
