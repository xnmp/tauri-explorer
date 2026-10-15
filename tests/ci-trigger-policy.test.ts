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
    expect(ci.on.pull_request.branches).toContain("dev");
    expect(ci.on.pull_request.paths).toBeUndefined();
    expect(ci.on.pull_request["paths-ignore"]).toBeUndefined();
    expect(Object.keys(ci.jobs)).toEqual(expect.arrayContaining([
      "frontend-checks", "chromium", "webkit-tests", "rust-suite",
      "frontend", "webkit", "rust", "code-maps",
    ]));
    expect(ci.jobs["frontend-checks"].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: "bun run check" }),
      expect.objectContaining({ run: "bun run lint:arch" }),
      expect.objectContaining({ run: "bun run test" }),
    ]));
    expect(ci.jobs["rust-suite"].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: "cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check" }),
      expect.objectContaining({ run: expect.stringContaining("cargo clippy ") }),
      expect.objectContaining({ run: expect.stringContaining("cargo test ") }),
    ]));
    const native = load("e2e-tauri.yml");
    expect(native.on.pull_request.branches).toContain("dev");
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
