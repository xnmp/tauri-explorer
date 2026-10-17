import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessDndAcceptance, assessDndNegativeControl, dndSuite, requiredDndContracts } from "../../e2e-tauri/dnd-acceptance";

const runId = "current-run";
const receipts = () => requiredDndContracts.map(id => ({
  qualificationRunId: runId, suite: dndSuite, title: `[dnd:${id}] actual outcome`,
  passed: true, skipped: false, error: null,
}));

describe("native DnD acceptance cannot be replaced by a green test count", () => {
  it("accepts exactly the required outcomes from a successful invocation", () => {
    expect(assessDndAcceptance(receipts(), runId, 0)).toEqual({
      passed: true, errors: [], completed: [...requiredDndContracts],
    });
  });
  it.each([[], receipts().slice(1)].map(rows => ({ rows })))("rejects empty and partial discovery", ({ rows }) => {
    expect(assessDndAcceptance(rows, runId, 0).passed).toBe(false);
  });
  it.each([
    { skipped: true }, { skipped: undefined }, { passed: false },
    { error: "filesystem unchanged" }, { qualificationRunId: "previous-green-run" },
    { suite: "simulated drag" }, { title: "unrelated move test" },
  ])("rejects invalid acceptance evidence: %j", mutation => {
    const rows = receipts();
    expect(assessDndAcceptance([{ ...rows[0], ...mutation }, ...rows.slice(1)], runId, 0).passed).toBe(false);
  });
  it("rejects a duplicate/retried contract rather than hiding its failed attempt", () => {
    expect(assessDndAcceptance([...receipts(), { ...receipts()[0], passed: false }], runId, 0).passed).toBe(false);
  });
  it("rejects stale files even if every contract passed earlier", () => {
    expect(assessDndAcceptance(receipts(), "new-run", 0).completed).toEqual([]);
  });
  it.each([1, null])("preserves runner failure, including crashes after passing tests: %s", status => {
    expect(assessDndAcceptance(receipts(), runId, status).passed).toBe(false);
  });
  it("rejects malformed receipt rows without accepting missing evidence", () => {
    expect(assessDndAcceptance([null, 42, {}, "green"], runId, 0).passed).toBe(false);
  });
  it("does not let seven passing drag cases hide another failed native outcome", () => {
    expect(assessDndAcceptance([...receipts(), {
      qualificationRunId: runId, suite: "other native contract", passed: false, error: "crash",
    }], runId, 0).passed).toBe(false);
  });
  it("allows unrelated opt-in suites to remain skipped without qualifying a required drag case", () => {
    expect(assessDndAcceptance([...receipts(), {
      qualificationRunId: runId, suite: "optional native contract", passed: false, skipped: true, error: null,
    }], runId, 0).passed).toBe(true);
  });
});

describe("transport negative control must fail for the intended outcome", () => {
  const failed = () => [{ ...receipts()[0], passed: false, error: "Error: drop highlighted its folder but did not move the file" }];
  it("accepts observed suppression and its specific filesystem failure", () => {
    expect(assessDndNegativeControl(failed(), runId, 1, true).passed).toBe(true);
  });
  it.each([
    { rows: receipts(), status: 0, suppressed: true },
    { rows: failed(), status: 1, suppressed: false },
    { rows: failed(), status: null, suppressed: true },
    { rows: [], status: 1, suppressed: true },
    { rows: [{ ...failed()[0], skipped: true }], status: 1, suppressed: true },
    { rows: [{ ...failed()[0], error: "Input fixture never started" }], status: 1, suppressed: true },
  ])("rejects missing, skipped, successful and setup-only controls", ({ rows, status, suppressed }) => {
    expect(assessDndNegativeControl(rows, runId, status, suppressed).passed).toBe(false);
  });
});

describe("native gesture admission", () => {
  it.runIf(process.platform === "linux")("refuses non-private input even when Python assertions are disabled", () => {
    const result = spawnSync("python3", ["-O", fileURLToPath(new URL(
      "../../e2e-tauri/helpers/native-drag.py", import.meta.url,
    )), "0", "0", "10", "10"], {
      encoding: "utf8", env: { ...process.env, DISPLAY: "not-a-private-display", PYTHONOPTIMIZE: "2" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Native input requires a local private display");
  });
});
