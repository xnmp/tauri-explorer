/**
 * Plugin-contributed entry lineage (capability `entryLineage`, lineage peek
 * §4.2): "file X was made from files P, Q" for a folder. The host owns the
 * grouping (`domain/entry-lineage.ts`); a contribution only answers which
 * folders have lineage and loads the parent relation.
 */
import type { EntryLineage } from "$lib/domain/entry-lineage";
import { isFileViewId } from "$lib/domain/file-view-id";
import { createOrderedRegistry } from "$lib/state/ordered-registry";

export type { EntryLineage, LineageParent } from "$lib/domain/entry-lineage";

export interface EntryLineageContribution {
  /** `<pluginId>.<name>`, validated like registerFileView ids. */
  id: string;
  /** Pane option label in the context-menu View section: "Traces" → "Show traces". */
  title: string;
  /** Whether this directory has lineage; "pending" holds first paint (at most 400 ms). */
  available(directory: string): boolean | "pending";
  /** Lineage for the directory's files. Reject or abort on signal. */
  load(directory: string, signal: AbortSignal): Promise<EntryLineage>;
  /** Call `changed` whenever load() would now return a different revision. Returns an unsubscribe. */
  subscribe?(directory: string, changed: () => void): () => void;
}

export interface RegisteredEntryLineage extends EntryLineageContribution { readonly pluginId: string }

/** "Traces" → "Show traces". */
export const showLineageLabel = (title: string): string => `Show ${title.toLocaleLowerCase()}`;

function createEntryLineageRegistry() {
  const registrations = createOrderedRegistry<RegisteredEntryLineage>();
  let items = $state.raw<readonly RegisteredEntryLineage[]>([]);
  return {
    get items(): readonly RegisteredEntryLineage[] { return items; },
    register(pluginId: string, item: EntryLineageContribution, order = Number.MAX_SAFE_INTEGER): () => void {
      if (!isFileViewId(item.id)) throw new Error(`Invalid entry lineage id: ${String(item.id)}`);
      if (typeof item.available !== "function" || typeof item.load !== "function") throw new Error(`Entry lineage ${item.id} needs available() and load()`);
      if (items.some((existing) => existing.id === item.id)) throw new Error(`Entry lineage ${item.id} is already registered`);
      const dispose = registrations.register(item.id, { ...item, pluginId }, order);
      items = registrations.values();
      return () => { if (dispose()) items = registrations.values(); };
    },
    get(id: string): RegisteredEntryLineage | null {
      return items.find((item) => item.id === id) ?? null;
    },
    /** A contribution's answer for a directory; a throwing provider is unavailable. */
    availability(item: RegisteredEntryLineage, directory: string): boolean | "pending" {
      try {
        const answer = item.available(directory);
        return answer === true || answer === "pending" ? answer : false;
      } catch (error) {
        console.error(`[plugins] "${item.pluginId}" entry lineage ${item.id} available() failed:`, error);
        return false;
      }
    },
    clear(): void { registrations.clear(); items = []; },
  };
}

export const entryLineageRegistry = createEntryLineageRegistry();
