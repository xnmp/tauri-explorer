/**
 * VERIFICATION of #431 Claim 4 — commit-file LRU cache. Added by
 * verify/431-perf (adversarial).
 *
 * The cache lives in `GitGraphView.svelte`'s module script and is not
 * exported, so it cannot be imported directly. This test does two things:
 *  1. Pins the source: reads GitGraphView.svelte and asserts the cache uses a
 *     repo+FULL-oid key and a bound of 50 (so the replica below is faithful).
 *  2. Exercises a byte-faithful replica of `cachedCommitFiles` to prove:
 *       - a cache hit performs ZERO backend calls,
 *       - the cache is bounded at 50 (LRU eviction of the oldest),
 *       - keying on repo path + FULL oid defeats the staleness attacks:
 *         an amend (different full oid, same short prefix) and a different
 *         repo (same oid) both MISS rather than serving wrong data.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ApiCommitFile = { path: string; status: string };

/** Byte-faithful replica of GitGraphView.svelte's cachedCommitFiles (#431).
 *  `fetchFn` stands in for `gitCommitFilesApi`; we spy on its call count. */
function makeCache(fetchFn: (repo: string, oid: string) => Promise<ApiCommitFile[]>) {
  const commitFilesCache = new Map<string, ApiCommitFile[]>();
  const COMMIT_FILES_MAX = 50;
  return async function cachedCommitFiles(repoPath: string, oid: string): Promise<ApiCommitFile[]> {
    const key = `${repoPath}\0${oid}`;
    const hit = commitFilesCache.get(key);
    if (hit) {
      commitFilesCache.delete(key);
      commitFilesCache.set(key, hit);
      return hit;
    }
    const files = await fetchFn(repoPath, oid);
    commitFilesCache.set(key, files);
    if (commitFilesCache.size > COMMIT_FILES_MAX) {
      const oldest = commitFilesCache.keys().next().value;
      if (oldest !== undefined) commitFilesCache.delete(oldest);
    }
    return files;
  };
}

const full = (n: number) => `${n.toString(16).padStart(40, "0")}`;

describe("#431 Claim 4: commit-file LRU cache", () => {
  it("source uses a repo+full-oid key and a 50-entry bound", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/lib/components/GitGraphView.svelte", import.meta.url)),
      "utf8",
    );
    // Full-oid key: `${repoPath}\0${oid}` (NOT a short/abbreviated oid). The
    // source spells the NUL as the \0 escape sequence — a literal NUL byte
    // would make git/grep treat the whole .svelte file as binary (#451) —
    // so the pin matches the two source characters backslash-zero.
    expect(src).toContain("const key = `${repoPath}\\0${oid}`;");
    expect(src).toMatch(/COMMIT_FILES_MAX\s*=\s*50/);
    expect(src).toContain("commitFilesCache.size > COMMIT_FILES_MAX");
  });

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
