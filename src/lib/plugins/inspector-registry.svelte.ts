import type { FileEntry } from "$lib/domain/file";
import { createOrderedRegistry } from "$lib/state/ordered-registry";
import type { Component } from "svelte";

export interface InspectorContribution {
  id: string;
  title: string;
  component: Component<any>;
  props?: Record<string, unknown>;
  when(entries: FileEntry[]): boolean;
}

function createInspectorRegistry() {
  const registrations = createOrderedRegistry<InspectorContribution>();
  let items = $state<InspectorContribution[]>([]);

  return {
    register(item: InspectorContribution, order = Number.MAX_SAFE_INTEGER): () => void {
      const dispose = registrations.register(item.id, item, order);
      items = registrations.values();
      return () => {
        if (dispose()) items = registrations.values();
      };
    },
    itemsFor(entries: FileEntry[]): InspectorContribution[] {
      return items.filter((item) => {
        try { return item.when(entries); }
        catch { return false; }
      });
    },
    clear(): void {
      registrations.clear();
      items = [];
    },
  };
}

export const inspectorRegistry = createInspectorRegistry();
