/**
 * SCM sidebar action contracts: success and failure feedback, refresh after
 * out-of-store working-tree changes (including a failed Trash), and no IPC
 * without a repository.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  gitInit: vi.fn(),
  gitAddToGitignore: vi.fn(),
  gitArchiveUntracked: vi.fn(),
  gitTrashUntracked: vi.fn(),
}));
vi.mock("$lib/api/git", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), show: vi.fn() }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));

import { createScmSidebarActions } from "$lib/state/scm-sidebar-actions";

function fixture(repoRoot: string | null = "/repo") {
  const store = {
    repoRoot,
    discard: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
    commit: vi.fn(async () => ({ ok: true })),
    refresh: vi.fn(async () => {}),
    setActivePath: vi.fn(async () => {}),
    abortOperation: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
    continueRebase: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
  };
  const actions = createScmSidebarActions(() => store as never);
  return { store, actions };
}

beforeEach(() => vi.clearAllMocks());

describe("discard", () => {
  it("names the single file, or the count, that was discarded or removed", async () => {
    const f = fixture();
    await f.actions.discard({ paths: ["a.ts"], isUntracked: false });
    expect(toast.success).toHaveBeenCalledWith("Discarded changes in a.ts");
    await f.actions.discard({ paths: ["a", "b"], isUntracked: true });
    expect(toast.success).toHaveBeenCalledWith("Removed 2 files");
  });

  it("reports a failure with the action's own verb", async () => {
    const f = fixture();
    f.store.discard.mockResolvedValueOnce({ ok: false, error: "locked" });
    await f.actions.discard({ paths: ["a"], isUntracked: true });
    expect(toast.error).toHaveBeenCalledWith("Remove failed: locked");
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("untracked file actions", () => {
  it("does nothing without a repository", async () => {
    const f = fixture(null);
    await f.actions.ignore("a");
    await f.actions.archive(["a"]);
    await f.actions.trash(["a"]);
    expect(api.gitAddToGitignore).not.toHaveBeenCalled();
    expect(api.gitArchiveUntracked).not.toHaveBeenCalled();
    expect(api.gitTrashUntracked).not.toHaveBeenCalled();
  });

  it("refreshes after archiving, with a pluralised count", async () => {
    api.gitArchiveUntracked.mockResolvedValueOnce({ ok: true, data: undefined });
    const f = fixture();
    await f.actions.archive(["a", "b"]);
    expect(api.gitArchiveUntracked).toHaveBeenCalledWith("/repo", ["a", "b"]);
    expect(toast.success).toHaveBeenCalledWith("Archived 2 items to .archive");
    expect(f.store.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes before reporting a failed move to Trash", async () => {
    api.gitTrashUntracked.mockResolvedValueOnce({ ok: false, error: "denied" });
    const f = fixture();
    await f.actions.trash(["a"]);
    expect(f.store.refresh).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Move to Trash failed: denied");
    expect(f.store.refresh.mock.invocationCallOrder[0]).toBeLessThan(toast.error.mock.invocationCallOrder[0]);
  });

  it("refreshes after a successful ignore or move to Trash", async () => {
    api.gitAddToGitignore.mockResolvedValueOnce({ ok: true, data: "a" });
    api.gitTrashUntracked.mockResolvedValueOnce({ ok: true, data: undefined });
    const f = fixture();
    await f.actions.ignore("a");
    await f.actions.trash(["a"]);
    expect(toast.success).toHaveBeenCalledWith("Added a to .gitignore");
    expect(toast.success).toHaveBeenCalledWith("Moved 1 item to Trash");
    expect(f.store.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh when ignoring fails", async () => {
    api.gitAddToGitignore.mockResolvedValueOnce({ ok: false, error: "readonly" });
    const f = fixture();
    await f.actions.ignore("a");
    expect(f.store.refresh).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Ignore failed: readonly");
  });
});

describe("commit", () => {
  it("reports an amend when amend mode is on or forced by Ctrl+Enter", async () => {
    const f = fixture();
    await f.actions.commit({ forceAmend: true }, false);
    expect(toast.show).toHaveBeenLastCalledWith("Amended last commit", "success");
    await f.actions.commit(undefined, false);
    expect(toast.show).toHaveBeenLastCalledWith("Commit created", "success");
  });

  it("stays silent when the store rejects the commit", async () => {
    const f = fixture();
    f.store.commit.mockResolvedValueOnce({ ok: false } as never);
    await f.actions.commit(undefined, true);
    expect(toast.show).not.toHaveBeenCalled();
  });
});

describe("init and operations", () => {
  it("initialises a repository and then re-resolves the path", async () => {
    api.gitInit.mockResolvedValueOnce({ ok: true, data: "/work/.git" });
    const f = fixture(null);
    await f.actions.initRepo("/work");
    expect(toast.show).toHaveBeenCalledWith("Initialized git repository at /work/.git", "success");
    expect(f.store.setActivePath).toHaveBeenCalledWith("/work");
  });

  it("does not init without a path", async () => {
    const f = fixture(null);
    await f.actions.initRepo(undefined);
    expect(api.gitInit).not.toHaveBeenCalled();
  });

  it("names the aborted operation", async () => {
    const f = fixture();
    await f.actions.abortOperation("Rebase");
    expect(toast.success).toHaveBeenCalledWith("Rebase aborted");
    f.store.continueRebase.mockResolvedValueOnce({ ok: false, error: "conflicts" });
    await f.actions.continueRebase();
    expect(toast.error).toHaveBeenCalledWith("Rebase continue failed: conflicts");
  });
});
