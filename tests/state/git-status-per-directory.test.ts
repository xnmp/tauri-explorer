/**
 * Tests for per-directory git status keying.
 *
 * Dual panes can show two different directories; statuses must be looked up
 * by the entry's directory so badges don't bleed between panes.
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

describe("gitStatusStore per-directory keying", () => {
  it("keeps statuses of two directories independent (no dual-pane bleed)", async () => {
    getGitStatusMock.mockImplementation(async (path: string) => ({
      ok: true,
      data: {
        is_git_repo: true,
        statuses:
          path === "/repo/src"
            ? { "main.ts": "Modified" }
            : { "README.md": "Untracked" },
      },
    }));

    await gitStatusStore.fetchForDirectory("/repo/src");
    await gitStatusStore.fetchForDirectory("/repo/docs");

    // Each directory resolves only its own entries
    expect(gitStatusStore.getStatus("/repo/src", "main.ts")).toBe("Modified");
    expect(gitStatusStore.getStatus("/repo/docs", "README.md")).toBe("Untracked");
    // No bleed: a file from the other pane's directory doesn't match
    expect(gitStatusStore.getStatus("/repo/docs", "main.ts")).toBeNull();
    expect(gitStatusStore.getStatus("/repo/src", "README.md")).toBeNull();
  });

  it("caches a directory and skips re-fetch on subsequent fetchForDirectory", async () => {
    getGitStatusMock.mockResolvedValue({
      ok: true,
      data: { is_git_repo: true, statuses: {} },
    });

    await gitStatusStore.fetchForDirectory("/repo");
    await gitStatusStore.fetchForDirectory("/repo");

    expect(getGitStatusMock).toHaveBeenCalledTimes(1);
  });

  it("refresh() re-fetches every tracked directory", async () => {
    getGitStatusMock.mockResolvedValue({
      ok: true,
      data: { is_git_repo: true, statuses: {} },
    });

    await gitStatusStore.fetchForDirectory("/a");
    await gitStatusStore.fetchForDirectory("/b");
    getGitStatusMock.mockClear();

    await gitStatusStore.refresh();

    const refreshed = getGitStatusMock.mock.calls.map((c) => c[0]).sort();
    expect(refreshed).toEqual(["/a", "/b"]);
  });

  it("bounds the number of tracked directories", async () => {
    getGitStatusMock.mockImplementation(async (path: string) => ({
      ok: true,
      data: { is_git_repo: true, statuses: { [`file-${path}`]: "Modified" } },
    }));

    for (let i = 0; i < 12; i++) {
      await gitStatusStore.fetchForDirectory(`/dir-${i}`);
    }

    // Oldest directories were evicted; recent ones remain
    expect(gitStatusStore.getStatus("/dir-0", "file-/dir-0")).toBeNull();
    expect(gitStatusStore.getStatus("/dir-11", "file-/dir-11")).toBe("Modified");
  });

  it("getStatus returns null for unknown directories", () => {
    expect(gitStatusStore.getStatus("/never-fetched", "x.txt")).toBeNull();
  });
});

describe("gitStatusStore observation coverage", () => {
  it("skips a change observed no later than the latest scan, and refetches newer or untimed ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      getGitStatusMock.mockResolvedValue({ ok: true, data: { is_git_repo: true, statuses: {} } });
      const release = gitStatusStore.trackDirectory("/repo/src");
      vi.setSystemTime(1_000);
      await gitStatusStore.fetchForDirectory("/repo/src");
      getGitStatusMock.mockClear();
      gitStatusStore.invalidateDirectories(["/repo/src"], 1_000);
      gitStatusStore.invalidateDirectories(["/repo/src"], 999);
      await Promise.resolve();
      expect(getGitStatusMock).not.toHaveBeenCalled();
      gitStatusStore.invalidateDirectories(["/repo/src"], 1_001);
      await vi.waitFor(() => expect(getGitStatusMock).toHaveBeenCalledTimes(1));
      gitStatusStore.invalidateDirectories(["/repo/src"]);
      await vi.waitFor(() => expect(getGitStatusMock).toHaveBeenCalledTimes(2));
      // Untracked directories are never refreshed by invalidation.
      gitStatusStore.invalidateDirectories(["/repo/other"]);
      release();
    } finally {
      vi.useRealTimers();
    }
    expect(getGitStatusMock.mock.calls.map(([path]) => path)).toEqual(["/repo/src", "/repo/src"]);
  });
});

describe("gitStatusStore failed scans", () => {
  it("does not let a failed scan cover a later notification", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const release = gitStatusStore.trackDirectory("/repo/lib");
      vi.setSystemTime(2_000);
      getGitStatusMock.mockResolvedValueOnce({ ok: false, error: "index locked" });
      await gitStatusStore.refreshDirectory("/repo/lib");
      getGitStatusMock.mockClear();
      getGitStatusMock.mockResolvedValue({ ok: true, data: { is_git_repo: true, statuses: {} } });
      gitStatusStore.invalidateDirectories(["/repo/lib"], 1_500);
      await vi.waitFor(() => expect(getGitStatusMock).toHaveBeenCalledTimes(1));
      await gitStatusStore.fetchForDirectory("/repo/lib"); // joins that scan
      release();
    } finally {
      vi.useRealTimers();
    }
  });
});
