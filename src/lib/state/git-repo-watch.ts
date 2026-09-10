/** Git repository watches use the same ordered ownership as directory watches,
 * while preserving their separate native registration and refresh policy. */
import { gitWatchRepo, gitUnwatchRepo, type GitWatchLease } from "$lib/api/git";
import { createPathWatch } from "./directory-watch";

export function createGitRepoWatch() {
  return createPathWatch<GitWatchLease>({
    async watch(path) {
      const result = await gitWatchRepo(path);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    async unwatch(lease) {
      const result = await gitUnwatchRepo(lease);
      if (!result.ok) throw new Error(result.error);
    },
  });
}
