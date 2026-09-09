import { describe, expect, it } from "vitest";

import {
  buildMacStartupQualificationReport,
  parseAttributedMacStartupLog,
  qualifyHalfBounce,
  summarizeMacStartupPhases,
} from "../../e2e-tauri/native-qualification";

const attributedLog = [
  "Startup(native-window): window=main app-run-epoch-ms=1000.0 window-built=100.0ms",
  "Startup(webview): window=main boot-epoch-ms=1300.0 bundle-exec=50.0ms commands-ready=100.0ms settings-ready=300.0ms list-ready=350.0ms app-ready=400.0ms ui-ready=450.0ms total=450.0ms",
  "Startup(native-ready): window=main app-run-to-ready=810.0ms receipt-epoch-ms=1800.0",
  "Startup(warm-activate): show=4.0ms",
].join("\n");

describe("macOS startup phase attribution", () => {
  it("reports measured phases and retains the unexplained remainder", () => {
    expect(parseAttributedMacStartupLog(attributedLog)).toEqual({
      coldTotalMs: 810,
      readinessTotalMs: 810,
      warmShowMs: 4,
      phases: {
        nativeWindowMs: 100,
        frameworkNavigationMs: 200,
        documentBootMs: 50,
        requiredAppWorkMs: 350,
        frameSchedulingMs: 50,
        readinessIpcMs: 50,
        unattributedMs: 10,
      },
      firstFunctionalFrame: "not-observed",
      firstFunctionalFrameMs: null,
      inputOutcome: "not-verified",
      inputReadyMs: null,
    });
  });

  it("correlates the main window when a warm webview reports first", () => {
    const interleaved =
      "Startup(webview): window=explorer-warm-measure boot-epoch-ms=1100.0 bundle-exec=1.0ms commands-ready=2.0ms settings-ready=3.0ms list-ready=4.0ms app-ready=5.0ms ui-ready=6.0ms total=6.0ms\n" +
      attributedLog;
    expect(parseAttributedMacStartupLog(interleaved).phases).toMatchObject({
      nativeWindowMs: 100,
      frameworkNavigationMs: 200,
      requiredAppWorkMs: 350,
    });
  });

  it("rejects missing and inconsistent observable phase markers", () => {
    expect(() =>
      parseAttributedMacStartupLog(
        attributedLog.replace(" list-ready=350.0ms", ""),
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
      nativeWindowMs: { p50: 100, p95: 100 },
      frameworkNavigationMs: { p50: 200, p95: 200 },
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
      firstFunctionalFrameMs: 700,
      inputOutcome: "verified" as const,
      inputReadyMs: 810,
    };
    expect(qualifyHalfBounce([observed], 900)).toEqual({
      status: "qualified",
      deadlineMs: 900,
      reason: "visible-and-input-functional p95 810.0ms met the measured 900.0ms deadline",
    });
    expect(qualifyHalfBounce([observed], 800)).toMatchObject({
      status: "missed",
      deadlineMs: 800,
    });
  });

  it("builds the final report with exact provenance, conditions, and explicit outcomes", () => {
    const sample = parseAttributedMacStartupLog(attributedLog);
    const report = buildMacStartupQualificationReport({
      build: {
        schemaVersion: 1,
        sourceCommit: "abc123",
        profile: "release-custom-protocol-production-hooks",
        buildCommand: ["bun", "run", "tauri", "build"],
        startedAt: "2026-09-09T00:00:00.000Z",
        completedAt: "2026-09-09T00:01:00.000Z",
        binary: "/tmp/tauri-explorer",
        binarySha256: "deadbeef",
        binaryBytes: 42,
        binaryModifiedAt: "2026-09-09T00:01:00.000Z",
      },
      platform: {
        os: "macos",
        release: "25.6",
        arch: "arm64",
        hardwareModel: "Mac16,1",
        cpu: "Apple M4",
        memoryBytes: 16_000_000_000,
      },
      scenario: {
        id: "macos-foreground-startup",
        requestedSamples: 1,
        timeoutMs: 30_000,
        warmMeasure: false,
        launchMethod: "direct verified application binary (Launch Services and Dock unmeasured)",
        cachePolicy: "fresh process; OS caches uncontrolled",
        focus: "not independently observed",
        visibility: "compositor presentation not observed",
        frameCriterion: "two browser frame opportunities; not presented pixels",
        inputCriterion: "not exercised by the direct-process probe",
      },
      startedAt: "2026-09-09T01:00:00.000Z",
      finishedAt: "2026-09-09T01:01:00.000Z",
      samples: [{ ...sample, log: "/qualification/sample-01.log" }],
      artifacts: ["/qualification/sample-01.log"],
      errors: [],
      halfBounceDeadlineMs: 900,
    });

    expect(report).toMatchObject({
      schemaVersion: 2,
      build: {
        sourceCommit: "abc123",
        profile: "release-custom-protocol-production-hooks",
        binarySha256: "deadbeef",
      },
      platform: {
        release: "25.6",
        arch: "arm64",
        hardwareModel: "Mac16,1",
      },
      scenario: {
        launchMethod: expect.stringContaining("Launch Services and Dock unmeasured"),
        cachePolicy: "fresh process; OS caches uncontrolled",
      },
      samples: [{ firstFunctionalFrame: "not-observed", inputOutcome: "not-verified" }],
      halfBounce: { status: "unqualified", deadlineMs: 900 },
      passed: true,
    });
  });
});
