import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = new URL(
  "../../.github/workflows/e2e-tauri.yml",
  import.meta.url,
);
const cacheAdrPath = new URL(
  "../../docs/adr/0022-native-qualification-cache-lifecycle.md",
  import.meta.url,
);

type WorkflowStep = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  "continue-on-error"?: boolean;
};

async function qualificationSteps(): Promise<WorkflowStep[]> {
  const workflow = parse(await readFile(workflowPath, "utf8")) as {
    jobs: { smoke: { steps: WorkflowStep[] } };
  };

  return workflow.jobs.smoke.steps;
}

function stepNamed(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);

  expect(step, `workflow step ${name}`).toBeDefined();
  return step!;
}

describe("native qualification workflow cache and diagnostics (#694)", () => {
  it("publishes contract diagnostics before GUI qualification", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const steps = await qualificationSteps();

    const contracts = stepNamed(steps, "Run native contracts");
    const diagnostics = stepNamed(steps, "Upload native contract diagnostics");
    const collection = stepNamed(steps, "Collect native qualification diagnostics");
    const build = stepNamed(
      steps,
      "Build Tauri binary (debug, embedded frontend, no bundle)",
    );
    const gui = stepNamed(steps, "Run smoke suite (Linux, isolated display and window manager)");

    expect(contracts["continue-on-error"]).toBe(true);
    expect(diagnostics.if).toBe("always()");
    expect(steps.indexOf(diagnostics)).toBeGreaterThan(steps.indexOf(build));
    expect(steps.indexOf(diagnostics)).toBeLessThan(steps.indexOf(gui));
    expect(workflow).toContain("native-contract-diagnostics-${{ matrix.os }}");
    expect(workflow).toContain("target_cache_key=");
    expect(workflow).toContain("cargo_registry_cache_key=");
    expect(workflow).toContain("cache_storage_bytes=");
    expect(workflow).toContain("cache_transfer_estimate_bytes=");
    expect(collection.run).toContain(
      'for cache_path in src-tauri/target "$CARGO_HOME/registry" "$CARGO_HOME/git"',
    );
    expect(collection.run).toContain('if [ -d "$cache_path" ]; then');
  });

  it("reuses only compatible Rust build products and saves them after GUI failures", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const steps = await qualificationSteps();
    const save = stepNamed(steps, "Save Rust target cache after native outcome");
    const windowsGui = stepNamed(steps, "Run smoke suite (Windows)");

    expect(workflow).toContain("actions/cache/restore@v6");
    expect(save.uses).toBe("actions/cache/save@v6");
    expect(save.if).toBe(
      "${{ always() && steps.native-contracts.outcome == 'success' && steps.build-tauri-binary.outcome == 'success' }}",
    );
    expect(workflow).toContain("steps.rust-provenance.outputs.cache-key");
    expect(workflow).toContain("cache_save_outcome=");
    expect(workflow).toContain("end_to_end_seconds=");
    expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(windowsGui));
  });

  it("keeps the type, embedded-binary, and real-GUI qualification contracts", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("bun run check:e2e:tauri");
    expect(workflow).toContain("bun run tauri build --debug --no-bundle");
    expect(workflow).toContain("bun run test:e2e:tauri");
  });

  it("keeps PR smoke complete while bounding manual Windows clipboard diagnosis", async () => {
    const workflow = parse(await readFile(workflowPath, "utf8")) as {
      on: {
        workflow_dispatch: {
          inputs: {
            native_scope: { default: string; options: string[] };
            clipboard_runs: { default: number };
          };
        };
      };
      jobs: {
        smoke: {
          strategy: { matrix: { os: string } };
          steps: WorkflowStep[];
        };
      };
    };
    const { native_scope: scope, clipboard_runs: runs } = workflow.on.workflow_dispatch.inputs;
    const windowsGui = stepNamed(workflow.jobs.smoke.steps, "Run smoke suite (Windows)");

    expect(scope).toMatchObject({ default: "all", options: ["all", "clipboard", "transfer"] });
    expect(runs.default).toBe(1);
    expect(workflow.jobs.smoke.strategy.matrix.os).toContain("inputs.native_scope == 'clipboard'");
    expect(workflow.jobs.smoke.strategy.matrix.os).toContain("inputs.native_scope == 'transfer'");
    expect(workflow.jobs.smoke.strategy.matrix.os).toContain(
      '["ubuntu-latest","windows-latest"]',
    );
    expect(windowsGui.run).toContain("^([1-9]|10)$");
    expect(windowsGui.run).toContain("--spec e2e-tauri/specs/context-clipboard.spec.ts");
    expect(windowsGui.run).toContain("--spec e2e-tauri/specs/window-transfer-lifetime.spec.ts");
    expect(windowsGui.run).toContain("bun run test:e2e:tauri");
  });

  it("makes a failed native contract fatal after independent checks finish", async () => {
    const steps = await qualificationSteps();
    const fatalGate = stepNamed(steps, "Fail if native contracts failed");

    expect(fatalGate.if).toBe(
      "${{ always() && steps.native-contracts.outcome == 'failure' }}",
    );
    expect(fatalGate.run).toBe("exit 1");
    expect(steps.indexOf(fatalGate)).toBeGreaterThan(
      steps.indexOf(stepNamed(steps, "Run smoke suite (Windows)")),
    );
  });

  it("records the native target-cache lifecycle in an ADR", async () => {
    const adr = await readFile(cacheAdrPath, "utf8");

    expect(adr).toContain("Governs: \`.github/workflows/e2e-tauri.yml\`");
    expect(adr).toContain("compiler identity");
    expect(adr).toContain("GUI failure");
    expect(adr).toContain("contract or build failure");
  });
});

describe("bounded Windows native soak (#809)", () => {
  it("runs one reproducible cycle of the verified binary and retains failure evidence", async () => {
    const workflow = parse(await readFile(new URL(
      "../../.github/workflows/windows-soak.yml", import.meta.url,
    ), "utf8"));
    const job = workflow.jobs["bounded-soak"];
    expect(job["runs-on"]).toBe("windows-latest");
    const steps = job.steps as Array<WorkflowStep & {
      env?: Record<string, string>;
      with?: { path?: string };
      "timeout-minutes"?: number;
    }>;
    const build = steps.find(step => step.run === "bun run build:native:qualification");
    const run = steps.find(step => step.run === "bun run test:e2e:tauri:soak");
    expect(build).toBeDefined();
    expect(run).toBeDefined();
    expect(steps.indexOf(build!)).toBeLessThan(steps.indexOf(run!));
    expect(run!.env).toMatchObject({
      SOAK_MAX_CYCLES: "1",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
      VITE_E2E_NO_WARM_PRIME: "1",
    });
    expect(run!.env!.SOAK_SEED).toMatch(/^[a-z0-9-]+$/);
    expect(Number(run!.env!.SOAK_DURATION_MS)).toBeGreaterThan(0);
    expect(run!["timeout-minutes"]).toBeGreaterThan(0);
    expect(run!["timeout-minutes"]).toBeLessThanOrEqual(10);
    expect(run!["continue-on-error"]).not.toBe(true);
    const upload = steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path?.split("\n")).toEqual(expect.arrayContaining([
      "qualification-results/", "e2e-tauri/logs/", "logs/",
    ]));
  });
});
