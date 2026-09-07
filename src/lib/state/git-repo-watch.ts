/** Git repository watches use the same ordered ownership as directory watches,
 * while preserving their separate native registration and refresh policy. */
import { gitWatchRepo, gitUnwatchRepo, type GitWatchLease } from "$lib/api/git";
import { createDirectoryWatch } from "./directory-watch";

export function createGitRepoWatch() {
  let lease: GitWatchLease | null = null;
  return createDirectoryWatch({
    async watch(path) {
      const result = await gitWatchRepo(path);
      if (!result.ok) throw new Error(result.error);
      lease = result.data;
    },
    async unwatch() {
      if (lease === null) return;
      const result = await gitUnwatchRepo(lease);
      if (!result.ok) throw new Error(result.error);
      lease = null;
    },
  });
}
