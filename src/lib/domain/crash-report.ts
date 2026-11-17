/**
 * Pure helpers for local crash capture (#302).
 *
 * No framework, Tauri, or IO deps — everything here is a pure function and is
 * unit-tested directly. Used by `src/lib/api/crash.ts`. Privacy: nothing here
 * sends anything anywhere; it only shapes text that the user later chooses to
 * submit through the GitHub issue form.
 */

/**
 * Decide whether a freshly-observed webview error should be recorded as a
 * crash, given the set of message keys already recorded this session.
 *
 * Dedupe is per identical message so a tight error loop yields a single crash
 * record rather than flooding the crashes dir. Immutable in/out: returns the
 * decision plus the next seen-set, leaving the input untouched.
 */
export function dedupeFrontendCrash(
  seen: ReadonlySet<string>,
  message: string,
): { record: boolean; seen: Set<string> } {
  const key = message.trim();
  if (seen.has(key)) return { record: false, seen: new Set(seen) };
  const next = new Set(seen);
  next.add(key);
  return { record: true, seen: next };
}


/**
 * Browser notices that arrive as window `error` events but are not failures:
 * a ResizeObserver callback changed layout, so the browser deferred the
 * resulting notifications to the next frame. The file grid does this on
 * purpose (#1061); Chromium's older wording is "loop limit exceeded" (#1725).
 */
const BENIGN_BROWSER_ERRORS: readonly RegExp[] = [
  /^ResizeObserver loop completed with undelivered notifications\.?$/,
  /^ResizeObserver loop limit exceeded\.?$/,
];

/** True for a window `error` message that must not be logged or recorded as a crash. */
export function isBenignBrowserError(message: string | null | undefined): boolean {
  if (typeof message !== "string") return false;
  const text = message.trim();
  return BENIGN_BROWSER_ERRORS.some((pattern) => pattern.test(text));
}
