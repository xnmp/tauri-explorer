/** Shared reactive appearance of a listed entry; no selection or actions. */
import type { FileEntry } from "$lib/domain/file";
import { isClipboardCut, isInClipboard } from "./use-item-interactions.svelte";
import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import { emptyFolderResolver } from "$lib/state/empty-folders.svelte";

export function useEntryAppearance(entry: () => FileEntry, directory: () => string) {
  $effect(() => {
    settingsStore.showHidden;
    emptyFolderResolver.request(entry());
  });
  return {
    get cut() { return isClipboardCut(entry()); },
    get inClipboard() { return isInClipboard(entry()); },
    get hidden() { return entry().name.startsWith(".") || manualHiddenStore.isHidden(directory(), entry().name); },
    get emptyFolder() { return entry().kind === "directory" && emptyFolderResolver.isEmpty(entry().path) === true; },
  };
}
