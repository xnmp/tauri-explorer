import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMacStartupQualificationReport,
  loadInteractiveMacStartupEvidence,
  parseAttributedMacStartupLog,
  qualifyHalfBounce,
  summarizeMacStartupPhases,
} from "../../e2e-tauri/native-qualification";

const attributedLog = [
  "Startup(native-window): window=main app-run-epoch-ms=1000.0 process-entry-to-run=20.0ms window-built=100.0ms",
  "Startup(webview): window=main boot-epoch-ms=1300.0 bundle-exec=50.0ms commands-ready=100.0ms settings-ready=300.0ms list-ready=350.0ms app-ready=400.0ms ui-ready=450.0ms total=450.0ms",
  "Startup(native-ready): window=main app-run-to-ready=810.0ms receipt-epoch-ms=1800.0",
  "Startup(warm-activate): show=4.0ms",
].join("\n");

/** The verified build summary `readVerifiedNativeBuildManifest` hands the runner. */
const verifiedBuild = {
  commit: "abc123",
  profile: "release-custom-protocol-production-hooks",
  binary: "/tmp/tauri-explorer",
  binarySha256: "deadbeef",
  binaryBytes: 42,
  binaryModifiedAt: "2026-09-09T00:01:00.000Z",
};

describe("macOS startup phase attribution", () => {
  it("reports measured phases and retains the unexplained remainder", () => {
    expect(parseAttributedMacStartupLog(attributedLog)).toEqual({
      coldTotalMs: 810,
      readinessTotalMs: 810,
      launchTotalMs: 830,
      warmShowMs: 4,
      phases: {
        processEntryMs: 20,
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

  it("keeps the pre-run phase measured and out of the unattributed residual", () => {
    const slowEntry = parseAttributedMacStartupLog(
      attributedLog.replace("process-entry-to-run=20.0ms", "process-entry-to-run=220.0ms"),
    );
    // Only the process-entry phase and the whole-launch total move; the
    // residual stays exactly what the correlated clocks cannot explain.
    expect(slowEntry.phases.processEntryMs).toBe(220);
    expect(slowEntry.launchTotalMs).toBe(1030);
    expect(slowEntry.readinessTotalMs).toBe(810);
    expect(slowEntry.phases.unattributedMs).toBe(10);
    expect(() =>
      parseAttributedMacStartupLog(
        attributedLog.replace(" process-entry-to-run=20.0ms", ""),
      ),
    ).toThrow("native-window marker missing");
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
      launchTotalMs: { p50: 830, p95: 930 },
      processEntryMs: { p50: 20, p95: 20 },
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
      build: verifiedBuild,
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
        commit: "abc123",
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

  it("ingests same-build normal-launch recordings, traces, and timed outcomes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "interactive-mac-startup-"));
    const log = path.join(root, "sample-01.log");
    const recording = path.join(root, "sample-01.mov");
    const trace = path.join(root, "sample-01.trace");
    const evidencePath = path.join(root, "interactive.json");
    fs.writeFileSync(log, attributedLog);
    fs.writeFileSync(recording, "dock and functional frame recording");
    fs.writeFileSync(trace, "native trace and successful input receipt");
    const build = verifiedBuild;
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        buildSha256: "deadbeef",
        hardwareModel: "Mac16,1",
        launchMethod: "launch-services-normal-application-launch",
        cachePolicy: "cold launch after reboot; caches recorded",
        focus: "frontmost application",
        visibility: "Dock and first functional frame recorded",
        halfBounceDeadlineMs: 900,
        samples: [{
          log,
          firstFunctionalFrameMs: 700,
          inputReadyMs: 810,
          launchRecording: recording,
          nativeTrace: trace,
        }],
      }),
    );

    try {
      const evidence = loadInteractiveMacStartupEvidence(
        evidencePath,
        root,
        build,
        "Mac16,1",
        1,
      );
      const sample = parseAttributedMacStartupLog(
        fs.readFileSync(evidence.samples[0].log, "utf8"),
        {
          firstFunctionalFrame: "observed",
          firstFunctionalFrameMs: evidence.samples[0].firstFunctionalFrameMs,
          inputOutcome: "verified",
          inputReadyMs: evidence.samples[0].inputReadyMs,
          measureWarm: false,
        },
      );
      const report = buildMacStartupQualificationReport({
        build,
        platform: {
          os: "macos",
          release: "25.6",
          arch: "arm64",
          hardwareModel: evidence.hardwareModel,
          cpu: "Apple M4",
          memoryBytes: 16_000_000_000,
        },
        scenario: {
          id: "macos-interactive-startup",
          requestedSamples: 1,
          timeoutMs: 30_000,
          warmMeasure: false,
          launchMethod: evidence.launchMethod,
          cachePolicy: evidence.cachePolicy,
          focus: evidence.focus,
          visibility: evidence.visibility,
          frameCriterion: "per-sample launch recording",
          inputCriterion: "per-sample verified input trace",
        },
        startedAt: "2026-09-09T01:00:00.000Z",
        finishedAt: "2026-09-09T01:01:00.000Z",
        samples: [{ ...sample, log }],
        artifacts: [log, recording, trace],
        errors: [],
        halfBounceDeadlineMs: evidence.halfBounceDeadlineMs,
      });
      expect(report).toMatchObject({
        build: { binarySha256: "deadbeef" },
        platform: { hardwareModel: "Mac16,1" },
        scenario: { launchMethod: "launch-services-normal-application-launch" },
        samples: [{
          firstFunctionalFrame: "observed",
          firstFunctionalFrameMs: 700,
          inputOutcome: "verified",
          inputReadyMs: 810,
        }],
        halfBounce: { status: "qualified", deadlineMs: 900 },
      });
      expect(report.artifacts).toEqual([log, recording, trace]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
