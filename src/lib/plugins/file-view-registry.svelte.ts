/**
 * Plugin-contributed file views (SDK 2). A file view replaces a pane's main
 * file listing, like the built-in Details/List/Tiles modes. A pane keeps its
 * built-in view mode while a plugin view is chosen, so toggling the plugin
 * view off returns to it, and a folder the view does not apply to resolves to
 * it while the pane retains the plugin-view preference.
 */
import type { Component } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { createOrderedRegistry } from "$lib/state/ordered-registry";
import type { PreviewTarget } from "./preview-registry.svelte";
import type { PaneTileSize } from "$lib/domain/tile-layout";

export type { PaneTileSize, TileSizePreset } from "$lib/domain/tile-layout";

import { isFileViewId } from "$lib/domain/file-view-id";

/**
 * The pane a file view renders in. Every getter is reactive. Actions apply to
 * this pane only, never to whichever pane happens to be active.
 */
export interface FileViewPane {
  readonly paneId: string;
  readonly directory: string;
  /** Entries listed in the pane (after hidden/filter rules). */
  readonly entries: readonly FileEntry[];
  readonly selection: readonly FileEntry[];
  /** The keyboard cursor / primary focus, if any. */
  readonly focusedPath: string | null;
  readonly active: boolean;
  /** The pane's current plugin preview target, when this view owns it. */
  readonly previewTarget: PreviewTarget | null;
  /**
   * The tile size the built-in Tiles view would use here: the folder's
   * override ("Tile View: Set Size", the context menu's Icon Size), else the
   * global setting. Reactive, so a view sized from it follows both. Present
   * on hosts with the `"tileSize"` capability; pass `tileSize?.preset` as
   * `ui/file-tiles`'s `size`.
   */
  readonly tileSize?: PaneTileSize;
  /** Select one entry with the normal modifier semantics (Ctrl toggles, Shift extends). */
  select(entry: FileEntry, modifiers?: { ctrlKey?: boolean; shiftKey?: boolean }): void;
  /** Replace the selection; `focus` becomes the cursor/primary entry. */
  setSelection(paths: readonly string[], focus?: string | null): void;
  clearSelection(): void;
  /** Activate an entry like a double-click: enter a folder or open a file. */
  open(entry: FileEntry): Promise<void>;
  /** Show the standard file context menu (for `entry`, or the folder background). */
  contextMenu(event: MouseEvent, entry?: FileEntry): void;
  navigate(path: string): Promise<void>;
  /**
   * Show a non-file target (temporary output, outside reference, recorded
   * revision) in the Preview pane. It clears the file selection; any later
   * selection change or navigation clears the target again. Targets are never
   * listed as Explorer files or exposed as draggable filesystem paths.
   */
  setPreviewTarget(target: PreviewTarget | null): void;
  /** Return to the pane's built-in view mode. */
  exitView(): void;
}

export interface FileViewContribution {
  id: string;
  title: string;
  component: Component<any>;
  props?: Record<string, unknown>;
  /** Whether the view applies to a folder. Reactive; defaults to true. */
  available?(directory: string): boolean;
}

export interface RegisteredFileView extends FileViewContribution { readonly pluginId: string }

function createFileViewRegistry() {
  const registrations = createOrderedRegistry<RegisteredFileView>();
  let items = $state.raw<readonly RegisteredFileView[]>([]);
  return {
    get items(): readonly RegisteredFileView[] { return items; },
    register(pluginId: string, item: FileViewContribution, order = Number.MAX_SAFE_INTEGER): () => void {
      if (!isFileViewId(item.id)) throw new Error(`Invalid file view id: ${String(item.id)}`);
      if (items.some((existing) => existing.id === item.id)) throw new Error(`File view ${item.id} is already registered`);
      const dispose = registrations.register(item.id, { ...item, pluginId }, order);
      items = registrations.values();
      return () => { if (dispose()) items = registrations.values(); };
    },
    get(id: string | null | undefined): RegisteredFileView | null {
      return id ? items.find((item) => item.id === id) ?? null : null;
    },
    /** The plugin view a pane shows, or null for its built-in view mode. */
    resolve(preference: string | null | undefined, directory: string): RegisteredFileView | null {
      const view = this.get(preference);
      if (!view || !directory || isVirtualPath(directory)) return null;
      try { return view.available?.(directory) ?? true ? view : null; }
      catch (error) {
        // Runs inside a derived: a throwing (or state-mutating) check falls back
        // to the built-in view, but must not fail silently.
        console.error(`[plugins] "${view.pluginId}" file view ${view.id} available() failed:`, error);
        return null;
      }
    },
    clear(): void { registrations.clear(); items = []; },
  };
}

export const fileViewRegistry = createFileViewRegistry();
