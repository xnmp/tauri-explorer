import { describe, expect, it, vi } from "vitest";
import { EmptyFolderResolver } from "$lib/state/empty-folders.svelte";
import type { FileEntry } from "$lib/domain/file";

const archive: FileEntry = {
  name: "Archive",
  path: "/home/user/Archive",
  kind: "directory",
  size: 0,
  modified: "",
};

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("EmptyFolderResolver invalidation", () => {
  it("rechecks a moved-into folder and ignores an older empty probe", async () => {
    let finishFirstProbe: ((empty: boolean) => void) | undefined;
    const resolveEmpty = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => {
          finishFirstProbe = resolve;
        }),
      )
      .mockResolvedValueOnce(false);
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => false });

    resolver.request(archive);
    await flush();
    expect(resolveEmpty).toHaveBeenCalledTimes(1);

    // A move puts a visible item into Archive while its old emptiness check is pending.
    resolver.invalidate([archive.path]);
    await flush();
    expect(resolveEmpty).toHaveBeenCalledTimes(2);

    finishFirstProbe?.(true);
    await flush();

    expect(resolver.isEmpty(archive.path)).toBe(false);
  });
});
