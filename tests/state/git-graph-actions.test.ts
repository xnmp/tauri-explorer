/**
 * Git-graph action contracts: every mutation ends in the shared refresh,
 * successful undoable mutations are recorded, cancellations are not errors,
 * prompts validate names, pull is offered only after a successful branch
 * checkout behind its upstream, and F5 refreshes never overlap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  gitCheckout: vi.fn(async () => {}),
  gitCreateBranch: vi.fn(async () => {}),
  gitCreateTag: vi.fn(async () => {}),
  gitCherryPick: vi.fn(async () => {}),
  gitRevert: vi.fn(async () => {}),
  gitMerge: vi.fn(async (): Promise<unknown> => null),
  gitRebase: vi.fn(async () => {}),
  gitStashApply: vi.fn(async () => {}),
  gitStashPop: vi.fn(async () => {}),
  gitReset: vi.fn(async () => {}),
  gitFetch: vi.fn(async () => {}),
  gitPull: vi.fn(async () => {}),
  gitBranchBehindUpstream: vi.fn(async (): Promise<number | null> => 0),
  gitDeleteBranch: vi.fn(async (): Promise<unknown> => ({ kind: "deleteBranch" })),
  gitDeleteTag: vi.fn(async () => {}),
  gitRenameBranch: vi.fn(async () => {}),
  gitDeleteRemoteBranch: vi.fn(async () => {}),
  gitUndo: vi.fn(async () => {}),
  gitCheckoutTracking: vi.fn(async () => {}),
  gitSyncLocalBranches: vi.fn(async () => ({ diverged: [], fast_forwarded: [] })),
}));
vi.mock("$lib/api/git-log", () => api);
const refresh = vi.hoisted(() => ({
  refreshAfterGitMutation: vi.fn((_repo: string, fn: () => Promise<void>) => fn()),
  runGitNetworkOperation: vi.fn(
    (_repo: string, _label: string, fn: (taskId: number, onPhase: () => void) => Promise<unknown>) => fn(1, () => {}),
  ),
}));
vi.mock("$lib/state/git-graph-refresh", () => refresh);
const ledger = vi.hoisted(() => {
  const entries: { action: unknown }[] = [];
  return {
    entries,
    gitUndoLedger: {
      record: vi.fn((_repo: string, action: unknown) => { entries.push({ action }); }),
      peek: vi.fn(() => entries.at(-1) ?? null),
      take: vi.fn(() => entries.pop() ?? null),
    },
  };
});
vi.mock("$lib/state/git-graph-undo", () => ({ gitUndoLedger: ledger.gitUndoLedger }));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: { f5SyncsLocalBranches: false } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), show: vi.fn(), clipboard: vi.fn() }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));
vi.mock("$lib/domain/git-graph-undo", () => ({
  gitUndoDescription: () => "delete branch",
  sameGitUndoAction: (a: unknown, b: unknown) => a === b,
}));

import { createGitGraphActions } from "$lib/state/git-graph-actions.svelte";

function fixture() {
  const reload = vi.fn(async () => {});
  const cancelNavigation = vi.fn();
  const dismissMenu = vi.fn();
  const actions = createGitGraphActions({ repoPath: "/repo", reload, cancelNavigation, dismissMenu });
  return { actions, reload, cancelNavigation, dismissMenu };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  ledger.entries.length = 0;
});

describe("run", () => {
  it("retires navigation, closes the menu, toasts success and refreshes once", async () => {
    const f = fixture();
    await f.actions.cherryPick("abc");
    expect(api.gitCherryPick).toHaveBeenCalledWith("/repo", "abc");
    expect(f.cancelNavigation).toHaveBeenCalled();
    expect(f.dismissMenu).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Cherry-pick done");
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it("records an undo action returned by the mutation", async () => {
    const undo = { kind: "merge" };
    api.gitMerge.mockResolvedValueOnce(undo);
    const f = fixture();
    await f.actions.merge("feat");
    expect(ledger.gitUndoLedger.record).toHaveBeenCalledWith("/repo", undo);
  });

  it("reports a cancelled network operation as info, and still refreshes", async () => {
    api.gitMerge.mockRejectedValueOnce(new Error("Git network operation cancelled"));
    const f = fixture();
    await f.actions.merge("feat");
    expect(toast.show).toHaveBeenCalledWith("Git network operation cancelled", "info");
    expect(toast.error).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it("surfaces other failures as errors and still refreshes", async () => {
    api.gitRebase.mockRejectedValueOnce(new Error("conflict"));
    const f = fixture();
    await f.actions.rebase("abc");
    expect(toast.error).toHaveBeenCalledWith("conflict");
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
});

describe("deleteBranch", () => {
  it("records the local deletion before pushing each remote delete", async () => {
    const order: string[] = [];
    ledger.gitUndoLedger.record.mockImplementationOnce(() => { order.push("record"); });
    api.gitDeleteRemoteBranch.mockImplementation(async () => { order.push("push"); });
    const f = fixture();
    f.actions.deleteBranch("feat", false, ["origin", "fork"]);
    await settle();
    expect(order).toEqual(["record", "push", "push"]);
    expect(api.gitDeleteRemoteBranch).toHaveBeenCalledWith("/repo", "fork", "feat", 1);
  });
});

describe("name prompts", () => {
  it("an empty or whitespace name closes the prompt without creating anything", () => {
    const f = fixture();
    f.actions.startPrompt("branch", "abc");
    expect(f.actions.prompt).toEqual({ kind: "branch", oid: "abc", value: "" });
    f.actions.prompt!.value = "   ";
    f.actions.confirmPrompt();
    expect(f.actions.prompt).toBeNull();
    expect(api.gitCreateBranch).not.toHaveBeenCalled();
  });

  it("creates a branch or tag at the prompted commit with a trimmed name", async () => {
    const f = fixture();
    f.actions.startPrompt("tag", "abc");
    f.actions.prompt!.value = " v1.2 ";
    f.actions.confirmPrompt();
    await settle();
    expect(api.gitCreateTag).toHaveBeenCalledWith("/repo", "v1.2", "abc");
  });

  it("rename is a no-op for an unchanged or empty name", () => {
    const f = fixture();
    f.actions.startRenameBranch("main");
    f.actions.confirmRenameBranch();
    f.actions.startRenameBranch("main");
    f.actions.renamePrompt!.value = "  ";
    f.actions.confirmRenameBranch();
    expect(api.gitRenameBranch).not.toHaveBeenCalled();
    expect(f.actions.renamePrompt).toBeNull();
  });
});

describe("checkout pull offer", () => {
  it("offers a pull after a successful branch checkout behind upstream", async () => {
    api.gitBranchBehindUpstream.mockResolvedValueOnce(3);
    const f = fixture();
    f.actions.checkout("dev", "abc");
    await settle();
    expect(api.gitCheckout).toHaveBeenCalledWith("/repo", "dev");
    expect(f.actions.pullOffer).toEqual({ branch: "dev", behind: 3 });
  });

  it("never offers a pull for a detached checkout or a failed checkout", async () => {
    const detached = fixture();
    detached.actions.checkout(null, "abc");
    await settle();
    expect(api.gitCheckout).toHaveBeenCalledWith("/repo", "abc");
    expect(api.gitBranchBehindUpstream).not.toHaveBeenCalled();

    api.gitCheckout.mockRejectedValueOnce(new Error("dirty tree"));
    const failed = fixture();
    failed.actions.checkout("dev", "abc");
    await settle();
    expect(failed.actions.pullOffer).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("dirty tree");
  });
});

describe("undo", () => {
  it("reports that there is nothing to undo", () => {
    const f = fixture();
    f.actions.requestUndo();
    expect(f.actions.undoConfirmation).toBeNull();
    expect(toast.show).toHaveBeenCalledWith("Nothing to undo in this git graph", "info");
  });

  it("refuses when the ledger changed while confirmation was open", async () => {
    const first = { kind: "a" };
    ledger.entries.push({ action: first });
    const f = fixture();
    f.actions.requestUndo();
    expect(f.actions.undoConfirmation).toBe(first);
    ledger.entries.push({ action: { kind: "b" } });
    await f.actions.confirmUndo();
    expect(api.gitUndo).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Git undo history changed while confirmation was open");
  });

  it("takes the confirmed entry before invoking its inverse", async () => {
    const action = { kind: "a" };
    ledger.entries.push({ action });
    const f = fixture();
    f.actions.requestUndo();
    await f.actions.confirmUndo();
    expect(api.gitUndo).toHaveBeenCalledWith("/repo", action);
    expect(ledger.entries).toHaveLength(0);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
});

describe("refreshWithFetch", () => {
  it("does not start a second fetch while one is running", async () => {
    let release!: () => void;
    api.gitFetch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const f = fixture();
    const prepare = vi.fn();
    const first = f.actions.refreshWithFetch(prepare);
    expect(f.actions.fetching).toBe(true);
    await f.actions.refreshWithFetch(prepare);
    expect(prepare).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(f.actions.fetching).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Fetched from remotes");
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it("reports a cancelled fetch as info and still reloads local state", async () => {
    api.gitFetch.mockRejectedValueOnce(new Error("git network operation cancelled"));
    const f = fixture();
    await f.actions.refreshWithFetch(() => {});
    expect(toast.show).toHaveBeenCalledWith("Git fetch cancelled", "info");
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
});
