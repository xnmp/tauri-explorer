/** Shared command accessors; native launch lifetime belongs to window state. */
import { windowTabsManager } from "../window-tabs.svelte";
export { openNewWindow } from "../window-launch";

/** Get the active explorer instance for commands. */
export function getActiveExplorer() {
  return windowTabsManager.getActiveExplorer();
}
