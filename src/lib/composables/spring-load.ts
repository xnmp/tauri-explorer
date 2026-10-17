/**
 * Spring-loaded peek entry point for every drag backend (#1242): the HTML5
 * DOM drag (window capture listeners), the native receiver (Linux GTK and
 * external drags) and the macOS/Windows pointer drag all report the element
 * under the drag here, and end the drag here.
 *
 * Kept tiny because it sits on the startup path: it returns at once while
 * Folder Peek is off, and loads the driver (`spring-load-driver.ts`) on the
 * first eligible hover, replaying that hover once it has loaded.
 */
import { settingsStore } from "$lib/state/settings.svelte";
import type { SpringLoadDriver } from "./spring-load-driver";

let driver: SpringLoadDriver | null = null;
let loading = false;
let latest: Element | null = null;
const noHold = () => {};

/**
 * A live drag moved: `locate` names the element under it (null: outside every
 * listing, or the drag left the window). It runs only while Folder Peek is on,
 * so a hit test costs nothing otherwise.
 */
export function springHover(locate: () => Element | null): void {
  if (!settingsStore.folderPeek) { driver?.hover(null); return; }
  const element = locate();
  if (driver) { driver.hover(element); return; }
  latest = element;
  if (!element) return;
  if (loading) return;
  loading = true;
  void import("./spring-load-driver").then(module => {
    driver = module.createDomSpringLoadDriver();
    const replay = latest;
    latest = null;
    if (replay?.isConnected) driver.hover(replay);
  }, () => { loading = false; });
}

/** The drag dropped, ended or was cancelled: close every temporary peek. */
export function springEnd(): void {
  latest = null;
  driver?.end();
}

/** Keep the current temporary peeks until the returned release runs. */
export function springHold(): () => void {
  return driver ? driver.hold() : noHold;
}
