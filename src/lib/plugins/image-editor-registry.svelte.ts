import type { Component } from "svelte";
import { createOrderedRegistry } from "$lib/state/ordered-registry";

/** The exact revision shown in the host editor. Producers must reject a changed source. */
export interface ImageEditorSource {
  readonly path: string;
  readonly name: string;
  readonly digest: string;
  readonly format: string;
  readonly referencePaths: readonly string[];
}
export interface ImageEditorTool {
  id: string;
  title: string;
  component: Component<any>;
  props?: Record<string, unknown>;
  when(source: ImageEditorSource): boolean;
}
function createImageEditorRegistry() {
  const registrations = createOrderedRegistry<ImageEditorTool>();
  // Contributions contain opaque components and service ports. Replace the
  // array immutably without proxying plugin-owned objects.
  let items = $state.raw<ImageEditorTool[]>([]);
  return {
    register(tool: ImageEditorTool, order = Number.MAX_SAFE_INTEGER): () => void {
      const dispose = registrations.register(tool.id, tool, order);
      items = registrations.values();
      return () => { if (dispose()) items = registrations.values(); };
    },
    toolsFor(source: ImageEditorSource): ImageEditorTool[] {
      return items.filter((tool) => { try { return tool.when(source); } catch { return false; } });
    },
  };
}
export const imageEditorRegistry = createImageEditorRegistry();
