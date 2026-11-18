/** A failed stage/unstage must reach the user (#1823), not be swallowed. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitStatusSummary } from "$lib/api/git";

type R = { ok: true; data?: undefined } | { ok: false; error: string };
const stageMock = vi.fn(async (): Promise<R> => ({ ok: true }));
const unstageMock = vi.fn(async (): Promise<R> => ({ ok: true }));
const summary: GitStatusSummary = {
  is_repo: true, repo_root: "/repo", branch: "main", detached: false,
  staged: [], changes: [], untracked: [], merge: [], op_state: "clean",
};

vi.mock("$lib/api/git", () => ({
  gitRepoRoot: async () => ({ ok: true, data: "/repo" }),
  gitDirectoryScope: async () => ({ ok: true, data: { repo_root: "/repo", relative_directory: "" } }),
  gitSummary: async () => ({ ok: true, data: summary }),
  gitStage: () => stageMock(),
  gitUnstage: () => unstageMock(),
  gitWatchRepo: vi.fn(async (p: string) => ({ ok: true, data: { id: p, repoRoot: p } })),
  gitUnwatchRepo: vi.fn(async () => ({ ok: true, data: undefined })),
  gitAddToGitignore: vi.fn(),
  gitArchiveUntracked: vi.fn(),
  gitInit: vi.fn(),
  gitTrashUntracked: vi.fn(),
}));
vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: vi.fn(async () => {}),
  notifyLocalGitChange: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), show: vi.fn() }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));

import { stagePaths } from "$lib/state/scm-sidebar-actions";

async function store() {
  vi.resetModules();
  const mod = await import("$lib/state/scm.svelte");
  const s = mod.getScmStore("p");
  await s.setActivePath("/repo");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return s;
}

beforeEach(() => vi.clearAllMocks());

describe("scm stage/unstage failures", () => {
  it("toasts the error when unstage fails", async () => {
    unstageMock.mockResolvedValueOnce({ ok: false, error: "index.lock exists" });
    const s = await store();
    await stagePaths(s, ["a.ts"], "unstage");
    expect(toast.error).toHaveBeenCalledWith("Unstage failed: index.lock exists");
  });

  it("toasts the error when stage fails", async () => {
    stageMock.mockResolvedValueOnce({ ok: false, error: "denied" });
    const s = await store();
    await stagePaths(s, ["a.ts"], "stage");
    expect(toast.error).toHaveBeenCalledWith("Stage failed: denied");
  });

  it("stays silent on success", async () => {
    const s = await store();
    await stagePaths(s, ["a.ts"], "unstage");
    await stagePaths(s, ["a.ts"], "stage");
    expect(toast.error).not.toHaveBeenCalled();
  });
});
