/**
 * A JSON config file mirrored into a localStorage cache: first-load with
 * migration, external-edit reload, and write-through.
 *
 * bookmarks.json and folder-views.json share this lifecycle. The document owns
 * no value; the store keeps its rune state and hands accessors in, so reactivity
 * stays in the store. Everything that legitimately differs between files
 * (what shape is acceptable on first load vs. on reload, what counts as data
 * worth migrating, where the migrated value comes from) is an explicit option.
 */

import {
  configWriteActivity,
  configWriteRaced,
  lastWrittenConfig,
  savePersisted,
  writeConfigQueued,
} from "./persisted";
import { readConfigFile } from "$lib/api/config";
import {
  decideConfigReload,
  type ConfigReloadReason,
} from "$lib/domain/config-reload";

export interface ConfigDocumentOptions<T> {
  /** Config-dir-relative filename, e.g. `bookmarks.json`. */
  file: string;
  /** localStorage cache key. */
  key: string;
  /** Write-activity identity; must match what the file's echo checks use. */
  writer: string;
  /** The store's live value, and how to replace it. */
  get: () => T;
  set: (value: T) => void;
  /**
   * First-load shape gate on the parsed file. Returning false makes `init`
   * fall through to localStorage migration (e.g. an empty list is rejected so
   * a cache can migrate over it).
   */
  acceptOnInit: (parsed: unknown) => parsed is T;
  /** Reload shape gate on the parsed file. Anything rejected is "unusable". */
  acceptOnReload: (parsed: unknown) => parsed is T;
  /**
   * The value to write to an empty/unusable config file on first load, or null
   * when there is nothing worth migrating. Each file decides whether that is
   * the live value or a fresh read of the localStorage cache.
   */
  migration: () => T | null;
}

export interface ConfigDocument {
  /** Write-through: localStorage immediately, config file via the queued writer. */
  save: () => void;
  /** Adopt the config file, else migrate the cache into it. */
  init: () => Promise<void>;
  /** Adopt an external edit unless it is our own write coming back. */
  reload: () => Promise<ConfigReloadReason>;
}

const serialize = (value: unknown): string => JSON.stringify(value, null, 2);

export function createConfigDocument<T>(
  o: ConfigDocumentOptions<T>,
): ConfigDocument {
  const { file, key, writer } = o;

  return {
    save() {
      const value = o.get();
      savePersisted(key, value);
      writeConfigQueued(file, serialize(value), writer);
    },

    async init() {
      try {
        const result = await readConfigFile(file);
        if (result.ok && result.data) {
          const parsed: unknown = JSON.parse(result.data);
          if (o.acceptOnInit(parsed)) {
            o.set(parsed);
            savePersisted(key, parsed);
            return;
          }
        }
      } catch {
        // Config file doesn't exist or is invalid - fall through
      }

      const source = o.migration();
      if (source !== null) writeConfigQueued(file, serialize(source), writer);
    },

    async reload() {
      // Sampled before the read so a write that starts and finishes inside the
      // read window is still detected.
      const beforeRead = configWriteActivity(file, writer);
      const result = await readConfigFile(file);
      if (!result.ok) return "unusable";
      let loaded: T | null = null;
      try {
        const parsed: unknown = JSON.parse(result.data);
        if (o.acceptOnReload(parsed)) loaded = parsed;
      } catch {
        // `decideConfigReload` reports invalid external files consistently.
      }
      const decision = decideConfigReload({
        raw: result.data,
        normalized: loaded ? JSON.stringify(loaded) : null,
        currentNormalized: JSON.stringify(o.get()),
        lastWritten: lastWrittenConfig(file, writer),
        selfWriteRaced: configWriteRaced(file, beforeRead, writer),
      });
      if (!decision.apply || !loaded) return decision.reason;
      o.set(loaded);
      savePersisted(key, loaded);
      return decision.reason;
    },
  };
}
