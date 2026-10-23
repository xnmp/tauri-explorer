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
    expect(prWorkflows.sort()).toEqual(["ci.yml", "e2e-tauri.yml"]);

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
    // A shared group also replaces pending runs when cancellation is false.
    // Heavy-only workflows must leave every dev commit free to queue.
    expect(workflow.concurrency).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job).not.toHaveProperty("concurrency");
      expect(job).not.toHaveProperty("if");
    }
  });

  it.each(["ci.yml", "e2e-tauri.yml"])(
    "cancels superseded PRs in %s without grouping dev commits together",
    (file) => {
      const workflow = load(file);
      expect(workflow.on.push.branches).toContain("dev");
      expect(workflow.on.push.paths).toBeUndefined();
      expect(workflow.concurrency).toEqual({
        group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      });
      for (const job of Object.values(workflow.jobs)) {
        expect(job).not.toHaveProperty("concurrency");
      }
    },
  );
});

describe("release and nightly coverage (#1367)", () => {
  it("runs CI on main pushes and nightly, but not on PRs into main", () => {
    const ci = load("ci.yml");
    expect(ci.on.push.branches).toEqual(["dev", "main"]);
    expect(ci.on.schedule).toHaveLength(1);
    // The nightly run executes every target rather than replaying the cache.
    expect(ci.env.TEST_CACHE_READ).toContain("github.event_name != 'schedule'");
    // A release instead requires the dev push CI of the same tree.
    expect(load("release.yml").jobs["version-check"].needs).toBe("dev-ci-gate");
  });
});

describe.each(["ci.yml", "e2e-tauri.yml"])("%s docs-only filter", (file) => {
  const filter = () => {
    const step = load(file).jobs.changes.steps.find((s: { id?: string }) => s.id === "filter");
    return parse(step.with.filters).code as string[];
  };

  it("treats screenshots and evidence as documentation", () => {
    expect(filter()).toEqual(expect.arrayContaining(["!screenshots/**", "!evidence/**", "!docs/**", "!**/*.md"]));
    expect(filter()[0]).toBe("**");
  });

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
