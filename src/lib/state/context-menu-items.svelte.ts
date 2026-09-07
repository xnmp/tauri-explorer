/**
 * Contribution registry for plugin-provided context-menu items.
 *
 * ContextMenu.svelte renders a divider-separated plugin section from
 * `contextMenuItems.itemsFor(selectedEntries)`. Items are registered/disposed
 * by plugins through the plugin context; toggling a plugin off removes its
 * entries.
 */

import { createOwnedRegistry } from "./owned-registry";
import type { FileEntry } from "$lib/domain/file";

export type ContextMenuItemGroup = "ai";

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Optional inline SVG path `d` attribute for a 16×16 icon. */
  icon?: string;
  /** Optional submenu group used to keep related contributed actions together. */
  group?: ContextMenuItemGroup;
  /** Predicate: shown only when it returns true for the current selection. */
  when: (entries: FileEntry[]) => boolean;
  handler: (entries: FileEntry[]) => void | Promise<void>;
}

function createContextMenuItemsRegistry() {
  let items = $state<ContextMenuItem[]>([]);
  const registrations = createOwnedRegistry<ContextMenuItem>();

  return {
    get items() {
      return items;
    },
    /** Register an item; returns a disposer that removes it. */
    register(item: ContextMenuItem): () => void {
      const dispose = registrations.register(item.id, item);
      items = registrations.values();
      return () => {
        if (dispose()) items = registrations.values();
      };
    },
    /** Items whose `when` predicate passes for the given selection. */
    itemsFor(entries: FileEntry[]): ContextMenuItem[] {
      return items.filter((item) => {
        try {
          return item.when(entries);
        } catch {
          return false;
        }
      });
    },
    /** Remove all items. Test helper. */
    clear(): void {
      registrations.clear();
      items = [];
    },
  };
}

export const contextMenuItems = createContextMenuItemsRegistry();
