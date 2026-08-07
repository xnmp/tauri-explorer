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
