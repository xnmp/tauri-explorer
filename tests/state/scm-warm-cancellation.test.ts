import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRepoRootMock = vi.fn();
const gitSummaryMock = vi.fn();
const cancelGitStatusMock = vi.fn(async (_taskId: number) => {});

vi.mock("$lib/api/git", () => ({
  gitRepoRoot: (path: string) => gitRepoRootMock(path),
  gitSummary: (root: string, taskId: number) => gitSummaryMock(root, taskId),
  cancelGitStatus: (taskId: number) => cancelGitStatusMock(taskId),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  gitDiscard: vi.fn(),
  gitCommit: vi.fn(),
  gitWatchRepo: vi.fn(),
  gitUnwatchRepo: vi.fn(),
}));
vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: vi.fn(async () => {}),
  notifyLocalGitChange: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("SCM root warmer ownership", () => {
  it("registers its owned summary scan before the caller can release it", async () => {
    const response = deferred<{ ok: false; error: string }>();
    gitSummaryMock.mockReturnValue(response.promise);
    const { warmScmSummaryForRoot } = await import("$lib/state/scm.svelte");
    const { releaseGitSummaryConsumer } = await import("$lib/state/git-summary-cache");

    const warm = warmScmSummaryForRoot("/repo", "git-warm:/repo");
    expect(gitRepoRootMock).not.toHaveBeenCalled();
    expect(gitSummaryMock).toHaveBeenCalledOnce();
    const taskId = gitSummaryMock.mock.calls[0][1];

    releaseGitSummaryConsumer("git-warm:/repo");
    expect(cancelGitStatusMock).toHaveBeenCalledWith(taskId);

    response.resolve({ ok: false, error: "cancelled" });
    await warm;
  });
});
