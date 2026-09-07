/** One owner of a refcounted native directory watch. Native acquisition and
 * release are ordered; obsolete navigation requests never acquire a watch. */
import { watchDirectory, unwatchDirectory } from "$lib/api/files";
import { isVirtualPath } from "$lib/domain/virtual-path";

interface WatchCommands {
  watch(path: string): Promise<void>;
  unwatch(path: string): Promise<void>;
}

export function createDirectoryWatch(commands: WatchCommands = { watch: watchDirectory, unwatch: unwatchDirectory }) {
  let held: string | null = null;
  let revision = 0;
  let tail: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;

  function transition(path: string | null): Promise<void> {
    const requested = ++revision;
    const task = tail.then(async () => {
      if (requested !== revision || held === path) return;
      if (held) {
        await commands.unwatch(held);
        held = null;
      }
      if (requested !== revision || !path) return;
      await commands.watch(path);
      held = path;
    });
    // Keep the queue usable after failure and observe fire-and-forget callers.
    // The returned task still rejects for callers requiring a teardown result.
    tail = task.catch((error) => { console.error("Directory watch transition failed:", error); });
    return task;
  }

  return {
    update(path: string): Promise<void> {
      if (disposal) return disposal;
      return transition(!path || isVirtualPath(path) ? null : path);
    },
    destroy(): Promise<void> {
      return disposal ??= transition(null);
    },
  };
}
