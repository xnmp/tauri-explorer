/** One owner of a leased native directory watch. Native acquisition and
 * release are ordered; obsolete navigation requests never acquire a watch. */
import { watchDirectory, unwatchDirectory } from "$lib/api/files";
import { isVirtualPath } from "$lib/domain/virtual-path";

export interface PathWatchCommands<L> {
  watch(path: string): Promise<L>;
  unwatch(lease: L): Promise<void>;
}

export function createPathWatch<L>(commands: PathWatchCommands<L>) {
  let held: { path: string; lease: L } | null = null;
  let revision = 0;
  let tail: Promise<void> = Promise.resolve();
  let destroyed = false;
  let disposal: Promise<void> | undefined;

  function transition(path: string | null): Promise<void> {
    const requested = ++revision;
    const task = tail.then(async () => {
      if (requested !== revision || held?.path === path) return;
      if (held) {
        await commands.unwatch(held.lease);
        held = null;
      }
      if (requested !== revision || !path) return;
      const lease = await commands.watch(path);
      held = { path, lease };
    });
    // Keep the queue usable after failure and observe fire-and-forget callers.
    // The returned task still rejects for callers requiring a teardown result.
    tail = task.catch((error) => { console.error("Directory watch transition failed:", error); });
    return task;
  }

  return {
    update(path: string): Promise<void> {
      if (destroyed) return disposal ?? Promise.resolve();
      return transition(!path || isVirtualPath(path) ? null : path);
    },
    destroy(): Promise<void> {
      destroyed = true;
      if (disposal) return disposal;

      const attempt = transition(null);
      disposal = attempt;
      void attempt.then(undefined, () => {
        if (disposal === attempt) disposal = undefined;
      });
      return attempt;
    },
  };
}

export function createDirectoryWatch() {
  return createPathWatch({ watch: watchDirectory, unwatch: unwatchDirectory });
}
