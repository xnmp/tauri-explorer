import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// Merge queue readiness (#1133). A queued PR gets no status from a workflow
// without `merge_group`, so it never merges; and merge_group ignores
// trigger-level `paths`, so path-filtered workflows re-apply theirs in a job.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github/workflows");

// Neither produces a check a dev PR must pass: image-crop is a PR-only codec
// probe and shared-ai-services runs its only job on workflow_dispatch.
const NOT_QUEUED = new Set(["image-crop.yml", "shared-ai-services.yml"]);

type Job = { needs?: string | string[]; if?: string; steps?: { uses?: string; with?: { patterns?: string } }[] };
type Workflow = { on: Record<string, { paths?: string[] } | null>; jobs: Record<string, Job> };

function workflows(): [string, Workflow][] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, parse(readFileSync(join(workflowsDir, name), "utf8")) as Workflow]);
}

const queued = () => workflows().filter(([name, wf]) => "pull_request" in wf.on && !NOT_QUEUED.has(name));

describe("merge queue triggers", () => {
  it("every workflow that runs on pull requests also reports in the merge queue", () => {
    const missing = queued()
      .filter(([, wf]) => !("merge_group" in wf.on))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("path-filtered queue workflows apply exactly their pull_request paths to merge groups", () => {
    for (const [name, wf] of queued()) {
      const paths = wf.on.pull_request?.paths;
      if (!paths) continue;
      const filter = wf.jobs.changes?.steps?.find((step) => step.uses === "./.github/actions/merge-group-paths");
      expect(filter, `${name} merge_group path filter`).toBeDefined();
      const patterns = filter!.with!.patterns!.split("\n").filter(Boolean);
      expect(patterns, name).toEqual(paths);
    }
  });

  it("gates every path-filtered job on the filter, running it when the filter fails", () => {
    const gate = "${{ !cancelled() && (github.event_name != 'merge_group' || needs.changes.outputs.run != 'false') }}";
    for (const [name, wf] of queued()) {
      if (!wf.on.pull_request?.paths) continue;
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (id === "changes") continue;
        expect(job.needs, `${name}:${id}`).toBe("changes");
        expect(job.if, `${name}:${id}`).toBe(gate);
      }
    }
  });
});

describe("merge-group-paths action", () => {
  const action = parse(readFileSync(join(root, ".github/actions/merge-group-paths/action.yml"), "utf8")) as {
    runs: { steps: { run: string }[] };
  };
  const script = action.runs.steps[0].run;
  let repo: string;
  let base: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

  function commit(files: string[]) {
    for (const file of files) {
      mkdirSync(join(repo, dirname(file)), { recursive: true });
      writeFileSync(join(repo, file), file);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
  }

  function run(patterns: string, baseSha = base): string {
    const output = join(repo, ".output");
    writeFileSync(output, "");
    execFileSync("bash", ["-c", script], {
      cwd: repo,
      stdio: "pipe",
      env: { ...process.env, BASE_SHA: baseSha, PATTERNS: patterns, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "/dev/null" },
    });
    return readFileSync(output, "utf8").trim();
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "merge-group-paths-"));
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    base = git("rev-parse", "HEAD");
    git("remote", "add", "origin", `file://${repo}`);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports a change under a recursive pattern", () => {
    commit(["src-tauri/src/deep/a.rs"]);
    expect(run("src-tauri/**\n.github/workflows/x.yml")).toBe("changed=true");
  });

  it("matches exact files and single-segment globs", () => {
    commit(["scripts/run-native-soak.mjs"]);
    expect(run("package.json\nscripts/*native*")).toBe("changed=true");
  });

  it("reports no change when nothing matches", () => {
    commit(["docs/notes.md", "e2e-tauri/sub/macos-ui.ts"]);
    expect(run("src-tauri/**\ne2e-tauri/macos-*.ts")).toBe("changed=false");
  });

  it("reports no change for an empty diff, even with a match-anything pattern", () => {
    commit([]);
    expect(run("*\n\n")).toBe("changed=false");
  });

  it("fails rather than reporting no change when the base cannot be diffed", () => {
    commit(["src-tauri/a.rs"]);
    expect(() => run("src-tauri/**", "0".repeat(40))).toThrow();
  });
});
