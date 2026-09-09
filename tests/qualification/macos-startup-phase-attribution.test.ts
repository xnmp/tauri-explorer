import { describe, expect, it } from "vitest";

import {
  parseAttributedMacStartupLog,
  qualifyHalfBounce,
  summarizeMacStartupPhases,
} from "../../e2e-tauri/native-qualification";

const attributedLog = [
  "Startup(native-window): app-run-epoch-ms=1000.0 window-built=100.0ms",
  "Startup(webview): boot-epoch-ms=1300.0 bundle-exec=50.0ms list-ready=400.0ms ui-ready=450.0ms total=450.0ms",
  "Startup(native-ready): app-run-to-ready=810.0ms receipt-epoch-ms=1800.0",
  "Startup(warm-activate): show=4.0ms",
].join("\n");

describe("macOS startup phase attribution", () => {
  it("reports measured phases and retains the unexplained remainder", () => {
    expect(parseAttributedMacStartupLog(attributedLog)).toEqual({
      coldTotalMs: 810,
      readinessTotalMs: 810,
      warmShowMs: 4,
      phases: {
        frameworkNavigationMs: 300,
        documentBootMs: 50,
        requiredAppWorkMs: 350,
        frameSchedulingMs: 50,
        readinessIpcMs: 50,
        unattributedMs: 10,
      },
      firstFunctionalFrame: "not-observed",
      inputOutcome: "not-verified",
    });
  });

  it("rejects missing and inconsistent observable phase markers", () => {
    expect(() =>
      parseAttributedMacStartupLog(
        attributedLog.replace(" list-ready=400.0ms", ""),
      ),
    ).toThrow("list-ready");
    expect(() =>
      parseAttributedMacStartupLog(
        attributedLog.replace("bundle-exec=50.0ms", "bundle-exec=500.0ms"),
      ),
    ).toThrow("ordered");
    expect(() =>
      parseAttributedMacStartupLog(
        attributedLog.replace("receipt-epoch-ms=1800.0", "receipt-epoch-ms=1600.0"),
      ),
    ).toThrow("receipt");
  });

  it("summarizes p50 and p95 for every reported phase", () => {
    const first = parseAttributedMacStartupLog(attributedLog);
    const second = parseAttributedMacStartupLog(
      attributedLog
        .replace("app-run-to-ready=810.0ms", "app-run-to-ready=910.0ms")
        .replace("receipt-epoch-ms=1800.0", "receipt-epoch-ms=1900.0"),
    );

    expect(summarizeMacStartupPhases([first, second])).toMatchObject({
      readinessTotalMs: { p50: 810, p95: 910 },
      frameworkNavigationMs: { p50: 300, p95: 300 },
      documentBootMs: { p50: 50, p95: 50 },
      requiredAppWorkMs: { p50: 350, p95: 350 },
      frameSchedulingMs: { p50: 50, p95: 50 },
      readinessIpcMs: { p50: 50, p95: 150 },
      unattributedMs: { p50: 10, p95: 10 },
    });
  });

  it("never claims half-bounce without a visible functional frame and verified input", () => {
    const sample = parseAttributedMacStartupLog(attributedLog);
    expect(qualifyHalfBounce([sample], null)).toEqual({
      status: "unqualified",
      deadlineMs: null,
      reason: "no measured half-bounce deadline was supplied",
    });
    expect(qualifyHalfBounce([sample], 900)).toMatchObject({
      status: "unqualified",
      deadlineMs: 900,
    });

    const observed = {
      ...sample,
      firstFunctionalFrame: "observed" as const,
      inputOutcome: "verified" as const,
    };
    expect(qualifyHalfBounce([observed], 900)).toEqual({
      status: "qualified",
      deadlineMs: 900,
      reason: "readiness p95 810.0ms met the measured 900.0ms deadline",
    });
    expect(qualifyHalfBounce([observed], 800)).toMatchObject({
      status: "missed",
      deadlineMs: 800,
    });
  });
});
