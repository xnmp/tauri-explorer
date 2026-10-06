import { invoke, isTauri } from "$lib/api/common";
import { isMac, isWindows } from "$lib/domain/platform";
import { listen } from "@tauri-apps/api/event";

/** Register before draining so process launches survive renderer startup. */
export function startNativeLaunchReceiver(): () => void {
  if (!isTauri() || isMac || isWindows) return () => {};
  let active = true;
  let unlisten: (() => void) | undefined;
  let transition = Promise.resolve();
  const report = (error: unknown) => console.error("Could not open requested Explorer window", error);
  const drain = () => {
    transition = transition.catch(report).then(async () => {
      if (!active) return;
      const paths = await invoke<string[]>("take_window_launch_requests");
      if (!paths.length || !active) return;
      const { openNewWindow } = await import("./window-launch");
      for (const path of paths) {
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
