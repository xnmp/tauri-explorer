import { describe, expect, it } from "vitest";

import {
  NATIVE_QUALIFICATION_MATRIX,
  buildNativeQualificationReport,
  type QualificationRisk,
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

    expect(NATIVE_QUALIFICATION_MATRIX.length).toBeGreaterThanOrEqual(expectedRisks.length);
    expect(NATIVE_QUALIFICATION_MATRIX.length).toBeLessThanOrEqual(16);
    expect(new Set(NATIVE_QUALIFICATION_MATRIX.map(({ id }) => id)).size).toBe(
      NATIVE_QUALIFICATION_MATRIX.length,
    );

    for (const risk of expectedRisks) {
      expect(NATIVE_QUALIFICATION_MATRIX.some((entry) => entry.risk === risk)).toBe(true);
    }

    for (const entry of NATIVE_QUALIFICATION_MATRIX) {
      expect(entry.platforms.length).toBeGreaterThan(0);
      expect(entry.scenario.length).toBeGreaterThan(20);
      expect(entry.userVisibleOutcome.length).toBeGreaterThan(20);
      if (entry.required) {
        expect(["native-webdriver", "real-macos-process"]).toContain(entry.proof);
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
      },
      platform: {
        os: "linux",
        release: "6.12.10",
        arch: "x64",
        webview: "WebKitGTK 2.48.1",
      },
      configuration: {
        durationMs: 14_400_000,
        maxCycles: 500,
        seed: "issue-688-repro-seed",
        scenarios: ["window-workspace", "plugin-preview", "input-interruption"],
      },
      startedAt: "2026-09-09T00:00:00.000Z",
      finishedAt: "2026-09-09T04:00:00.000Z",
      resources: [
        { rssBytes: 100, sampledAtMs: 0 },
        { rssBytes: 160, sampledAtMs: 7_200_000 },
        { rssBytes: 130, sampledAtMs: 14_400_000 },
      ],
      scenarios: [
        { id: "window-workspace", cycle: 1, durationMs: 10, outcome: "passed", failureArtifacts: [] },
        { id: "plugin-preview", cycle: 1, durationMs: 30, outcome: "passed", failureArtifacts: [] },
        { id: "input-interruption", cycle: 1, durationMs: 20, outcome: "passed", failureArtifacts: [] },
        { id: "window-workspace", cycle: 2, durationMs: 40, outcome: "passed", failureArtifacts: [] },
        {
          id: "plugin-preview",
          cycle: 2,
          durationMs: 50,
          outcome: "failed",
          failureArtifacts: ["artifacts/seed-issue-688-repro-seed/cycle-2-plugin-preview.png"],
        },
      ],
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      build: { commit: "0123456789abcdef", profile: "debug-custom-protocol" },
      platform: { os: "linux", release: "6.12.10", webview: "WebKitGTK 2.48.1" },
      configuration: { seed: "issue-688-repro-seed", durationMs: 14_400_000, maxCycles: 500 },
      resources: { baselineRssBytes: 100, finalRssBytes: 130, peakRssBytes: 160 },
      timings: { sampleCount: 5, p50Ms: 30, p95Ms: 50 },
      passed: false,
    });
    expect(report.failureArtifacts).toEqual([
      "artifacts/seed-issue-688-repro-seed/cycle-2-plugin-preview.png",
    ]);
  });
});
