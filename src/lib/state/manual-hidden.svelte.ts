/**
 * Manually-hidden entry registry.
 *
 * Per-folder list of names the user has explicitly hidden from view via the
 * file/folder context menu. Independent of dotfile hiding (Show Hidden Files);
 * controlled by a separate setting `showManuallyHidden` that, when on, reveals
 * hidden entries dimmed.
 */

import { loadPersisted, savePersisted, writeConfigQueued } from "./persisted";
import { readConfigFile } from "$lib/api/files";

const STORAGE_KEY = "explorer-manual-hidden";
const CONFIG_FILENAME = "manual-hidden.json";

/** Map from folder path to a set of hidden entry names within that folder. */
type HiddenMap = Record<string, string[]>;

function createManualHiddenStore() {
  let raw = $state<HiddenMap>(loadPersisted(STORAGE_KEY, {}));

  function save(): void {
    savePersisted(STORAGE_KEY, raw);
    writeConfigQueued(CONFIG_FILENAME, JSON.stringify(raw, null, 2));
  }

  async function init(): Promise<void> {
    try {
      const result = await readConfigFile(CONFIG_FILENAME);
      if (result.ok && result.data) {
        const loaded = JSON.parse(result.data) as HiddenMap;
        if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
          raw = loaded;
          savePersisted(STORAGE_KEY, raw);
        }
      }
    } catch {
      // Fall through with localStorage state
    }
  }

  function namesIn(folderPath: string): Set<string> {
    return new Set(raw[folderPath] ?? []);
  }

  function isHidden(folderPath: string, name: string): boolean {
    return (raw[folderPath] ?? []).includes(name);
  }

  function hide(folderPath: string, names: string[]): void {
    if (names.length === 0) return;
    const existing = new Set(raw[folderPath] ?? []);
    for (const n of names) existing.add(n);
    raw = { ...raw, [folderPath]: [...existing].sort() };
    save();
  }

  function unhide(folderPath: string, names: string[]): void {
    const existing = raw[folderPath];
    if (!existing) return;
    const remove = new Set(names);
    const next = existing.filter((n) => !remove.has(n));
    const updated = { ...raw };
    if (next.length === 0) delete updated[folderPath];
    else updated[folderPath] = next;
    raw = updated;
    save();
  }

  return {
    get state() { return raw; },
    init,
    namesIn,
    isHidden,
    hide,
    unhide,
  };
}

export const manualHiddenStore = createManualHiddenStore();
