/** Per-pane facade; listing resources and tree policies load on the first peek. */
import { toggleExpanded, collapseSubtree, pruneExpanded, type ExpandedPaths } from "$lib/domain/folder-peek-memory";
import { toastStore } from "./toast.svelte";
import { caretlessDoubleClickNotice } from "$lib/domain/folder-peek-flat";
import type { FileEntry } from "$lib/domain/file";
import type { BandSide } from "$lib/domain/tile-panels";
import type { createFolderPeekSession } from "./folder-peek-session.svelte";

const emptySides: ReadonlyMap<string, BandSide> = new Map();
const noPaths: readonly string[] = [];
export function createFolderPeekState(windows: boolean, initialExpanded: readonly string[] = []) {
  let session = $state.raw<ReturnType<typeof createFolderPeekSession> | null>(null);
  let loading: Promise<void> | undefined;
  let disposed = false;
  const initialPaths = [...new Set(initialExpanded)].slice(-500);
  let remembered = $state.raw<ExpandedPaths>(new Map(initialPaths.map((path, index) => [path, index + 1])));
  let ordinal = initialPaths.length;
  function activate(): Promise<void> {
    if (session || disposed) return Promise.resolve();
    return loading ??= import("./folder-peek-session.svelte").then(({ createFolderPeekSession }) => {
      if (!disposed) session = createFolderPeekSession(windows, [...remembered.keys()]);
    }).finally(() => { loading = undefined; });
  }
  if (initialPaths.length) void activate();
  return {
    get watchFactory() { return session?.watchFactory; },
    get policies() { return session?.policies; },
    get expanded() { return session?.expanded ?? remembered; },
    /** Spring-loaded peeks (#1242); projected with `expanded`, never stored in it. */
    get temporary() { return session?.temporary ?? noPaths; },
    get projected() { return session?.projected ?? remembered; },
    setTemporary(paths: readonly string[]) { session?.setTemporary(paths); },
    activate,
    toggle(path: string) {
      if (disposed) return;
      if (session) session.toggle(path);
      else remembered = toggleExpanded(remembered, path, ++ordinal);
    },
    collapse(path: string) {
      if (disposed) return;
      if (session) session.collapse(path);
      else { const next = new Map(remembered); next.delete(path); remembered = next; }
    },
    collapseAll(roots: readonly string[]) {
      if (disposed) return;
      if (session) session.collapseAll(roots);
      else remembered = collapseSubtree(remembered, roots, windows);
    },
    prune(parent: string, entries: readonly FileEntry[]) {
      if (disposed) return;
      if (session) session.prune(parent, entries);
      else remembered = pruneExpanded(remembered, parent, entries, windows);
    },
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


// Window-scoped advice: repeated gestures, panes and retained-tab remounts
// share the cooldown. Suppressed gestures do not postpone the next reminder.
let lastCaretlessNotice = -Infinity;
export function showCaretlessDoubleClickNotice(openShortcut: string | undefined): void {
  const now = Date.now();
  if (now - lastCaretlessNotice < 60_000) return;
  lastCaretlessNotice = now;
  toastStore.show(caretlessDoubleClickNotice(openShortcut), "info");
}
