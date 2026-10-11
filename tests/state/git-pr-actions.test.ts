import { describe, expect, it, vi } from "vitest";
import { createGitPrSession } from "$lib/state/git-pr-session.svelte";
import type { OpenPr } from "$lib/api/git-log";

const pr: OpenPr = { number: 7, title: "Feature", headRef: "feature", baseRef: "main", htmlUrl: "https://github.com/o/r/pull/7", draft: false, ciStatus: null, reviewDecision: "approved", commentCount: 0 };
const action = { action: "approve", prNumber: 7 } as const;
function fixture(mutate = vi.fn(async () => "")) {
  const openPrs = vi.fn(async () => [pr]);
  const session = createGitPrSession("/repo", { openPrs, failedChecks: async () => [], checkLog: async () => ({ checkName: "", log: "" }), mutate });
  return { session, openPrs, mutate };
}

describe("graph PR actions", () => {
  it("reports creation URL and refreshes badges after success", async () => {
    const f = fixture(vi.fn(async () => pr.htmlUrl));
    await f.session.performAction({ action: "create", headBranch: "feature", title: "Feature", body: "Details", base: "main" });
    expect(f.session.actionResult).toEqual({ action: "create", output: pr.htmlUrl });
    expect(f.session.prsByBranch.get("feature")?.number).toBe(7);
    expect(f.openPrs).toHaveBeenCalledWith("/repo");
    expect(f.session.actionBusy).toBe(false);
  });
  it("prevents duplicate submissions and keeps pending state until badges refresh", async () => {
    let finish!: (value: string) => void;
    const f = fixture(vi.fn(() => new Promise<string>(resolve => { finish = resolve; })));
    const first = f.session.performAction(action);
    expect(f.session.actionBusy).toBe(true);
    await f.session.performAction(action);
    expect(f.mutate).toHaveBeenCalledTimes(1);
    finish("");
    await first;
    expect(f.session.actionResult?.action).toBe("approve");
    expect(f.session.actionBusy).toBe(false);
  });
  it("surfaces CLI errors without success and allows a retry", async () => {
    const f = fixture(vi.fn(async () => { throw new Error("gh auth login required"); }));
    await f.session.performAction(action);
    expect(f.session.actionError).toBe("gh auth login required");
    expect(f.session.actionResult).toBeNull();
    expect(f.session.actionBusy).toBe(false);
    f.mutate.mockResolvedValue("");
    await f.session.performAction(action);
    expect(f.session.actionError).toBeNull();
    expect(f.session.actionResult?.action).toBe("approve");
  });
  it("closes removed PR details after merge and refreshes changed approvals", async () => {
    const f = fixture();
    await f.session.openDetail("oid", { ...pr, reviewDecision: "review_required" });
    await f.session.performAction(action);
    expect(f.session.prDetail?.pr.reviewDecision).toBe("approved");
    f.openPrs.mockResolvedValue([]);
    await f.session.performAction({ action: "merge", prNumber: 7, method: "squash" });
    expect(f.session.prsByBranch.size).toBe(0);
    expect(f.session.prDetail).toBeNull();
  });
  it("does not publish results after the pane is disposed", async () => {
    let finish!: (value: string) => void;
    const f = fixture(vi.fn(() => new Promise<string>(resolve => { finish = resolve; })));
    const pending = f.session.performAction(action);
    f.session.dispose();
    finish("");
    await pending;
    expect(f.session.actionResult).toBeNull();
    expect(f.openPrs).not.toHaveBeenCalled();
  });
});
