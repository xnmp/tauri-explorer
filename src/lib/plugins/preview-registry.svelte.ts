/**
 * Preview pane extension points (SDK 2): plugin preview targets and
 * Preview-info sections.
 *
 * A preview target is a non-file subject (an unsaved generated image, an
 * outside reference, a recorded revision). The Preview pane shows its image,
 * details and explicit actions; it never offers file actions, opening, sibling
 * stepping or dragging for it, because it is not an Explorer file.
 */
import type { Component } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import { createOrderedRegistry } from "$lib/state/ordered-registry";

export interface PreviewTargetAction {
  id: string;
  label: string;
  title?: string;
  icon?: "save" | "delete" | "save-as";
  disabled?: boolean;
  run(): void | Promise<void>;
}

export interface PreviewTarget {
  /** Plugin-scoped stable identity, e.g. "artifact:42". */
  readonly id: string;
  readonly title: string;
  readonly typeLabel?: string;
  /** Local image shown through the thumbnail service (never as a file entry). */
  readonly imagePath?: string;
  readonly badge?: string;
  readonly details?: readonly { label: string; value: string }[];
  readonly actions?: readonly PreviewTargetAction[];
  /** Opaque payload for the owning plugin's Preview-info sections. */
  readonly data?: unknown;
}

export type PreviewSubject =
  | { readonly kind: "file"; readonly entry: FileEntry; readonly paneId: string | null }
  | { readonly kind: "target"; readonly target: PreviewTarget; readonly pluginId: string; readonly paneId: string | null };

export interface PreviewInfoContribution {
  id: string;
  /** Receives `subject` (and `props`). */
  component: Component<any>;
  props?: Record<string, unknown>;
  when(subject: PreviewSubject): boolean;
}

interface RegisteredPreviewInfo extends PreviewInfoContribution { readonly pluginId: string }

function createPreviewInfoRegistry() {
  const registrations = createOrderedRegistry<RegisteredPreviewInfo>();
  let items = $state.raw<readonly RegisteredPreviewInfo[]>([]);
  return {
    register(pluginId: string, item: PreviewInfoContribution, order = Number.MAX_SAFE_INTEGER): () => void {
      const dispose = registrations.register(`${pluginId}:${item.id}`, { ...item, pluginId }, order);
      items = registrations.values();
      return () => { if (dispose()) items = registrations.values(); };
    },
    /** Sections for a subject. A target only reaches its own plugin's sections. */
    itemsFor(subject: PreviewSubject): readonly RegisteredPreviewInfo[] {
      return items.filter((item) => {
        if (subject.kind === "target" && subject.pluginId !== item.pluginId) return false;
        try { return item.when(subject); }
        catch (error) { console.error(`[plugins] "${item.pluginId}" preview info ${item.id} when() failed:`, error); return false; }
      });
    },
    clear(): void { registrations.clear(); items = []; },
  };
}

export const previewInfoRegistry = createPreviewInfoRegistry();
