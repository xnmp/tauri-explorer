/**
 * Per-folder view overrides.
 * Issue: tauri-explorer-8762
 *
 * Stores per-folder view preferences (e.g. thumbnail size) that override
 * the global defaults from settings. Persisted to folder-views.json config
 * file with localStorage as synchronous fallback.
 */

import {
  configWriteActivity,
  configWriteRaced,
  lastWrittenConfig,
  loadPersisted,
  savePersisted,
  writeConfigQueued,
} from "./persisted";
import { readConfigFile } from "$lib/api/config";
import { decideConfigReload, type ConfigReloadReason } from "$lib/domain/config-reload";
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
  let views = $state<FolderViewMap>(loadPersisted<FolderViewMap>(STORAGE_KEY, {}));

  function save(): void {
    savePersisted(STORAGE_KEY, views);
    writeConfigQueued(CONFIG_FILENAME, JSON.stringify(views, null, 2));
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
      writeConfigQueued(CONFIG_FILENAME, JSON.stringify(saved, null, 2));
    }
  }

  /** Re-read external folder-view edits without replaying this store's writes. */
  async function reloadFromDisk(): Promise<ConfigReloadReason> {
    const beforeRead = configWriteActivity(CONFIG_FILENAME, CONFIG_WRITER);
    const result = await readConfigFile(CONFIG_FILENAME);
    if (!result.ok) return "unusable";
    let loaded: FolderViewMap | null = null;
    try {
      const parsed = JSON.parse(result.data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        loaded = parsed as FolderViewMap;
      }
    } catch {
      // `decideConfigReload` reports invalid external files consistently.
    }
    const decision = decideConfigReload({
      raw: result.data,
      normalized: loaded ? JSON.stringify(loaded) : null,
      currentNormalized: JSON.stringify(views),
      lastWritten: lastWrittenConfig(CONFIG_FILENAME, CONFIG_WRITER),
      selfWriteRaced: configWriteRaced(CONFIG_FILENAME, beforeRead, CONFIG_WRITER),
    });
    if (!decision.apply || !loaded) return decision.reason;
    views = loaded;
    savePersisted(STORAGE_KEY, views);
    return decision.reason;
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
    reloadFromDisk,
    get,
    set,
    remove,
    getThumbnailSize,
  };
}

export const folderViewsStore = createFolderViewsStore();
