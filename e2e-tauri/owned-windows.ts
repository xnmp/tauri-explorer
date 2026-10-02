/**
 * Handle scans that never script a page the test does not own (#885, #931).
 *
 * A parked warm window belongs to the application, and a script it cannot
 * answer ends the whole WebDriver session ("page crash or hang"). WebDriver
 * answers a handle's URL without running page script, so every scan reads the
 * URL first and scripts only pages that are safe to script.
 */

export interface WindowScanDriver {
  listHandles(): Promise<string[]>;
  switchTo(handle: string): Promise<void>;
  /** The selected page's URL, answered by the driver without running page script. */
  currentUrl(): Promise<string>;
  pause(ms: number): Promise<void>;
  now(): number;
}

export interface ScanOptions {
  timeoutMs: number;
  timeoutMsg: string;
}

/** A warm window, parked or activated: launched with `?warm=1`, which it keeps. */
export function isWarmWindowUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get("warm") === "1";
  } catch {
    return false;
  }
}

/**
 * Fail closed: script only a page whose URL is known and not warm. An empty or
 * unparseable URL is a page that has not committed its document yet (a warm
 * window among them), so a scan skips it and retries on its next pass.
 */
export function mayScriptPage(url: string): boolean {
  try {
    return new URL(url).searchParams.get("warm") !== "1";
  } catch {
    return false;
  }
}

/**
 * Visit handles until `inspect` returns a value. `inspect` runs only for pages
 * whose URL `accepts` (by default: pages safe to script). Each complete pass
 * finishes before the deadline is tested, and a handle that closes mid-scan
 * is skipped while real driver failures stay visible.
 */
export async function scanWindows<T>(
  driver: WindowScanDriver,
  inspect: (handle: string, url: string) => Promise<T | undefined>,
  { timeoutMs, timeoutMsg }: ScanOptions,
  accepts: (url: string) => boolean = mayScriptPage,
): Promise<T> {
  const deadline = driver.now() + timeoutMs;
  for (;;) {
    for (const handle of await driver.listHandles()) {
      try {
        await driver.switchTo(handle);
        const url = await driver.currentUrl();
        if (!accepts(url)) continue;
        const found = await inspect(handle, url);
        if (found !== undefined) return found;
      } catch (error) {
        if ((await driver.listHandles()).includes(handle)) throw error;
      }
    }
    if (driver.now() >= deadline) throw new Error(timeoutMsg);
    await driver.pause(250);
  }
}

/** The handle of the owned window labelled `label`. */
export function selectWindowByLabel(
  driver: WindowScanDriver & { currentLabel(): Promise<string | undefined> },
  label: string,
  timeoutMs: number,
): Promise<string> {
  return scanWindows(driver, async (handle) => await driver.currentLabel() === label ? handle : undefined,
    { timeoutMs, timeoutMsg: `window ${label} did not become ready` });
}
