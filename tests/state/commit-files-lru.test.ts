/** Behavioral verification of the production commit-file LRU (#431, #680). */
import { describe, it, expect, vi } from "vitest";
import { createCommitFilesCache as makeCache } from "$lib/state/git-commit-files-cache";

const full = (n: number) => `${n.toString(16).padStart(40, "0")}`;

describe("#431 Claim 4: commit-file LRU cache", () => {
  it("a cache hit performs ZERO backend calls", async () => {
    const fetchFn = vi.fn(async (_r: string, oid: string) => [{ path: `${oid}.ts`, status: "M" }]);
    const cached = makeCache(fetchFn);

    const a = await cached("/repo", full(1));
    const b = await cached("/repo", full(1));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("is bounded at 50 entries (LRU-evicts the oldest)", async () => {
    const fetchFn = vi.fn(async (_r: string, oid: string) => [{ path: oid, status: "A" }]);
    const cached = makeCache(fetchFn);

    // Fill 50 distinct commits.
    for (let i = 0; i < 50; i++) await cached("/repo", full(i));
    expect(fetchFn).toHaveBeenCalledTimes(50);

    // Touch commit 0 so it becomes most-recently-used.
    await cached("/repo", full(0));
    expect(fetchFn).toHaveBeenCalledTimes(50); // still a hit

    // Insert a 51st distinct commit → evicts the current oldest (commit 1),
    // NOT the freshly-touched commit 0.
    await cached("/repo", full(50));
    expect(fetchFn).toHaveBeenCalledTimes(51);

    // commit 0 still cached (was touched) → hit.
    await cached("/repo", full(0));
    expect(fetchFn).toHaveBeenCalledTimes(51);

    // commit 1 was evicted → miss (re-fetch).
    await cached("/repo", full(1));
    expect(fetchFn).toHaveBeenCalledTimes(52);
  });

  it("STALENESS: an amend (different full oid) cannot serve the pre-amend file list", async () => {
    let payload = "before-amend";
    const fetchFn = vi.fn(async () => [{ path: payload, status: "M" }]);
    const cached = makeCache(fetchFn);

    const oidBefore = "abcdef1000000000000000000000000000000000";
    const first = await cached("/repo", oidBefore);
    expect(first[0].path).toBe("before-amend");

    // Amend rewrites the commit → a NEW full oid that shares the short prefix.
    const oidAfter = "abcdef1999999999999999999999999999999999";
    payload = "after-amend";
    const second = await cached("/repo", oidAfter);
    expect(second[0].path).toBe("after-amend"); // full-oid key → cache miss, fresh
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("STALENESS: the same oid in a different repo is keyed separately", async () => {
    const fetchFn = vi.fn(async (repo: string, _oid: string) => [{ path: repo, status: "A" }]);
    const cached = makeCache(fetchFn);
    const oid = full(7);

    const a = await cached("/repoA", oid);
    const b = await cached("/repoB", oid);
    expect(a[0].path).toBe("/repoA");
    expect(b[0].path).toBe("/repoB");
    expect(fetchFn).toHaveBeenCalledTimes(2); // repo path is part of the key
  });
});
