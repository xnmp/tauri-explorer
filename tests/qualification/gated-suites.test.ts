import { describe, expect, it } from "vitest";
import {
  gatedMode,
  missingPrerequisite,
  requireGatedFromEnvironment,
} from "../../e2e-tauri/gated-suites";

describe("gated native suites", () => {
  it("runs a suite whose prerequisites are all present", () => {
    const missing = missingPrerequisite([[true, "Linux"], [true, "TAURI_E2E_FILE_RECOVERY_DIR"]]);
    expect(missing).toBeNull();
    expect(gatedMode(missing, true)).toBe("run");
    expect(gatedMode(missing, false)).toBe("run");
  });

  it("names the first missing prerequisite", () => {
    expect(missingPrerequisite([
      [true, "Linux"],
      [false, "TAURI_E2E_MOVE_SOURCE_DIR"],
      [false, "TAURI_E2E_MOVE_TARGET_DIR"],
    ])).toBe("TAURI_E2E_MOVE_SOURCE_DIR");
  });

  it("skips a suite missing prerequisites unless the job requires gated suites", () => {
    expect(gatedMode("TAURI_E2E_HISTORY_GATE_DIR", false)).toBe("skip");
    // A skipped spec file counts as passed, so the dedicated job must fail.
    expect(gatedMode("TAURI_E2E_HISTORY_GATE_DIR", true)).toBe("fail");
  });

  it("requires gated suites only for the exact opt-in value", () => {
    expect(requireGatedFromEnvironment({ TAURI_E2E_REQUIRE_GATED: "1" })).toBe(true);
    expect(requireGatedFromEnvironment({ TAURI_E2E_REQUIRE_GATED: "true" })).toBe(false);
    expect(requireGatedFromEnvironment({ TAURI_E2E_REQUIRE_GATED: "" })).toBe(false);
    expect(requireGatedFromEnvironment({})).toBe(false);
  });

  it("treats an empty requirement list as runnable", () => {
    expect(missingPrerequisite([])).toBeNull();
  });
});
