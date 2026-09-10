/**
 * Tests for the `loading` flag under concurrent per-directory fetches.
 *
 * refresh() fans out doFetch() across all tracked directories via
 * Promise.all. `loading` must reflect whether ANY fetch is still in
 * flight, not just the most recently settled one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getGitStatusMock = vi.fn();
vi.mock("$lib/api/git", () => ({
  getGitStatus: (path: string) => getGitStatusMock(path),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { gitStatusStore } from "$lib/state/git-status.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  gitStatusStore.clear();
});

describe("gitStatusStore loading flag under concurrent fetches", () => {
  it("stays true until all concurrent directory fetches settle", async () => {
    // Two directories with independently-controlled resolution timing.
    let resolveFast: (() => void) | undefined;
    let resolveSlow: (() => void) | undefined;

    getGitStatusMock.mockImplementation(async (path: string) => {
      if (path === "/fast") {
        await new Promise<void>((resolve) => {
          resolveFast = resolve;
        });
      } else {
        await new Promise<void>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return { ok: true, data: { is_git_repo: true, statuses: {} } };
    });

    // Seed both directories into the tracked set so refresh() fans out to both.
    getGitStatusMock.mockResolvedValueOnce({
      ok: true,
      data: { is_git_repo: true, statuses: {} },
    });
    await gitStatusStore.fetchForDirectory("/fast");
    getGitStatusMock.mockResolvedValueOnce({
      ok: true,
      data: { is_git_repo: true, statuses: {} },
    });
    await gitStatusStore.fetchForDirectory("/slow");

    expect(gitStatusStore.loading).toBe(false);

    const refreshPromise = gitStatusStore.refresh();

    // Both fetches are now in flight.
    expect(gitStatusStore.loading).toBe(true);

    // Let the microtask queue run so doFetch's controlled promises attach.
    await Promise.resolve();
    await Promise.resolve();

    // The fast fetch resolves first; the slow one is still pending.
    resolveFast?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(gitStatusStore.loading).toBe(true);

    // Now the slow fetch resolves too.
    resolveSlow?.();
    await refreshPromise;

    expect(gitStatusStore.loading).toBe(false);
  });
});
