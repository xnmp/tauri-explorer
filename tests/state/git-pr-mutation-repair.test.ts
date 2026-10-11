import { expect, it, vi } from "vitest";
import { createGitPrSession } from "$lib/state/git-pr-session.svelte";
import type { OpenPr } from "$lib/api/git-log";

const approval = { action: "approve", repoSlug: "repair/example", prNumber: 15 } as const;
const pr: OpenPr = { number: 15, title: "Repair", headRef: "feature", baseRef: "dev", htmlUrl: "https://github.com/repair/example/pull/15", draft: false, ciStatus: null, reviewDecision: "approved", commentCount: 0 };
const checks = { failedChecks: async () => [], checkLog: async () => ({ checkName: "", log: "" }) };

it("retains pending work and its outcome across disposal/remount without another command", async () => {
  let resolve!: (output: string) => void;
  const mutate = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const oldRead = vi.fn(async () => [pr]);
  const first = createGitPrSession("/repair/remount", { ...checks, mutate, openPrs: oldRead });
  const operation = first.performAction(approval);
  first.dispose();
  const freshRead = vi.fn(async () => [pr]);
  const next = createGitPrSession("/repair/remount", { ...checks, mutate, openPrs: freshRead });
  expect(next.actionBusy).toBe(true);
  await next.performAction(approval);
  expect(mutate).toHaveBeenCalledTimes(1);
  resolve("");
  await operation;
  expect(next.actionBusy).toBe(false);
  expect(next.actionResult?.action).toBe("approve");
  expect(next.prsByBranch.get("feature")?.reviewDecision).toBe("approved");
  expect(oldRead).not.toHaveBeenCalled();
  expect(freshRead).toHaveBeenCalledTimes(1);
  next.dispose();
  const later = createGitPrSession("/repair/remount", { ...checks, mutate, openPrs: async () => [pr] });
  expect(later.actionResult?.action).toBe("approve");
  later.dispose();
});

it("retains a late failure across remount and requires acknowledgement before uncertain retry", async () => {
  let reject!: (error: unknown) => void;
  const mutate = vi.fn(() => new Promise<string>((_, fail) => { reject = fail; }));
  const first = createGitPrSession("/repair/uncertain", { ...checks, mutate, openPrs: async () => [] });
  const operation = first.performAction(approval);
  first.dispose();
  const freshRead = vi.fn(async () => [pr]);
  const next = createGitPrSession("/repair/uncertain", { ...checks, mutate, openPrs: freshRead });
  reject({ kind: "pr_mutation_uncertain", message: "GitHub may have applied the approval; check before retrying" });
  await operation;
  expect(next.actionResult).toBeNull();
  expect(next.actionError).toContain("may have applied");
  expect(next.actionUncertain).toBe(true);
  expect(next.prsByBranch.get("feature")?.reviewDecision).toBe("approved");
  await next.performAction(approval);
  expect(mutate).toHaveBeenCalledTimes(1);
  mutate.mockResolvedValue("");
  await next.performAction(approval, true);
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(next.actionUncertain).toBe(false);
  expect(next.actionResult?.action).toBe("approve");
  next.dispose();
});

it("shares pending admission between simultaneously mounted graph panes", async () => {
  let resolve!: (output: string) => void;
  const mutate = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const deps = { ...checks, mutate, openPrs: async () => [] };
  const first = createGitPrSession("/repair/two-panes", deps);
  const second = createGitPrSession("/repair/two-panes", deps);
  const operation = first.performAction(approval);
  await second.performAction(approval);
  expect(mutate).toHaveBeenCalledTimes(1);
  resolve("");
  await operation;
  expect(second.actionResult?.action).toBe("approve");
  first.dispose(); second.dispose();
});
