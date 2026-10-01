/** One native observation lease per repository retained by graph snapshots or
 * pending writers. Variants share coverage; the last owner releases it. */
import { isTauri } from "$lib/api/common";
import { directoryKey, isUncPath } from "$lib/domain/path";
import { createGitRepoWatch } from "./git-repo-watch";
import { ensureGitWatcherListener } from "./git-refresh";

interface RepoWatch {
  update(path: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface GraphCoverageLease {
  readonly ready: Promise<boolean>;
  release(): void;
}

export function createGitGraphCoverage(dependencies: {
  listen(): Promise<boolean>;
  createWatch(): RepoWatch;
}) {
  interface Coverage {
    owners: number;
    closed: boolean;
    ready: Promise<boolean>;
    watch: RepoWatch;
  }
  const repositories = new Map<string, Coverage>();

  function retain(repoPath: string): GraphCoverageLease {
    // UNC uses a recursive 15s PollWatcher, not continuous notifications.
    // Retaining hidden snapshots would add persistent network scans while
    // still allowing stale remounts between polls. Read these graphs fresh.
    if (isUncPath(repoPath)) return { ready: Promise.resolve(false), release() {} };
    const key = directoryKey(repoPath);
    let coverage = repositories.get(key);
    if (!coverage) {
      const entry: Coverage = {
        owners: 0, closed: false, ready: Promise.resolve(false), watch: dependencies.createWatch(),
      };
      repositories.set(key, entry);
      entry.ready = Promise.resolve().then(async () => {
        if (entry.closed || !await dependencies.listen() || entry.closed) return false;
        // Pass the original IPC path, never the comparison key.
        await entry.watch.update(repoPath);
        return !entry.closed;
      }).catch((error) => {
        console.warn("Graph cache coverage unavailable:", error);
        return false;
      });
      coverage = entry;
    }
    const owned = coverage;
    owned.owners += 1;
    let released = false;
    return {
      ready: owned.ready.then((ready) => ready && !released),
      release() {
        if (released) return;
        released = true;
        if (--owned.owners !== 0) return;
        owned.closed = true;
        if (repositories.get(key) === owned) repositories.delete(key);
        // The ordered watch owner drains a late acquisition before releasing.
        void owned.watch.destroy().catch((error) => console.warn("Graph cache coverage cleanup failed:", error));
      },
    };
  }
  return { retain };
}

export const gitGraphCoverage = createGitGraphCoverage({
  // The browser fixture backend publishes its own change bus and needs no OS
  // watch. Native caches require both actual Tauri listener and watch ACKs.
  listen: () => isTauri() ? ensureGitWatcherListener() : Promise.resolve(true),
  createWatch: () => isTauri() ? createGitRepoWatch() : {
    update: async () => {}, destroy: async () => {},
  },
});
