/**
 * Per-folder view overrides.
 * Issue: tauri-explorer-8762
 *
 * Stores per-folder view preferences (e.g. thumbnail size) that override
 * the global defaults from settings. Persisted to folder-views.json config
 * file with localStorage as synchronous fallback.
 */

import { loadPersisted, savePersisted } from "./persisted";
import { readConfigFile, writeConfigFile } from "$lib/api/files";
import type { ThumbnailSize } from "./settings.svelte";

/** View properties that can be overridden per folder */
export interface FolderViewOverride {
  thumbnailSize?: ThumbnailSize;
}

type FolderViewMap = Record<string, FolderViewOverride>;

const STORAGE_KEY = "explorer-folder-views";
const CONFIG_FILENAME = "folder-views.json";

function createFolderViewsStore() {
  let views = $state<FolderViewMap>(loadPersisted<FolderViewMap>(STORAGE_KEY, {}));

  function save(): void {
    savePersisted(STORAGE_KEY, views);
    writeConfigFile(CONFIG_FILENAME, JSON.stringify(views, null, 2)).catch((err) => {
      console.warn("Failed to save folder views:", err);
    });
  }

  async function init(): Promise<void> {
    try {
      const result = await readConfigFile(CONFIG_FILENAME);
      if (result.ok && result.data) {
        const loaded = JSON.parse(result.data) as FolderViewMap;
        if (loaded && typeof loaded === "object") {
          views = loaded;
          savePersisted(STORAGE_KEY, views);
          return;
        }
      }
    } catch {
      // Config file doesn't exist or is invalid
    }

    // Migrate from localStorage if config file was empty
    const saved = loadPersisted<FolderViewMap>(STORAGE_KEY, {});
    if (Object.keys(saved).length > 0) {
      writeConfigFile(CONFIG_FILENAME, JSON.stringify(saved, null, 2)).catch(() => {});
    }
  }

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
  function getThumbnailSize(path: string, globalDefault: ThumbnailSize): ThumbnailSize {
    return views[path]?.thumbnailSize ?? globalDefault;
  }

  return {
    init,
    get,
    set,
    remove,
    getThumbnailSize,
  };
}

export const folderViewsStore = createFolderViewsStore();
