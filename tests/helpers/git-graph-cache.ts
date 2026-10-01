import type { GraphSnapshot } from "$lib/state/git-graph-cache";

/** Seed through the production writer contract. Dynamic import respects the
 * race suite's resetModules isolation; fixture keys contain their test root. */
export async function cacheSnapshot(key: string, snapshot: GraphSnapshot): Promise<boolean> {
  const { beginSnapshotWrite } = await import("$lib/state/git-graph-cache");
  const repoPath = (JSON.parse(key) as [string])[0];
  const writer = beginSnapshotWrite(key, repoPath);
  try {
    await writer.ready;
    return writer.publish(snapshot);
  } finally {
    writer.dispose();
  }
}
