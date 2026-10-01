/**
 * Changed files for immutable commit OIDs. Shared across graph remounts, with
 * the same 50-entry LRU bound as the former component-owned cache. Mutable
 * working-tree/comparison requests continue through their existing paths.
 */
import { gitCommitFiles, type CommitFile } from "$lib/api/git-log";

export function createCommitFilesCache(load: typeof gitCommitFiles) {
  const cache = new Map<string, CommitFile[]>();
  const capacity = 50;

  return async (repoPath: string, oid: string): Promise<CommitFile[]> => {
    const key = `${repoPath}\0${oid}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const files = await load(repoPath, oid);
    cache.set(key, files);
    if (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return files;
  };
}

export const cachedCommitFiles = createCommitFilesCache(gitCommitFiles);
