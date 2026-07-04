import { describe, it, expect, vi } from "vitest";
import { EmptyFolderResolver } from "$lib/state/empty-folders.svelte";
import type { FileEntry } from "$lib/domain/file";

function dirEntry(path: string, is_empty?: boolean): FileEntry {
  return { name: path.split("/").pop() ?? path, path, kind: "directory", size: 0, modified: "", is_empty };
}
function fileEntry(path: string): FileEntry {
  return { name: path.split("/").pop() ?? path, path, kind: "file", size: 1, modified: "" };
}

/** Flush pending promise microtasks so the concurrency pool settles. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("EmptyFolderResolver", () => {
  it("resolves emptiness for a directory entry and exposes it via isEmpty", async () => {
    const resolveEmpty = vi.fn(async (path: string) => path.endsWith("empty"));
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => false });

    expect(resolver.isEmpty("/a/empty")).toBeUndefined();
    resolver.request(dirEntry("/a/empty"));
    resolver.request(dirEntry("/a/full"));
    await flush();

    expect(resolver.isEmpty("/a/empty")).toBe(true);
    expect(resolver.isEmpty("/a/full")).toBe(false);
    expect(resolveEmpty).toHaveBeenCalledTimes(2);
  });

  it("ignores file entries", async () => {
    const resolveEmpty = vi.fn(async () => true);
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => false });

    resolver.request(fileEntry("/a/readme.txt"));
    await flush();

    expect(resolveEmpty).not.toHaveBeenCalled();
    expect(resolver.isEmpty("/a/readme.txt")).toBeUndefined();
  });

  it("does not re-request a path already resolved or in flight", async () => {
    const resolveEmpty = vi.fn(async () => true);
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => false });

    resolver.request(dirEntry("/a/x"));
    resolver.request(dirEntry("/a/x")); // in flight
    await flush();
    resolver.request(dirEntry("/a/x")); // already cached

    expect(resolveEmpty).toHaveBeenCalledTimes(1);
  });

  it("trusts a backend-provided is_empty without a round-trip", async () => {
    const resolveEmpty = vi.fn(async () => false);
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => false });

    resolver.request(dirEntry("/a/seeded", true));
    await flush();

    expect(resolveEmpty).not.toHaveBeenCalled();
    expect(resolver.isEmpty("/a/seeded")).toBe(true);
  });

  it("caps concurrency at maxConcurrent", async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const resolveEmpty = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => gates.push(r));
      active -= 1;
      return true;
    });
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => false, maxConcurrent: 2 });

    for (let i = 0; i < 6; i++) resolver.request(dirEntry(`/a/d${i}`));
    await flush();
    expect(peak).toBe(2);
    expect(resolveEmpty).toHaveBeenCalledTimes(2); // only the pool's worth start

    // Release gates and let the queue drain.
    while (gates.length) {
      gates.shift()!();
      await flush();
    }
    expect(resolveEmpty).toHaveBeenCalledTimes(6);
    expect(resolver.isEmpty("/a/d5")).toBe(true);
  });

  it("re-probes with the new hidden-file rule when includeHidden flips", async () => {
    let includeHidden = false;
    // A folder holding only dotfiles: empty when hidden files are off, not when on.
    const resolveEmpty = vi.fn(async (_path: string, hidden: boolean) => !hidden);
    const resolver = new EmptyFolderResolver({ resolveEmpty, includeHidden: () => includeHidden });

    resolver.request(dirEntry("/a/dots"));
    await flush();
    expect(resolver.isEmpty("/a/dots")).toBe(true);

    includeHidden = true;
    resolver.request(dirEntry("/a/dots")); // key changed → cache dropped, reprobe
    await flush();
    expect(resolver.isEmpty("/a/dots")).toBe(false);
    expect(resolveEmpty).toHaveBeenCalledTimes(2);
  });
});
