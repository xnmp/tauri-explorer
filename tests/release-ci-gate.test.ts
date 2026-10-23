import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { candidateCommits, combine, judgeCommit, NATIVE_REQUIRED_JOB } from "../scripts/release-ci-gate.mjs";

const REPO = "xnmp/tauri-explorer";
const run = (id: number, path: string, over: Record<string, unknown> = {}) => ({
  id, path, event: "push", head_branch: "dev", head_sha: "abc", status: "completed", conclusion: "success",
  head_repository: { full_name: REPO }, ...over,
});
const ci = (over = {}) => run(1, ".github/workflows/ci.yml", over);
const native = (over = {}) => run(2, ".github/workflows/e2e-tauri.yml", over);
const jobs = (conclusion: string | null, status = "completed") => () =>
  [{ name: NATIVE_REQUIRED_JOB, status, conclusion }, { name: "smoke (windows-latest)", status: "completed", conclusion: "failure" }];

describe("candidateCommits", () => {
  it("keeps only dev commits with the released tree, newest first", () => {
    expect(candidateCommits("t2", [{ sha: "c3", tree: "t3" }, { sha: "c2", tree: "t2" }, { sha: "c1", tree: "t2" }])).toEqual(["c2", "c1"]);
    expect(candidateCommits("t9", [{ sha: "c1", tree: "t1" }])).toEqual([]);
  });
});

describe("judgeCommit", () => {
  it("passes on successful dev push CI and Linux native smoke, Windows aside", () => {
    expect(judgeCommit([ci(), native()], jobs("success"), REPO).verdict).toBe("pass");
  });

  it.each([
    ["CI failed", [ci({ conclusion: "failure" }), native()], jobs("success"), "fail"],
    ["native smoke failed", [ci(), native()], jobs("failure"), "fail"],
    ["no CI run", [native()], jobs("success"), "fail"],
    ["no native run", [ci()], jobs("success"), "fail"],
    ["CI still running", [ci({ status: "in_progress", conclusion: null }), native()], jobs("success"), "pending"],
    ["only a PR run", [ci({ event: "pull_request" }), native()], jobs("success"), "fail"],
    ["a run on main", [ci({ head_branch: "main" }), native()], jobs("success"), "fail"],
    ["a fork's run", [ci({ head_repository: { full_name: "evil/fork" } }), native()], jobs("success"), "fail"],
  ])("judges %s", (_label, runs, jobsOf, verdict) => {
    expect(judgeCommit(runs, jobsOf, REPO).verdict).toBe(verdict);
  });

  it("passes when a re-run succeeded beside an earlier failure", () => {
    expect(judgeCommit([ci({ conclusion: "failure" }), ci({ id: 3 }), native()], jobs("success"), REPO).verdict).toBe("pass");
  });
});

describe("combine", () => {
  const r = (sha: string, verdict: "pass" | "pending" | "fail") => ({ sha, result: { verdict, reason: verdict } });

  it("refuses a tree no dev commit carries", () => {
    expect(combine([]).verdict).toBe("fail");
  });

  it("passes when any candidate passed, else waits on a pending one", () => {
    expect(combine([r("a", "fail"), r("b", "pass")])).toEqual({ verdict: "pass", reason: "b: pass" });
    expect(combine([r("a", "fail"), r("b", "pending")]).verdict).toBe("pending");
    expect(combine([r("a", "fail"), r("b", "fail")]).verdict).toBe("fail");
  });
});

describe("release.yml", () => {
  const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));

  it("gates reading the version, tagging and building on the dev CI gate", () => {
    expect(release.jobs["version-check"].needs).toBe("dev-ci-gate");
    expect(release.jobs.build.needs).toBe("version-check");
    expect(release.jobs.release.needs).toEqual(["version-check", "build"]);
    const gate = release.jobs["dev-ci-gate"];
    expect(gate.permissions).toEqual({ contents: "read", actions: "read" });
    expect(gate.steps.at(-1).run).toContain("node scripts/release-ci-gate.mjs");
    expect(gate.steps.at(-1).run).toContain("refs/remotes/origin/dev");
  });

  it("keeps the main-push trigger and the tag/version flow", () => {
    expect(release.on).toEqual({ push: { branches: ["main"] } });
    expect(release.jobs.build.if).toBe("needs.version-check.outputs.tag_exists == 'false'");
  });
});
