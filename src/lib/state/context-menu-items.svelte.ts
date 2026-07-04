/**
 * Contribution registry for plugin-provided context-menu items.
 *
 * ContextMenu.svelte renders a divider-separated plugin section from
 * `contextMenuItems.itemsFor(selectedEntries)`. Items are registered/disposed
 * by plugins through the plugin context; toggling a plugin off removes its
 * entries.
 */

import type { FileEntry } from "$lib/domain/file";

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Optional inline SVG path `d` attribute for a 16×16 icon. */
  icon?: string;
  /** Predicate: shown only when it returns true for the current selection. */
  when: (entries: FileEntry[]) => boolean;
  handler: (entries: FileEntry[]) => void | Promise<void>;
}

function createContextMenuItemsRegistry() {
  let items = $state<ContextMenuItem[]>([]);

  return {
    get items() {
      return items;
    },
    /** Register an item; returns a disposer that removes it. */
    register(item: ContextMenuItem): () => void {
      items = [...items, item];
      // Remove by id, not object reference: Svelte's `$state` array deep-proxies
      // its elements, so the stored element is a proxy that never `===` the raw
      // `item` captured here.
      return () => {
        items = items.filter((i) => i.id !== item.id);
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
      items = [];
    },
  };
}

export const contextMenuItems = createContextMenuItemsRegistry();
