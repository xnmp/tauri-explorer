import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  NATIVE_QUALIFICATION_MATRIX,
  SOAK_SCENARIOS,
  buildNativeQualificationReport,
  nativeWindowsCleanAfterClose,
  executeQualificationRun,
  parseAttributedMacStartupLog,
  readVerifiedNativeBuildManifest,
  resolveNativeApplication,
  resolveSoakConfiguration,
  selectFreshWindowHandle,
  type NativeQualificationReportInput,
  type QualificationRisk,
  writeNativeQualificationReport,
} from "../../e2e-tauri/native-qualification";

describe("native product qualification contract", () => {
  it("selects only a new handle for a forced fresh launch", () => {
    expect(selectFreshWindowHandle(["main", "parked"], ["parked", "fresh", "main"]))
      .toBe("fresh");
    expect(selectFreshWindowHandle(["main", "parked"], ["main", "parked"]))
      .toBeNull();
    expect(selectFreshWindowHandle(["main"], ["main", "first", "second"]))
      .toBeNull();
  });

  it("rejects a visible replacement spare or retained child after native close", () => {
    expect(nativeWindowsCleanAfterClose([
      { label: "main", visible: true },
      { label: "explorer-warm-spare", visible: false },
    ], "main", "explorer-closed")).toBe(true);
    expect(nativeWindowsCleanAfterClose([
      { label: "main", visible: true },
      { label: "explorer-warm-spare", visible: true },
    ], "main", "explorer-closed")).toBe(false);
    expect(nativeWindowsCleanAfterClose([
      { label: "main", visible: true },
      { label: "explorer-closed", visible: false },
    ], "main", "explorer-closed")).toBe(false);
    expect(nativeWindowsCleanAfterClose([{ label: "main", visible: false }], "main", "explorer-closed"))
      .toBe(false);
  });

  it("requires elapsed time, both window paths and bounded RSS and WebKit descriptors for a full soak", () => {
    const base: NativeQualificationReportInput = {
      build: {
        commit: "exact-build", profile: "debug-custom-protocol-e2e-hooks",
        binary: "/tmp/native", binarySha256: "abc", binaryBytes: 1,
        binaryModifiedAt: "2026-09-27T00:00:00.000Z",
      },
      platform: { os: "linux", release: "test", arch: "x64", webview: "WebKitGTK", displayScale: 1 },
      configuration: {
        durationMs: 14_400_000, seed: "four-hour-contract", scenarios: SOAK_SCENARIOS,
        expectedDisplayScale: 1,
      },
      startedAt: "2026-09-27T00:00:00.000Z",
      finishedAt: "2026-09-27T04:00:00.000Z",
      resources: Array.from({ length: 80 }, (_, index) => ({
        rssBytes: index < 60 ? 1_000_000_000 : 1_200_000_000,
        sampledAtMs: Math.round(index * 14_400_000 / 79),
        webKitSharedMemoryFds: 2,
      })),
      scenarios: [
        { id: "window-workspace", cycle: 1, durationMs: 100, outcome: "passed", failureArtifacts: [], windowMode: "warm" },
        { id: "window-workspace", cycle: 2, durationMs: 100, outcome: "passed", failureArtifacts: [], windowMode: "fresh" },
        ...SOAK_SCENARIOS.filter((id) => id !== "window-workspace").map((id) => ({
          id, cycle: 1, durationMs: 100, outcome: "passed" as const, failureArtifacts: [],
        })),
      ],
    };
    const passing = buildNativeQualificationReport(base);
    expect(passing.passed).toBe(true);
    expect(passing.resources.samples).toEqual(base.resources);
    expect(passing.resources.lateMedianGrowthBytes).toBe(200_000_000);

    const growing = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map((sample, index) => index < 60 ? sample : {
        ...sample, rssBytes: 2_200_000_000,
      }),
    });
    expect(growing.passed).toBe(false);
    expect(growing.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("late median process-tree RSS grew"),
    ]));

    const leakingDescriptors = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map((sample, index) => ({
        ...sample, webKitSharedMemoryFds: 2 + index,
      })),
    });
    expect(leakingDescriptors.passed).toBe(false);
    expect(leakingDescriptors.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("WebKit shared-memory descriptors grew"),
    ]));

    const maskedByColdStart = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map((sample, index) => ({
        ...sample,
        webKitSharedMemoryFds: index === 0 ? 30 : index < 60 ? 2 : 25,
      })),
    });
    expect(maskedByColdStart.passed).toBe(false);
    expect(maskedByColdStart.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("WebKit shared-memory descriptors grew"),
    ]));

    const transientTeardown = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map((sample, index) => ({
        ...sample, webKitSharedMemoryFds: index === 20 ? 25 : 2,
      })),
    });
    expect(transientTeardown.passed).toBe(true);

    const samplesClusteredAtStart = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map((sample, index) => ({ ...sample, sampledAtMs: index * 500 })),
    });
    expect(samplesClusteredAtStart.passed).toBe(false);
    expect(samplesClusteredAtStart.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("do not span the required duration"),
    ]));

    const missingEnd = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map((sample) => ({
        ...sample, sampledAtMs: Math.round(sample.sampledAtMs * 0.875),
      })),
    });
    expect(missingEnd.passed).toBe(false);
    expect(missingEnd.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("do not span the required duration"),
    ]));

    const sparseLateLeak = buildNativeQualificationReport({
      ...base,
      resources: [
        ...Array.from({ length: 995 }, (_, index) => ({
          rssBytes: 1_000_000_000, sampledAtMs: index * 3_000, webKitSharedMemoryFds: 2,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          rssBytes: 1_000_000_000,
          sampledAtMs: 14_340_000 + index * 15_000,
          webKitSharedMemoryFds: 40,
        })),
      ],
    });
    expect(sparseLateLeak.passed).toBe(false);
    expect(sparseLateLeak.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("WebKit shared-memory descriptors grew"),
    ]));

    const missingDescriptors = buildNativeQualificationReport({
      ...base,
      resources: base.resources.map(({ webKitSharedMemoryFds: _ignored, ...sample }) => sample),
    });
    expect(missingDescriptors.passed).toBe(false);
    expect(missingDescriptors.runErrors).toContain("full Linux native soak lacks WebKit shared-memory descriptor samples");

    const incomplete = buildNativeQualificationReport({
      ...base,
      finishedAt: "2026-09-27T03:59:59.000Z",
      scenarios: base.scenarios.filter(({ windowMode }) => windowMode !== "fresh"),
    });
    expect(incomplete.passed).toBe(false);
    expect(incomplete.runErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("ended before"),
      expect.stringContaining("both warm and fresh"),
    ]));

    const subset = buildNativeQualificationReport({
      ...base,
      configuration: { ...base.configuration, scenarios: ["window-workspace"] },
      scenarios: base.scenarios.filter(({ id }) => id === "window-workspace"),
    });
    expect(subset.passed).toBe(false);
    expect(subset.runErrors).toContain("full native soak must execute every qualification scenario");
  });

  it("defines a finite risk matrix with observable and honestly classified proof", () => {
    const expectedRisks: QualificationRisk[] = [
      "window-workspace-churn",
      "plugin-churn",
      "theme-accessibility",
      "preview",
      "dpi-zoom",
      "native-input",
      "recovery",
    ];

    expect(NATIVE_QUALIFICATION_MATRIX.length).toBeGreaterThanOrEqual(
      expectedRisks.length,
    );
    expect(NATIVE_QUALIFICATION_MATRIX.length).toBeLessThanOrEqual(16);
    expect(new Set(NATIVE_QUALIFICATION_MATRIX.map(({ id }) => id)).size).toBe(
      NATIVE_QUALIFICATION_MATRIX.length,
    );

    for (const risk of expectedRisks) {
      expect(
        NATIVE_QUALIFICATION_MATRIX.some((entry) => entry.risk === risk),
      ).toBe(true);
    }

    for (const scenario of SOAK_SCENARIOS) {
      expect(
        NATIVE_QUALIFICATION_MATRIX.some(
          (entry) =>
            entry.soakScenario === scenario &&
            entry.required &&
            entry.proof === "native-webdriver",
        ),
      ).toBe(true);
    }

    for (const entry of NATIVE_QUALIFICATION_MATRIX) {
      expect(entry.platforms.length).toBeGreaterThan(0);
      expect(entry.scenario.length).toBeGreaterThan(20);
      expect(entry.userVisibleOutcome.length).toBeGreaterThan(20);
      if (entry.required) {
        expect(["native-webdriver", "real-macos-process"]).toContain(
          entry.proof,
        );
      }
    }

    expect(
      NATIVE_QUALIFICATION_MATRIX.some(
        ({ proof, required }) => proof === "browser-only" && !required,
      ),
    ).toBe(true);
    expect(
      NATIVE_QUALIFICATION_MATRIX.some(
        ({ risk, proof, required }) =>
          risk === "recovery" && proof === "not-implemented" && !required,
      ),
    ).toBe(true);
  });

  it("reports reproducible run identity, resource deltas, percentiles and failures", () => {
    const report = buildNativeQualificationReport({
      build: {
        commit: "0123456789abcdef",
        profile: "debug-custom-protocol",
        binary: "/qualification/tauri-explorer",
        binarySha256: "deadbeef",
        binaryBytes: 1234,
        binaryModifiedAt: "2026-09-08T23:59:00.000Z",
      },
      platform: {
        os: "linux",
        release: "6.12.10",
        arch: "x64",
        webview: "WebKitGTK 2.48.1",
        displayScale: 2,
      },
      configuration: {
        durationMs: 14_400_000,
        maxCycles: 500,
        seed: "issue-688-repro-seed",
        scenarios: SOAK_SCENARIOS,
        expectedDisplayScale: 2,
      },
      startedAt: "2026-09-09T00:00:00.000Z",
      finishedAt: "2026-09-09T04:00:00.000Z",
      resources: [
        { rssBytes: 100, sampledAtMs: 0 },
        { rssBytes: 160, sampledAtMs: 7_200_000 },
        { rssBytes: 130, sampledAtMs: 14_400_000 },
      ],
      scenarios: [
        {
          id: "window-workspace",
          cycle: 1,
          durationMs: 10,
          outcome: "passed",
          failureArtifacts: [],
        },
        {
          id: "plugin-preview",
          cycle: 1,
          durationMs: 30,
          outcome: "passed",
          failureArtifacts: [],
        },
        {
          id: "input-interruption",
          cycle: 1,
          durationMs: 20,
          outcome: "passed",
          failureArtifacts: [],
        },
        {
          id: "window-workspace",
          cycle: 2,
          durationMs: 40,
          outcome: "passed",
          failureArtifacts: [],
        },
        {
          id: "plugin-preview",
          cycle: 2,
          durationMs: 50,
          outcome: "failed",
          failureArtifacts: [
            "artifacts/seed-issue-688-repro-seed/cycle-2-plugin-preview.png",
          ],
        },
      ],
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      build: { commit: "0123456789abcdef", profile: "debug-custom-protocol" },
      platform: {
        os: "linux",
        release: "6.12.10",
        webview: "WebKitGTK 2.48.1",
        displayScale: 2,
      },
      configuration: {
        seed: "issue-688-repro-seed",
        durationMs: 14_400_000,
        maxCycles: 500,
      },
      resources: {
        sampleCount: 3,
        baselineRssBytes: 100,
        finalRssBytes: 130,
        peakRssBytes: 160,
      },
      timings: { sampleCount: 5, p50Ms: 30, p95Ms: 50 },
      passed: false,
    });
    expect(report.failureArtifacts).toEqual([
      "artifacts/seed-issue-688-repro-seed/cycle-2-plugin-preview.png",
    ]);
  });

  it("resolves a replayable bounded configuration and rejects invalid limits", () => {
    expect(
      resolveSoakConfiguration({
        SOAK_DURATION_MS: "60000",
        SOAK_MAX_CYCLES: "3",
        SOAK_SEED: "replay-me",
        SOAK_EXPECTED_DISPLAY_SCALE: "2",
      }),
    ).toEqual({
      durationMs: 60_000,
      maxCycles: 3,
      seed: "replay-me",
      scenarios: SOAK_SCENARIOS,
      expectedDisplayScale: 2,
    });
    expect(() => resolveSoakConfiguration({ SOAK_DURATION_MS: "0" })).toThrow(
      "SOAK_DURATION_MS",
    );
    expect(() =>
      resolveSoakConfiguration({
        SOAK_MAX_CYCLES: "not-a-number",
        SOAK_EXPECTED_DISPLAY_SCALE: "1",
      }),
    ).toThrow("SOAK_MAX_CYCLES");
    expect(resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_MAX_CYCLES: "450",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    }).scenarios).toEqual(["window-workspace"]);
    expect(() => resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    })).toThrow("SOAK_MAX_CYCLES");
    expect(() => resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "unknown",
      SOAK_MAX_CYCLES: "1",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    })).toThrow("SOAK_DIAGNOSTIC_SCENARIO");
    expect(resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_DIAGNOSTIC_WINDOW_MODE: "warm",
      SOAK_MAX_CYCLES: "220",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    }).diagnosticWindowMode).toBe("warm");
    expect(() => resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_WINDOW_MODE: "fresh",
      SOAK_MAX_CYCLES: "1",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    })).toThrow("SOAK_DIAGNOSTIC_WINDOW_MODE");
    expect(() => resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_DIAGNOSTIC_WINDOW_MODE: "other",
      SOAK_MAX_CYCLES: "1",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    })).toThrow("SOAK_DIAGNOSTIC_WINDOW_MODE");
    expect(resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_DIAGNOSTIC_WINDOW_MODE: "fresh",
      SOAK_DIAGNOSTIC_MAIN_ONLY: "1",
      SOAK_MAX_CYCLES: "450",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    }).diagnosticMainOnly).toBe(true);
    expect(() => resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_DIAGNOSTIC_MAIN_ONLY: "1",
      SOAK_MAX_CYCLES: "1",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    })).toThrow("SOAK_DIAGNOSTIC_MAIN_ONLY");
    expect(() => resolveSoakConfiguration({
      SOAK_DIAGNOSTIC_SCENARIO: "window-workspace",
      SOAK_DIAGNOSTIC_WINDOW_MODE: "fresh",
      SOAK_DIAGNOSTIC_MAIN_ONLY: "yes",
      SOAK_MAX_CYCLES: "1",
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    })).toThrow("SOAK_DIAGNOSTIC_MAIN_ONLY");
  });

  it("writes a readable failure report even when native sampling is unavailable", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "native-qualification-report-"),
    );
    const output = path.join(dir, "failed.json");
    const report = buildNativeQualificationReport({
      build: {
        commit: "source-commit",
        profile: "debug-custom-protocol-e2e-hooks",
        binary: "/tmp/tauri-explorer",
        binarySha256: "abc123",
        binaryBytes: 42,
        binaryModifiedAt: "2026-09-09T00:00:00.000Z",
      },
      platform: {
        os: "linux",
        release: "test",
        arch: "x64",
        webview: "unavailable",
        displayScale: null,
      },
      configuration: {
        durationMs: 1,
        maxCycles: 1,
        seed: "failure-seed",
        scenarios: SOAK_SCENARIOS,
        expectedDisplayScale: 1,
      },
      startedAt: "2026-09-09T00:00:00.000Z",
      finishedAt: "2026-09-09T00:00:01.000Z",
      resources: [],
      scenarios: [],
      runErrors: ["baseline RSS unavailable: native process not found"],
    });

    writeNativeQualificationReport(output, report);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      build: { binarySha256: "abc123", binaryBytes: 42 },
      resources: {
        baselineRssBytes: null,
        finalRssBytes: null,
        peakRssBytes: null,
      },
      runErrors: ["baseline RSS unavailable: native process not found"],
      passed: false,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses the startup markers the binary actually emits", () => {
    // Verbatim from a captured launch; the fixture must not drift from the
    // format `system.rs` and `lib.rs` log, or a Mac run fails at sample 1.
    const log =
      "Startup(native-window): window=main app-run-epoch-ms=1000.0 process-entry-to-run=20.0ms window-built=100.0ms\n" +
      "Startup(webview): window=main boot-epoch-ms=1300.0 bundle-exec=50.0ms mount=80.0ms commands-ready=100.0ms settings-ready=300.0ms list-ready=350.0ms app-ready=400.0ms ui-ready=450.0ms total=450.0ms\n" +
      "Startup(native-ready): window=main app-run-to-ready=810.0ms receipt-epoch-ms=1800.0\n";
    expect(parseAttributedMacStartupLog(`${log}Startup(warm-activate): show=4.4ms\n`))
      .toMatchObject({ coldTotalMs: 810, warmShowMs: 4.4 });
    expect(() => parseAttributedMacStartupLog(log)).toThrow("warm-activate");
  });

  it("does not accept builder setup or WebView timing as foreground readiness", () => {
    expect(() => parseAttributedMacStartupLog(
      "Startup: total=15ms\nStartup(webview): total=25ms\n" +
      "Startup(warm-activate): show=2ms\n",
    )).toThrow("native-window");
  });

  it("keeps the hours-long runner opt-in and out of the bounded smoke config", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const smokeConfig = fs.readFileSync("e2e-tauri/wdio.conf.ts", "utf8");
    const soakConfig = fs.readFileSync("e2e-tauri/wdio.soak.conf.ts", "utf8");
    const soakSpec = fs.readFileSync(
      "e2e-tauri/soak/native-soak.spec.ts",
      "utf8",
    );

    expect(packageJson.scripts["test:e2e:tauri"]).toBe(
      "wdio run e2e-tauri/wdio.conf.ts",
    );
    expect(packageJson.scripts["test:e2e:tauri:soak"]).toBe(
      "bun run scripts/run-native-soak.ts",
    );
    expect(packageJson.scripts["build:native:qualification"]).toBe(
      "bun run scripts/build-native-qualification.ts",
    );
    expect(smokeConfig).not.toContain("soak/**/*.spec.ts");
    expect(soakConfig).toContain('specs: ["./soak/**/*.spec.ts"]');
    expect(soakSpec).toContain(
      "executeQualificationRun<NativeQualificationReport>",
    );
    expect(soakSpec).toContain("Record<SoakScenario");
    expect(soakSpec).toContain("await scenarioActions[scenario](cycle)");
    const runner = fs.readFileSync("scripts/run-native-soak.ts", "utf8");
    expect(runner).toContain("NATIVE_BUILD_MANIFEST: manifestPath");
    expect(runner).toContain(
      "WebDriver exited before the native report was emitted",
    );
  });

  it("ties the reported source commit and profile to the exact launched binary", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "native-build-manifest-"),
    );
    const binary = path.join(dir, "tauri-explorer");
    const manifestPath = path.join(dir, "native-build.json");
    fs.writeFileSync(binary, "qualification binary");
    const stat = fs.statSync(binary);
    const sha256 = createHash("sha256")
      .update(fs.readFileSync(binary))
      .digest("hex");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        sourceCommit: "built-source-commit",
        profile: "debug-custom-protocol-e2e-hooks",
        buildCommand: [
          "bun",
          "run",
          "tauri",
          "build",
          "--debug",
          "--no-bundle",
        ],
        startedAt: "2026-09-09T00:00:00.000Z",
        completedAt: "2026-09-09T00:01:00.000Z",
        binary,
        binarySha256: sha256,
        binaryBytes: stat.size,
        binaryModifiedAt: stat.mtime.toISOString(),
      }),
    );

    expect(readVerifiedNativeBuildManifest(manifestPath)).toMatchObject({
      commit: "built-source-commit",
      profile: "debug-custom-protocol-e2e-hooks",
      binary,
      binarySha256: sha256,
    });
    expect(
      resolveNativeApplication("/wrong/default/binary", {
        NATIVE_BUILD_MANIFEST: manifestPath,
      }),
    ).toBe(binary);
    fs.appendFileSync(binary, " tampered");
    expect(() => readVerifiedNativeBuildManifest(manifestPath)).toThrow(
      "does not match",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("emits a failed artifact when the runner throws before native scenarios start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-run-finalizer-"));
    const outputPath = path.join(dir, "early-failure.json");

    await expect(
      executeQualificationRun({
        outputPath,
        execute: async () => {
          throw new Error("initial native UI unavailable");
        },
        createReport: (runErrors) => ({ passed: false, runErrors }),
      }),
    ).rejects.toThrow("initial native UI unavailable");
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      passed: false,
      runErrors: ["initial native UI unavailable"],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
