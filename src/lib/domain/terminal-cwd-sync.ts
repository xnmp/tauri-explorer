/**
 * Decision logic for "terminal follows explorer" cwd sync (issue #149).
 *
 * Pure so the rules — skip redundant cd's, don't interrupt a running command —
 * are unit-tested independently of the PTY and Svelte wiring.
 */

import { isVirtualPath } from "./virtual-path";

export type CdSyncAction = "write" | "queue" | "skip";

/**
 * Decide what to do when the explorer navigates to `target`:
 * - `skip`  — the shell is already there (loop / no-op guard). Wins over
 *             everything else, so a busy shell already at the target is left
 *             untouched rather than queued.
 * - `queue` — a foreground command is running; defer the cd until it finishes.
 * - `write` — inject the cd now.
 *
 * `lastShellCwd` is the shell's last reported cwd (via OSC 7), or `null` when
 * unknown — in which case we can't prove it's a no-op, so we don't skip.
 */
export function decideCdSync(
  target: string,
  lastShellCwd: string | null,
  busy: boolean
): CdSyncAction {
  // Virtual (`scheme://…`) locations don't exist in the real filesystem —
  // injecting `cd 'demo://'` into the shell would just error (#152).
  if (isVirtualPath(target)) return "skip";
  if (lastShellCwd !== null && target === lastShellCwd) return "skip";
  if (busy) return "queue";
  return "write";
}
