import picomatch from "picomatch";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflows = new URL("../.github/workflows/", import.meta.url);
const load = (file: string) => parse(readFileSync(new URL(file, workflows), "utf8"));
const heavy = [
  "macos-smoke.yml",
  "macos-native-ui.yml",
  "windows-soak.yml",
  "windows-installer.yml",
  "perf.yml",
  "native-recovery.yml",
  "rust-platforms.yml",
];

describe("CI admission policy (#1133)", () => {
  it("admits only CI and Linux native smoke on pull requests", () => {
    const prWorkflows = readdirSync(workflows)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) => {
        const triggers = load(file).on;
        return Object.hasOwn(triggers, "pull_request") ||
          Object.hasOwn(triggers, "pull_request_target");
      });
    expect(prWorkflows.sort()).toEqual(["ci.yml", "e2e-tauri.yml", "release-gate.yml"]);
    // release-gate.yml is the lightweight pre-merge release check for PRs into main (#1367).
    expect(load("release-gate.yml").on).toEqual({ pull_request: { branches: ["main"] } });

    const ci = load("ci.yml");
    expect(ci.on.pull_request.branches).toEqual(["dev"]);
    expect(ci.on.pull_request.paths).toBeUndefined();
    expect(ci.on.pull_request["paths-ignore"]).toBeUndefined();
    expect(Object.keys(ci.jobs)).toEqual(expect.arrayContaining([
      "frontend-checks", "chromium", "webkit-tests", "rust-suite",
      "frontend", "webkit", "rust", "code-maps",
    ]));
    expect(ci.jobs["frontend-checks"].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: "bun run check" }),
      expect.objectContaining({ run: "bun run lint:arch" }),
      // Unit tests and the Rust suite run through the test-result cache (#1176).
      expect.objectContaining({ run: expect.stringContaining("test-cache.mjs run --task ci:unit") }),
    ]));
    expect(ci.jobs["rust-suite"].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.stringContaining("test-cache.mjs run --task ci:rust") }),
    ]));
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
    expect(scripts["ci:unit"]).toBe("bash scripts/ci-test-unit.sh");
    expect(scripts["ci:rust"]).toBe("bash scripts/ci-test-rust.sh");
    const script = (file: string) => readFileSync(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    // PRs may narrow the unit run (#1175); the full suite is still its ALL branch.
    expect(script("ci-test-unit.sh")).toContain("bun run test ;;");
    const rust = script("ci-test-rust.sh");
    expect(rust).toContain('cargo fmt --manifest-path "$manifest" --all -- --check');
    expect(rust).toContain("cargo clippy ");
    expect(rust).toContain("cargo test ");
    const native = load("e2e-tauri.yml");
    expect(native.on.pull_request.branches).toEqual(["dev"]);
    expect(native.on.push).toEqual({ branches: ["dev"] });
    expect(Object.hasOwn(native.on, "workflow_dispatch")).toBe(true);
    // Pin the actual runner admission expression, including the full Windows
    // suite on dev and the existing scoped manual diagnostic runs.
    expect(native.jobs.smoke.strategy.matrix.os).toBe(
      "${{ fromJSON(github.event_name == 'pull_request' && '[\"ubuntu-latest\"]' || ((inputs.native_scope == 'clipboard' || inputs.native_scope == 'transfer') && '[\"windows-latest\"]' || '[\"ubuntu-latest\",\"windows-latest\"]')) }}",
    );
  });

  it.each(heavy)("runs %s on every dev push and manual dispatch", (file) => {
    const workflow = load(file);
    expect(workflow.on.push).toEqual({ branches: ["dev"] });
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(Object.hasOwn(workflow.on, "pull_request")).toBe(false);
    expect(Object.hasOwn(workflow.on, "pull_request_target")).toBe(false);
    for (const job of Object.values(workflow.jobs)) {
      expect(job).not.toHaveProperty("if");
    }
  });

  it.each(["ci.yml", "e2e-tauri.yml"])("runs %s on every dev push and on PRs into dev", (file) => {
    const workflow = load(file);
    expect(workflow.on.push.branches).toContain("dev");
    expect(workflow.on.push.paths).toBeUndefined();
    expect(workflow.on.pull_request.branches).toEqual(["dev"]);
  });
});

// A minimal evaluator for the `${{ }}` expressions concurrency uses: context
// paths, string literals, ==, !=, !, &&, || (GitHub's value-returning
// semantics) and parentheses.
type Context = Record<string, string>;
function evaluate(template: string, context: Context): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_m, source: string) => {
    const tokens = source.match(/'[^']*'|==|!=|&&|\|\||[!()]|[\w.-]+/g) ?? [];
    let at = 0;
    const peek = () => tokens[at];
    const truthy = (v: string | boolean) => v !== "" && v !== false && v !== "false";
    const primary = (): string | boolean => {
      const token = tokens[at++];
      if (token === "(") { const v = or(); expect(tokens[at++]).toBe(")"); return v; }
      if (token === "!") return !truthy(primary());
      if (token.startsWith("'")) return token.slice(1, -1);
      if (!Object.hasOwn(context, token)) throw new Error(`unknown context ${token}`);
      return context[token];
    };
    const equality = () => {
      let v = primary();
      while (peek() === "==" || peek() === "!=") {
        const op = tokens[at++];
        const r = primary();
        v = op === "==" ? String(v) === String(r) : String(v) !== String(r);
      }
      return v;
    };
    const and = () => { let v = equality(); while (peek() === "&&") { at++; const r = equality(); v = truthy(v) ? r : v; } return v; };
    const or = (): string | boolean => { let v = and(); while (peek() === "||") { at++; const r = and(); v = truthy(v) ? v : r; } return v; };
    const value = or();
    expect(at).toBe(tokens.length);
    return String(value);
  });
}

describe("concurrency (#1798)", () => {
  const files = readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file));
  const devPush = files.filter((file) => {
    const push = load(file).on?.push;
    return push !== undefined && (push?.branches ?? []).includes("dev");
  });
  const event = (name: string, ref: string, runId = "42"): Context =>
    ({ "github.workflow": "W", "github.event_name": name, "github.ref": ref, "github.run_id": runId });

  it("covers CI, native smoke and every heavy dev-push suite", () => {
    expect(devPush).toEqual(expect.arrayContaining(["ci.yml", "e2e-tauri.yml", ...heavy]));
  });

  describe.each(devPush)("%s", (file) => {
    const { concurrency, jobs } = load(file);
    const outcome = (context: Context) => ({
      group: evaluate(concurrency.group, context),
      cancel: evaluate(String(concurrency["cancel-in-progress"]), context),
    });

    it("declares one workflow-level group and no job-level groups", () => {
      expect(concurrency.group).toMatch(/^\$\{\{ github\.workflow \}\}-/);
      for (const job of Object.values(jobs)) expect(job).not.toHaveProperty("concurrency");
    });

    it("lets a newer dev push cancel the superseded dev push run", () => {
      const older = outcome(event("push", "refs/heads/dev", "1"));
      const newer = outcome(event("push", "refs/heads/dev", "2"));
      expect(newer.group).toBe(older.group);
      expect(newer.group).toBe("W-dev-push");
      expect(newer.cancel).toBe("true");
    });

    it("keeps PRs grouped by full PR ref, cancelling in progress", () => {
      expect(outcome(event("pull_request", "refs/pull/7/merge"))).toEqual({ group: "W-refs/pull/7/merge", cancel: "true" });
      expect(outcome(event("pull_request", "refs/pull/8/merge")).group).not.toBe(outcome(event("pull_request", "refs/pull/7/merge")).group);
    });

    it.each([
      ["a main push", "push", "refs/heads/main"],
      ["a schedule run", "schedule", "refs/heads/dev"],
      ["a manual dispatch on dev", "workflow_dispatch", "refs/heads/dev"],
      ["a push to another branch", "push", "refs/heads/test/x"],
    ])("gives %s a unique run-ID group that never cancels", (_label, name, ref) => {
      expect(outcome(event(name, ref, "1"))).toEqual({ group: "W-1", cancel: "false" });
      expect(outcome(event(name, ref, "2")).group).toBe("W-2");
    });
  });

  it("leaves releases serialized, never cancelled", () => {
    expect(load("release.yml").concurrency).toEqual({ group: "release", "cancel-in-progress": false });
  });
});

describe("release and nightly coverage (#1367)", () => {
  it("runs CI on main pushes and nightly, but not on PRs into main", () => {
    const ci = load("ci.yml");
    expect(ci.on.push.branches).toEqual(["dev", "main"]);
    expect(ci.on.schedule).toHaveLength(1);
    // The nightly run executes every target rather than replaying the cache.
    expect(ci.env.TEST_CACHE_READ).toContain("github.event_name != 'schedule'");
    // A release instead requires the dev push CI of the same tree.
    expect(load("release.yml").jobs.build.needs).toContain("dev-ci-gate");
  });
});

describe.each(["ci.yml", "e2e-tauri.yml"])("%s docs-only filter", (file) => {
  const filter = () => {
    const step = load(file).jobs.changes.steps.find((s: { id?: string }) => s.id === "filter");
    return parse(step.with.filters).code as string[];
  };

  it("treats screenshots and evidence as documentation", () => {
    expect(filter()).toEqual(expect.arrayContaining(["!screenshots/**", "!evidence/**", "!docs/**", "!*.md"]));
    expect(filter()[0]).toBe("**");
  });

  // dorny/paths-filter matches with picomatch({ dot: true }); with
  // predicate-quantifier "every" a file is code when every pattern accepts it.
  const isCode = (file: string) => filter().every((pattern) => picomatch(pattern, { dot: true })(file));

  it.each(["docs/guide.md", "docs/code-map/map-feature.md", "README.md", "CHANGELOG.md", "screenshots/x/a.png", "evidence/ac-1.png"])(
    "skips heavy jobs for documentation-only %s",
    (file) => { expect(isCode(file)).toBe(false); },
  );

  it.each(["e2e/fixtures/notes.md", "src/lib/domain/help.md", "tests/fixtures/sample.md", ".github/notes/fixture.md", "src/lib/a.ts"])(
    "still treats %s as code (Markdown outside docs/ and the root can be a fixture)",
    (file) => { expect(isCode(file)).toBe(true); },
  );

  it("is safe: no test, script or build input reads screenshots/ or evidence/", () => {
    const readers = ["vite.config.ts", "playwright.config.ts", "package.json", "turbo.json"]
      .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    for (const text of readers.slice(0, 3)) expect(text).not.toMatch(/(screenshots|evidence)\//);
    // Browser specs only write capture proof there; Turborepo's browser and
    // unit targets exclude both trees (tests/test-cache.test.ts).
    const turbo = JSON.parse(readers[3]);
    for (const task of ["ci:unit", "ci:e2e", "ci:rust"]) {
      expect(turbo.tasks[task].inputs).toEqual(expect.arrayContaining(["!evidence/**", "!screenshots/**"]));
    }
  });
});
