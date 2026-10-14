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

// image-crop is a non-required, PR-only codec probe.
const NOT_QUEUED = new Set(["image-crop.yml"]);

type Job = { needs?: string | string[]; if?: string; steps?: { uses?: string; with?: { patterns?: string } }[] };
type Workflow = { on: Record<string, { paths?: string[]; branches?: string[] } | null>; jobs: Record<string, Job> };

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

  it("path-filtered queue workflows apply exactly their push paths to merge groups", () => {
    for (const [name, wf] of queued()) {
      const filter = wf.jobs.changes?.steps?.find((step) => step.uses === "./.github/actions/merge-group-paths");
      if (!filter) continue;
      const paths = wf.on.push?.paths;
      expect(paths, `${name} push paths`).toBeDefined();
      const patterns = filter.with!.patterns!.split("\n").filter(Boolean);
      expect(patterns, name).toEqual(paths);
    }
  });

  it("never gives two queue workflows' jobs the same check name", () => {
    // A matrix job skipped by its `if` reports its bare job name, so a shared
    // name could stand in for a required check from another workflow.
    const owners = new Map<string, string[]>();
    for (const [name, wf] of queued()) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (id === "changes") continue;
        const check = (job as { name?: string }).name?.replace(/ \(\$\{\{.*$/, "") ?? id;
        owners.set(check, [...(owners.get(check) ?? []), name]);
      }
    }
    const shared = [...owners].filter(([, files]) => files.length > 1);
    expect(shared).toEqual([]);
  });

  it("gates every path-filtered job on the filter, running it when the filter fails", () => {
    const gate =
      "${{ !cancelled() && github.event_name != 'pull_request' && (github.event_name != 'merge_group' || needs.changes.outputs.run != 'false') }}";
    for (const [name, wf] of queued()) {
      if (!wf.jobs.changes?.steps?.some((step) => step.uses === "./.github/actions/merge-group-paths")) continue;
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (id === "changes" || [job.needs].flat().length > 1) continue;
        expect(job.needs, `${name}:${id}`).toBe("changes");
        expect(job.if, `${name}:${id}`).toBe(gate);
      }
    }
  });
});

// Queue tier (#1133): suites too slow or too scarce (macOS, Windows) to run on
// every PR push. They run in the merge queue, on dev and on demand.
const QUEUE_TIER: Record<string, string[]> = {
  "e2e-tauri.yml": ["tauri-smoke"],
  "macos-smoke.yml": ["launch-smoke"],
  "macos-native-ui.yml": ["native-ui"],
  "rust-platforms.yml": ["rust-platforms-suite", "rust-platforms"],
  "native-recovery.yml": ["recovery"],
  "windows-soak.yml": ["bounded-soak"],
  "windows-installer.yml": ["invocation"],
  "perf.yml": ["perf-check", "tiles-scroll-perf"],
};
const SKIPS_PRS = "github.event_name != 'pull_request'";

describe("cheap and expensive tiers", () => {
  const byName = new Map(workflows());

  it.each(Object.entries(QUEUE_TIER))("%s runs its queue-tier jobs everywhere but pull requests", (file, jobs) => {
    const wf = byName.get(file)!;
    for (const id of jobs) expect(wf.jobs[id]?.if, `${file}:${id}`).toContain(SKIPS_PRS);
    expect(wf.on).toHaveProperty("merge_group");
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect((wf.on.push as { branches?: string[] }).branches).toContain("dev");
    // Unfiltered, so each job posts its skipped (passing) check on every PR
    // and the ruleset can require it in the merge queue without blocking PRs.
    expect(wf.on.pull_request?.paths, file).toBeUndefined();
  });

  it("keeps the cheap tier on every pull request", () => {
    const perPr = [
      ...Object.entries(byName.get("ci.yml")!.jobs),
      ["smoke", byName.get("e2e-tauri.yml")!.jobs.smoke] as const,
    ];
    for (const [id, job] of perPr) expect(job.if ?? "", id).not.toContain(SKIPS_PRS);
  });

  it("builds only the Linux smoke for a pull request", () => {
    const os = (byName.get("e2e-tauri.yml")!.jobs.smoke as { strategy: { matrix: { os: string } } }).strategy.matrix.os;
    expect(os.startsWith(`\${{ fromJSON(github.event_name == 'pull_request' && '["ubuntu-latest"]' ||`)).toBe(true);
    expect(os).toContain(`'["ubuntu-latest","windows-latest"]'`);
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
