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
  it("refreshes both directions without changing an unaffected sibling", async () => {
    let empty = true;
    const sibling = { ...archive, path: "/home/user/Sibling", name: "Sibling" };
    const resolver = new EmptyFolderResolver({
      resolveEmpty: async (path) => path === sibling.path ? true : empty,
      includeHidden: () => false,
    });
    resolver.request(archive);
    resolver.request(sibling);
    await flush();
    expect(resolver.isEmpty(archive.path)).toBe(true);
    empty = false;
    resolver.invalidate([archive.path]);
    await flush();
    expect(resolver.isEmpty(archive.path)).toBe(false);
    expect(resolver.isEmpty(sibling.path)).toBe(true);
    empty = true;
    resolver.invalidate([archive.path]);
    await flush();
    expect(resolver.isEmpty(archive.path)).toBe(true);
    expect(resolver.isEmpty(sibling.path)).toBe(true);
  });

  it.each([
    ["/home/user/Archive", "/home/user/Archive/"],
    ["C:\\Users\\Owner\\Archive", "c:/users/owner/archive/"],
  ])("invalidates equivalent directory identities: %s", async (listed, affected) => {
    let empty = true;
    const resolver = new EmptyFolderResolver({ resolveEmpty: async () => empty, includeHidden: () => false });
    resolver.request({ ...archive, path: listed });
    await flush();
    expect(resolver.isEmpty(listed)).toBe(true);
    empty = false;
    resolver.invalidate([affected]);
    await flush();
    expect(resolver.isEmpty(listed)).toBe(false);
    expect(resolver.isEmpty(affected)).toBe(false);
  });

  it("ignores a delayed hidden-only result when visibility changes", async () => {
    let showHidden = false;
    let finishOld: (value: boolean) => void = () => {};
    const resolveEmpty = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishOld = resolve; }))
      .mockImplementation(async (_path: string, hidden: boolean) => !hidden);
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => showHidden });
    resolver.request(archive);
    showHidden = true;
    resolver.request(archive);
    await flush();
    finishOld(true);
    await flush();
    expect(resolver.isEmpty(archive.path)).toBe(false);
    showHidden = false;
    resolver.request(archive);
    await flush();
    expect(resolver.isEmpty(archive.path)).toBe(true);
  });

  it("keeps probe concurrency bounded across repeated invalidation", async () => {
    let active = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    const resolver = new EmptyFolderResolver({
      includeHidden: () => false,
      maxConcurrent: 2,
      resolveEmpty: async () => {
        peak = Math.max(peak, ++active);
        await new Promise<void>(resolve => pending.push(resolve));
        --active;
        return false;
      },
    });
    resolver.request(archive);
    for (let i = 0; i < 20; i++) resolver.invalidate([archive.path]);
    while (pending.length) {
      pending.shift()!();
      await flush();
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
    expect(resolver.isEmpty(archive.path)).toBe(false);
  });

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
