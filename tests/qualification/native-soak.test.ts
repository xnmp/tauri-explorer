import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  NATIVE_QUALIFICATION_MATRIX,
  SOAK_SCENARIOS,
  buildNativeQualificationReport,
  executeQualificationRun,
  parseMacStartupLog,
  readVerifiedNativeBuildManifest,
  resolveSoakConfiguration,
  type QualificationRisk,
  writeNativeQualificationReport,
} from "../../e2e-tauri/native-qualification";

describe("native product qualification contract", () => {
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

  it("parses real macOS cold and warm startup markers", () => {
    expect(
      parseMacStartupLog(
        "Startup: pre-builder=4.0ms builder→setup=79.2ms total=83.2ms\n" +
          "Startup(warm-activate): show=4.4ms\n",
      ),
    ).toEqual({ coldTotalMs: 83.2, warmShowMs: 4.4 });
    expect(() => parseMacStartupLog("Startup: total=83.2ms")).toThrow(
      "warm-activate",
    );
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
      "wdio run e2e-tauri/wdio.soak.conf.ts",
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
