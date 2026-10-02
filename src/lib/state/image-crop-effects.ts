import type { FileMutationReceipt } from "$lib/domain/file";
import { parentDir } from "$lib/domain/path";
import { broadcastFileChange } from "./file-events";
import { invalidateThumbnailCache } from "./thumbnail-cache";
import { windowTabsManager } from "./window-tabs.svelte";
import { toastStore } from "./toast.svelte";

/** Publish a settled native effect through the shared pane refresh policy,
 * independently of the initiating editor's lifetime or current selection. */
export function publishImageCrop(receipt: FileMutationReceipt, warning?: string): void {
  const directory = parentDir(receipt.path);
  invalidateThumbnailCache(receipt.path);
  for (const explorer of windowTabsManager.getAllExplorers()) explorer.directoryChanged({ path: directory });
  broadcastFileChange([directory]);
  if (warning) toastStore.error(warning);
  else toastStore.success(`Saved ${receipt.path}`);
}
