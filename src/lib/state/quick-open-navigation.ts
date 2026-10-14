import { admitsCommandDestination } from "$lib/domain/command-admission";
import { dialogStore } from "./dialogs.svelte";
import { runAfterClose } from "./run-after-close";
import { windowTabsManager } from "./window-tabs.svelte";

/** Quick Open outcomes that navigate a pane are admitted like a pane command:
 *  Quick Open closes first (it is itself a modal), then the destination pane's
 *  ownership decides. Returns whether the navigation ran. */
export async function navigateFromQuickOpen(close: () => void, path: string): Promise<boolean> {
  let navigated = false;
  await runAfterClose(close, async () => {
    if (!admitsCommandDestination({ scope: "pane" }, windowTabsManager.activePaneId, dialogStore)) return;
    await windowTabsManager.getActiveExplorer()?.navigateTo(path);
    navigated = true;
  });
  return navigated;
}
