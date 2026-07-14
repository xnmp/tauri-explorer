/**
 * Decision logic for "terminal follows explorer" cwd sync (issue #149).
 *
 * Pure so the rules — skip redundant cd's, don't interrupt a running command —
 * are unit-tested independently of the PTY and Svelte wiring.
 */

import { isVirtualPath } from "./virtual-path";
import { directoryKey, sameDirectory } from "./path";

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
  // Separator/case tolerant: the shell's reported cwd (possibly translated
  // from a WSL Linux path) rarely matches the explorer's string byte-for-byte.
  if (lastShellCwd !== null && sameDirectory(target, lastShellCwd)) return "skip";
  if (busy) return "queue";
  return "write";
}

export interface InjectedCdTracker {
  /** Record that a cd to `path` was injected (one echo now expected). */
  add(path: string): void;
  /** Consume one expected echo for `path`; true when the echo was ours and
   *  must not drive explorer navigation. */
  consume(path: string): boolean;
  clear(): void;
}

/**
 * Tracks cds WE injected whose OSC 7 echo hasn't arrived yet (#266, #364).
 *
 * A counted multiset, not a Set: fast tab switching can inject the same
 * target twice before its first echo lands (A→B→A), and a Set deduped the
 * two — the second echo then read as a user-typed cd and dragged whichever
 * tab was active by then to the stale path. Keys are normalized with
 * `directoryKey` because the shell's reported cwd can differ from the
 * injected string (trailing slash, separator style, Windows case).
 *
 * Bounded by `cap` total pending entries (oldest evicted): a shell without
 * OSC 7 support never echoes, and the tracker must not grow unobserved.
 */
export function createInjectedCdTracker(cap = 8): InjectedCdTracker {
  const pending = new Map<string, number>();
  let total = 0;

  return {
    add(path: string): void {
      const key = directoryKey(path);
      pending.set(key, (pending.get(key) ?? 0) + 1);
      total++;
      while (total > cap) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        const n = pending.get(oldest)!;
        if (n <= 1) pending.delete(oldest);
        else pending.set(oldest, n - 1);
        total--;
      }
    },
    consume(path: string): boolean {
      const key = directoryKey(path);
      const n = pending.get(key);
      if (!n) return false;
      if (n === 1) pending.delete(key);
      else pending.set(key, n - 1);
      total--;
      return true;
    },
    clear(): void {
      pending.clear();
      total = 0;
    },
  };
}
