/**
 * Startup-light access to the open history (#1525). The store, its policy and
 * IPC load on first use — a launch, an in-app mutation, or a Date opened
 * read — so windows that never show the column keep them out of the startup
 * bundle. Changes queue on one import promise, so they apply in call order.
 */
import { onFileLaunched } from "$lib/api/open";

type Store = typeof import("./open-history.svelte").openHistoryStore;

let store = $state.raw<Store | null>(null);
let loading: Promise<Store> | null = null;

export function openHistory(): Promise<Store> {
  loading ??= import("./open-history.svelte").then((module) => (store = module.openHistoryStore));
  return loading;
}

/** When `path` was last opened (epoch ms); reactive, undefined until loaded. */
export function lastOpenedAt(path: string): number | undefined {
  if (store) return store.lastOpened(path);
  void openHistory();
  return undefined;
}

/** An in-app rename/move: the item keeps its Date opened. */
export function moveOpenHistory(from: string, to: string): void {
  void openHistory().then((history) => history.move(from, to));
}

/** Deleted or trashed paths leave the history. */
export function forgetOpenHistory(paths: readonly string[]): void {
  if (paths.length) void openHistory().then((history) => history.forget(paths));
}

onFileLaunched((path) => {
  const at = Date.now();
  void openHistory().then((history) => history.record(path, at));
});
