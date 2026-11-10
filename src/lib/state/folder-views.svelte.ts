/**
 * Per-folder view overrides.
 * Issue: tauri-explorer-8762
 *
 * Stores per-folder view preferences (e.g. thumbnail size) that override
 * the global defaults from settings. Persisted to folder-views.json config
 * file with localStorage as synchronous fallback.
 */

import type { ConfigReloadReason } from "$lib/domain/config-reload";
import { createConfigDocument } from "./config-document";
import { loadPersisted } from "./persisted";
import type { ThumbnailSize } from "./settings.svelte";

/** View properties that can be overridden per folder */
export interface FolderViewOverride {
  thumbnailSize?: ThumbnailSize;
}

type FolderViewMap = Record<string, FolderViewOverride>;

const STORAGE_KEY = "explorer-folder-views";
const CONFIG_FILENAME = "folder-views.json";
const CONFIG_WRITER = "folder-views-store";

function createFolderViewsStore() {
  let views = $state<FolderViewMap>(
    loadPersisted<FolderViewMap>(STORAGE_KEY, {}),
  );

  const configDoc = createConfigDocument<FolderViewMap>({
    file: CONFIG_FILENAME,
    key: STORAGE_KEY,
    writer: CONFIG_WRITER,
    get: () => views,
    set: (next) => (views = next),
    // First load keeps the historical looser gate (arrays and `{}` are
    // adopted); reload is strict (plain objects only).
    acceptOnInit: (parsed): parsed is FolderViewMap =>
      !!parsed && typeof parsed === "object",
    acceptOnReload: (parsed): parsed is FolderViewMap =>
      !!parsed && typeof parsed === "object" && !Array.isArray(parsed),
    // Re-reads the cache at init time rather than trusting the live value.
    migration: () => {
      const saved = loadPersisted<FolderViewMap>(STORAGE_KEY, {});
      return Object.keys(saved).length > 0 ? saved : null;
    },
  });

  const save = configDoc.save;
  const init = configDoc.init;

  /** Re-read external folder-view edits without replaying this store's writes. */
  const reloadFromDisk: () => Promise<ConfigReloadReason> = configDoc.reload;

  /** Get the override for a folder, or undefined if none set */
  function get(path: string): FolderViewOverride | undefined {
    return views[path];
  }

  /** Set a view override for a folder (merges with existing) */
  function set(path: string, override: Partial<FolderViewOverride>): void {
    const existing = views[path] ?? {};
    views = { ...views, [path]: { ...existing, ...override } };
    save();
  }

  /** Remove all overrides for a folder */
  function remove(path: string): void {
    if (!(path in views)) return;
    const { [path]: _, ...rest } = views;
    views = rest;
    save();
  }

  /** Get the effective thumbnail size for a folder (override ?? global default) */
  function getThumbnailSize(
    path: string,
    globalDefault: ThumbnailSize,
  ): ThumbnailSize {
    return views[path]?.thumbnailSize ?? globalDefault;
  }

  return {
    init,
    reloadFromDisk,
    get,
    set,
    remove,
    getThumbnailSize,
  };
}

export const folderViewsStore = createFolderViewsStore();
