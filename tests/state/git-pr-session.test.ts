import { describe, expect, it, vi } from "vitest";
import { createGitPrSession } from "$lib/state/git-pr-session.svelte";
import type { FailedCiCheck, FailedCiCheckLog, OpenPr } from "$lib/api/git-log";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const pr = (number: number, headRef = `branch-${number}`): OpenPr => ({
  number,
  title: `PR ${number}`,
  headRef,
  baseRef: "main",
  htmlUrl: `https://github.com/example/repo/pull/${number}`,
  draft: false,
  ciStatus: "failure",
  reviewDecision: null,
  commentCount: 0,
});

const check = (jobId: number): FailedCiCheck => ({ name: `check-${jobId}`, runId: 1, jobId });

function fixture() {
  const badgeRequests: ReturnType<typeof deferred<OpenPr[]>>[] = [];
  const checksRequests: ReturnType<typeof deferred<FailedCiCheck[]>>[] = [];
  const logRequests: ReturnType<typeof deferred<FailedCiCheckLog>>[] = [];
  const session = createGitPrSession("/repo", {
    openPrs: vi.fn(() => {
      const request = deferred<OpenPr[]>();
      badgeRequests.push(request);
      return request.promise;
    }),
    failedChecks: vi.fn(() => {
      const request = deferred<FailedCiCheck[]>();
      checksRequests.push(request);
      return request.promise;
    }),
    checkLog: vi.fn(() => {
      const request = deferred<FailedCiCheckLog>();
      logRequests.push(request);
      return request.promise;
    }),
  });
  return { session, badgeRequests, checksRequests, logRequests };
}

describe("git PR session", () => {
  it("keeps the newest same-repository badge reload when responses reverse", async () => {
    const f = fixture();
    const oldReload = f.session.reloadBadges();
    const newReload = f.session.reloadBadges();
    f.badgeRequests[1].resolve([pr(2, "new")]);
    await newReload;
    f.badgeRequests[0].resolve([pr(1, "old")]);
    await oldReload;

    expect([...f.session.prsByBranch.keys()]).toEqual(["new"]);
  });

  it("does not let a closed and reopened PR accept old checks or old finally", async () => {
    const f = fixture();
    const target = pr(7);
    const oldOpen = f.session.openDetail("old-oid", target);
    f.session.closeDetail();
    const newOpen = f.session.openDetail("new-oid", target);

    f.checksRequests[0].resolve([check(1)]);
    await oldOpen;
    expect(f.session.prDetail?.oid).toBe("new-oid");
    expect(f.session.failedCiChecksLoading).toBe(true);
    expect(f.session.failedCiChecks).toBeNull();

    f.checksRequests[1].resolve([check(2)]);
    await newOpen;
    expect(f.session.failedCiChecks?.checks).toEqual([check(2)]);
    expect(f.session.failedCiChecksLoading).toBe(false);
  });

  it("keeps check-log results attached to the current request", async () => {
    const f = fixture();
    const target = pr(8);
    const opening = f.session.openDetail("oid", target);
    f.checksRequests[0].resolve([check(1), check(2)]);
    await opening;
    const oldLog = f.session.openCheckLog(target, check(1));
    const newLog = f.session.openCheckLog(target, check(2));
    f.logRequests[1].resolve({ checkName: "check-2", log: "new" });
    await newLog;
    f.logRequests[0].resolve({ checkName: "check-1", log: "old" });
    await oldLog;

    expect(f.session.ciCheckLog?.result?.log).toBe("new");
    f.session.closeCheckLog();
    expect(f.session.ciCheckLog).toBeNull();
  });

  it("publishes errors only for the current PR identity", async () => {
    const f = fixture();
    const oldOpen = f.session.openDetail("one", pr(1));
    const newOpen = f.session.openDetail("two", pr(2));
    f.checksRequests[0].reject(new Error("old failure"));
    await oldOpen;
    expect(f.session.failedCiChecksLoading).toBe(true);
    f.checksRequests[1].reject(new Error("current failure"));
    await newOpen;

    expect(f.session.failedCiChecks).toMatchObject({ prNumber: 2, error: "current failure" });
    expect(f.session.failedCiChecksLoading).toBe(false);
  });

  it("disposal revokes badge, checks, logs, and loading publication", async () => {
    const f = fixture();
    const badges = f.session.reloadBadges();
    const details = f.session.openDetail("oid", pr(3));
    const log = f.session.openCheckLog(pr(3), check(3));
    f.session.dispose();
    f.badgeRequests[0].resolve([pr(3)]);
    f.checksRequests[0].resolve([check(3)]);
    f.logRequests[0].resolve({ checkName: "check-3", log: "late" });
    await Promise.all([badges, details, log]);

    expect(f.session.prsByBranch.size).toBe(0);
    expect(f.session.prDetail).toBeNull();
    expect(f.session.failedCiChecks).toBeNull();
    expect(f.session.failedCiChecksLoading).toBe(false);
    expect(f.session.ciCheckLog).toBeNull();
  });

  it("does not request checks for a healthy PR or start work after disposal", async () => {
    const f = fixture();
    const healthy = { ...pr(4), ciStatus: "success" as const };
    await f.session.openDetail("healthy", healthy);
    expect(f.checksRequests).toHaveLength(0);
    expect(f.session.failedCiChecksLoading).toBe(false);

    f.session.dispose();
    await f.session.reloadBadges();
    await f.session.openDetail("late", pr(5));
    await f.session.openCheckLog(pr(5), check(5));
    expect(f.badgeRequests).toHaveLength(0);
    expect(f.checksRequests).toHaveLength(0);
    expect(f.logRequests).toHaveLength(0);
  });

  it("snapshots caller and dependency values before exposing them", async () => {
    const f = fixture();
    const input = {
      ...pr(7, "owned"),
      comments: [{ author: "a", createdAt: "2024-01-01T00:00:00Z", body: "comment" }],
      reviewThreads: [{ resolved: false, comments: [{ author: "b", createdAt: "2024-01-01T00:00:00Z", body: "review", path: "x", line: 1 }] }],
    };
    const opening = f.session.openDetail("oid", input);
    input.number = 8;
    f.checksRequests[0].resolve([check(7)]);
    await opening;

    expect(f.session.prDetail?.pr.number).toBe(7);
    expect(f.session.failedCiChecks?.prNumber).toBe(7);
    expect(() => (f.session.prDetail?.pr.comments as unknown[]).push({})).toThrow();
    expect(() => (f.session.prDetail?.pr.reviewThreads?.[0].comments as unknown[]).push({})).toThrow();

    const badges = f.session.reloadBadges();
    const returned = pr(9, "badge");
    f.badgeRequests[0].resolve([returned]);
    await badges;
    returned.title = "mutated";
    const exposed = f.session.prsByBranch as Map<string, OpenPr>;
    exposed.clear();
    expect(f.session.prsByBranch.get("badge")?.title).toBe("PR 9");
  });
});
