/** Git repository watches use the same ordered ownership as directory watches,
 * while preserving their separate native registration and refresh policy. */
import { gitWatchRepo, gitUnwatchRepo } from "$lib/api/git";
import { createDirectoryWatch } from "./directory-watch";

export function createGitRepoWatch() {
  let watchKey: string | null = null;
  return createDirectoryWatch({
    async watch(path) {
      const result = await gitWatchRepo(path);
      if (!result.ok) throw new Error(result.error);
      watchKey = result.data;
    },
    async unwatch() {
      if (watchKey === null) return;
      const result = await gitUnwatchRepo(watchKey);
      if (!result.ok) throw new Error(result.error);
      watchKey = null;
    },
  });
}
