/**
 * Interactive Mac startup evidence is produced by a person following
 * docs/testing/interactive-mac-startup-runbook.md, so ingestion treats
 * every field as untrusted: provenance must match the verified binary and the
 * Mac that ran it, conditions must be stated, and every referenced artifact
 * must be a real file retained inside the qualification root.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildInteractiveMacStartupQualificationReport,
  loadInteractiveMacStartupEvidence,
  type VerifiedNativeBuild,
} from "../../e2e-tauri/native-qualification";

const attributedLog = [
  "Startup(native-window): window=main app-run-epoch-ms=1000.0 process-entry-to-run=20.0ms window-built=100.0ms",
  "Startup(webview): window=main boot-epoch-ms=1300.0 bundle-exec=50.0ms commands-ready=100.0ms settings-ready=300.0ms list-ready=350.0ms app-ready=400.0ms ui-ready=450.0ms total=450.0ms",
  "Startup(native-ready): window=main app-run-to-ready=810.0ms receipt-epoch-ms=1800.0",
].join("\n");

const build: VerifiedNativeBuild = {
  commit: "abc123",
  profile: "release-custom-protocol-production-hooks",
  binary: "/tmp/tauri-explorer",
  binarySha256: "deadbeef",
  binaryBytes: 42,
  binaryModifiedAt: "2026-09-09T00:01:00.000Z",
};

const platform = {
  os: "macos",
  release: "25.6",
  arch: "arm64",
  hardwareModel: "Mac16,1",
  cpu: "Apple M4",
  memoryBytes: 16_000_000_000,
} as const;

let root: string;
let evidencePath: string;

/** The shape the runbook tells an operator to produce, before any mutation. */
function wellFormedEvidence(): Record<string, unknown> {
  return {
    buildSha256: "deadbeef",
    hardwareModel: "Mac16,1",
    launchMethod: "launch-services-normal-application-launch",
    cachePolicy: "cold launch after reboot; caches recorded",
    focus: "frontmost application",
    visibility: "Dock and first functional frame recorded",
    halfBounceDeadlineMs: 900,
    samples: [
      {
        log: path.join(root, "sample-01.log"),
        firstFunctionalFrameMs: 700,
        inputReadyMs: 810,
        launchRecording: path.join(root, "sample-01.mov"),
        nativeTrace: path.join(root, "sample-01.trace"),
      },
    ],
  };
}

function write(evidence: unknown): void {
  fs.writeFileSync(
    evidencePath,
    typeof evidence === "string" ? evidence : JSON.stringify(evidence),
  );
}

function load(samples = 1) {
  return loadInteractiveMacStartupEvidence(
    evidencePath,
    root,
    build,
    platform.hardwareModel,
    samples,
  );
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "interactive-mac-evidence-")),
  );
  evidencePath = path.join(root, "interactive.json");
  fs.writeFileSync(path.join(root, "sample-01.log"), attributedLog);
  fs.writeFileSync(path.join(root, "sample-01.mov"), "dock and first frame");
  fs.writeFileSync(path.join(root, "sample-01.trace"), "input receipt trace");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("interactive Mac startup evidence ingestion", () => {
  it("accepts complete evidence and normalizes every artifact path", () => {
    write(wellFormedEvidence());
    const evidence = load();
    expect(evidence.samples).toEqual([
      {
        log: path.join(root, "sample-01.log"),
        firstFunctionalFrameMs: 700,
        inputReadyMs: 810,
        launchRecording: path.join(root, "sample-01.mov"),
        nativeTrace: path.join(root, "sample-01.trace"),
      },
    ]);
    expect(evidence.halfBounceDeadlineMs).toBe(900);
  });

  it("rejects unreadable and structurally wrong evidence documents", () => {
    write("{ not json");
    expect(() => load()).toThrow("not valid JSON");
    write([wellFormedEvidence()]);
    expect(() => load()).toThrow("must be a JSON object");
    write(null);
    expect(() => load()).toThrow("must be a JSON object");
    fs.rmSync(evidencePath);
    expect(() => load()).toThrow("evidence file does not exist");
  });

  it("refuses evidence whose provenance does not match this build and Mac", () => {
    write({ ...wellFormedEvidence(), buildSha256: "cafebabe" });
    expect(() => load()).toThrow("SHA-256 does not match");
    write({ ...wellFormedEvidence(), buildSha256: undefined });
    expect(() => load()).toThrow("SHA-256 does not match");
    write({ ...wellFormedEvidence(), hardwareModel: "Mac15,3" });
    expect(() => load()).toThrow("hardware model does not match");
    write({ ...wellFormedEvidence(), launchMethod: "direct binary spawn" });
    expect(() => load()).toThrow("normal Launch Services");
    write({ ...wellFormedEvidence(), launchMethod: undefined });
    expect(() => load()).toThrow("normal Launch Services");
  });

  it("requires the launch conditions the report will publish", () => {
    for (const field of ["cachePolicy", "focus", "visibility"] as const) {
      for (const value of [undefined, "", "   ", 42, null]) {
        write({ ...wellFormedEvidence(), [field]: value });
        expect(() => load()).toThrow(`non-empty ${field}`);
      }
    }
  });

  it("requires a positive measured half-bounce deadline", () => {
    for (const value of [undefined, null, 0, -1, Number.NaN, Infinity, "900"]) {
      write({ ...wellFormedEvidence(), halfBounceDeadlineMs: value });
      expect(() => load()).toThrow("positive measured half-bounce deadline");
    }
  });

  it("requires exactly the requested number of well-formed samples", () => {
    write({ ...wellFormedEvidence(), samples: undefined });
    expect(() => load()).toThrow("exactly 1 samples");
    write({ ...wellFormedEvidence(), samples: [] });
    expect(() => load()).toThrow("exactly 1 samples");
    write(wellFormedEvidence());
    expect(() => load(2)).toThrow("exactly 2 samples");
    write({ ...wellFormedEvidence(), samples: [null] });
    expect(() => load()).toThrow("sample 1 is not an object");
  });

  it("rejects absent, non-numeric and negative outcome timings", () => {
    for (const field of ["firstFunctionalFrameMs", "inputReadyMs"] as const) {
      for (const value of [undefined, null, -1, Number.NaN, Infinity, "700"]) {
        const evidence = wellFormedEvidence();
        (evidence.samples as Record<string, unknown>[])[0][field] = value;
        write(evidence);
        expect(() => load()).toThrow(`sample 1 ${field} must be a non-negative number`);
      }
    }
  });

  it("rejects artifacts that are missing, unnamed, not files, or outside the retained root", () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "outside-qualification-")),
    );
    try {
      fs.writeFileSync(path.join(outside, "sample-01.mov"), "unretained");
      fs.symlinkSync(path.join(outside, "sample-01.mov"), path.join(root, "linked.mov"));
      fs.mkdirSync(path.join(root, "sample-01.dir"));

      for (const [field, label] of [
        ["log", "startup log"],
        ["launchRecording", "launch recording"],
        ["nativeTrace", "native trace"],
      ] as const) {
        const missing = wellFormedEvidence();
        (missing.samples as Record<string, unknown>[])[0][field] = path.join(root, "absent");
        write(missing);
        expect(() => load()).toThrow(`sample 1 ${label} does not exist`);

        const unnamed = wellFormedEvidence();
        (unnamed.samples as Record<string, unknown>[])[0][field] = "";
        write(unnamed);
        expect(() => load()).toThrow(`requires a sample 1 ${label} path`);

        const directory = wellFormedEvidence();
        (directory.samples as Record<string, unknown>[])[0][field] = path.join(
          root,
          "sample-01.dir",
        );
        write(directory);
        expect(() => load()).toThrow(`sample 1 ${label} is not a file`);

        // A symlink inside the root still resolves outside it, so an operator
        // cannot reference evidence the run does not retain for review.
        const escaped = wellFormedEvidence();
        (escaped.samples as Record<string, unknown>[])[0][field] = path.join(
          root,
          "linked.mov",
        );
        write(escaped);
        expect(() => load()).toThrow("outside qualification root");
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("builds a half-bounce report only from verified frames, input, and retained artifacts", () => {
    write(wellFormedEvidence());
    const report = buildInteractiveMacStartupQualificationReport({
      evidencePath,
      qualificationRoot: root,
      build,
      platform,
      requestedSamples: 1,
      timeoutMs: 30_000,
      startedAt: "2026-09-09T01:00:00.000Z",
      finishedAt: "2026-09-09T01:01:00.000Z",
    });

    expect(report).toMatchObject({
      scenario: {
        id: "macos-interactive-startup",
        warmMeasure: false,
        launchMethod: "launch-services-normal-application-launch",
        cachePolicy: "cold launch after reboot; caches recorded",
        focus: "frontmost application",
        visibility: "Dock and first functional frame recorded",
      },
      samples: [
        {
          firstFunctionalFrame: "observed",
          firstFunctionalFrameMs: 700,
          inputOutcome: "verified",
          inputReadyMs: 810,
          warmShowMs: null,
        },
      ],
      halfBounce: { status: "qualified", deadlineMs: 900 },
      passed: true,
    });
    // The recording and trace that justify the claim are retained alongside the log.
    expect(report.artifacts).toEqual([
      path.join(root, "sample-01.log"),
      path.join(root, "sample-01.mov"),
      path.join(root, "sample-01.trace"),
    ]);
    expect(report.phaseAttribution.unattributedMs.p50).toBe(10);
  });

  it("never reports a half-bounce pass when the measured outcome misses the deadline", () => {
    write({ ...wellFormedEvidence(), halfBounceDeadlineMs: 700 });
    const report = buildInteractiveMacStartupQualificationReport({
      evidencePath,
      qualificationRoot: root,
      build,
      platform,
      requestedSamples: 1,
      timeoutMs: 30_000,
      startedAt: "2026-09-09T01:00:00.000Z",
      finishedAt: "2026-09-09T01:01:00.000Z",
    });
    expect(report.halfBounce).toMatchObject({ status: "missed", deadlineMs: 700 });
    // A missed measured deadline is a failed run, not a green one with a note.
    expect(report.passed).toBe(false);
  });
});
