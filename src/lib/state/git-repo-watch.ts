/** Git repository watches use the same ordered ownership as directory watches,
 * while preserving their separate native registration and refresh policy. */
import { gitWatchRepo, gitUnwatchRepo } from "$lib/api/git";
import { createDirectoryWatch } from "./directory-watch";

export function createGitRepoWatch() {
  return createDirectoryWatch({
    async watch(path) {
      const result = await gitWatchRepo(path);
      if (!result.ok) throw new Error(result.error);
    },
    async unwatch(path) {
      const result = await gitUnwatchRepo(path);
      if (!result.ok) throw new Error(result.error);
    },
  });
}
