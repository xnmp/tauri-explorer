import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowPath = new URL(
  "../../.github/workflows/e2e-tauri.yml",
  import.meta.url,
);

describe("native qualification workflow cache and diagnostics (#694)", () => {
  it("publishes contract diagnostics before GUI qualification", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    const contracts = workflow.indexOf("name: Run native contracts");
    const diagnostics = workflow.indexOf(
      "name: Upload native contract diagnostics",
    );
    const gui = workflow.indexOf("name: Run smoke suite (Linux, under Xvfb)");

    expect(contracts).toBeGreaterThan(-1);
    expect(diagnostics).toBeGreaterThan(contracts);
    expect(diagnostics).toBeLessThan(gui);
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("native-contract-diagnostics-${{ matrix.os }}");
    expect(workflow).toContain("target_cache_key=");
    expect(workflow).toContain("cargo_registry_cache_key=");
    expect(workflow).toContain("cache_storage_bytes=");
  });

  it("reuses only compatible Rust build products and saves them after GUI failures", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("actions/cache/restore@v6");
    expect(workflow).toContain("actions/cache/save@v6");
    expect(workflow).toContain("steps.rust-provenance.outputs.cache-key");
    expect(workflow).toContain("steps.native-contracts.outcome == 'success'");
    expect(workflow).toContain("steps.build-tauri-binary.outcome == 'success'");
    expect(workflow).toContain("cache_save_outcome=");
    expect(workflow).toContain("end_to_end_seconds=");
    expect(workflow.indexOf("name: Save Rust target cache after native outcome")).toBeGreaterThan(
      workflow.indexOf("name: Run smoke suite (Windows)"),
    );
  });

  it("keeps the type, embedded-binary, and real-GUI qualification contracts", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("bun run check:e2e:tauri");
    expect(workflow).toContain("bun run tauri build --debug --no-bundle");
    expect(workflow).toContain("bun run test:e2e:tauri");
  });
});
