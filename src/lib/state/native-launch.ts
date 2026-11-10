import { invoke, isTauri } from "$lib/api/common";
import { isMac, isWindows } from "$lib/domain/platform";
import { listen } from "@tauri-apps/api/event";
import { windowTabsManager } from "./window-tabs.svelte";

/** A secondary-process launch routed to this window (`window_launch.rs`).
 *  `newTab` comes from `tauri-explorer --new-tab PATH` (#1478). */
interface NativeLaunchRequest {
  path: string;
  newTab: boolean;
}

/** Register before draining so process launches survive renderer startup. */
export function startNativeLaunchReceiver(): () => void {
  if (!isTauri() || isMac || isWindows) return () => {};
  let active = true;
  let unlisten: (() => void) | undefined;
  let transition = Promise.resolve();
  const report = (error: unknown) => console.error("Could not open requested Explorer location", error);
  const drain = () => {
    transition = transition.catch(report).then(async () => {
      if (!active) return;
      const requests = await invoke<NativeLaunchRequest[]>("take_window_launch_requests");
      if (!requests.length || !active) return;
      for (const { path, newTab } of requests) {
        if (!active) return;
        if (newTab) {
          windowTabsManager.createTab(path);
          continue;
        }
        const { openNewWindow } = await import("./window-launch");
        if (!active) return;
        await openNewWindow(path);
      }
    });
    void transition.catch(report);
  };
  void listen("explorer:launch-requested", drain).then((stop) => {
    if (!active) { stop(); return; }
    unlisten = stop; drain();
  }).catch(report);
  return () => { active = false; unlisten?.(); };
}
