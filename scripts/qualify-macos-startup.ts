import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readVerifiedNativeBuildManifest,
  buildInteractiveMacStartupQualificationReport,
  buildMacStartupQualificationReport,
  parseAttributedMacStartupLog,
  resolveQualificationArtifactPath,
  stopNativeStartupProcess,
  waitForMacStartupProcess,
  writeQualificationArtifact,
  type AttributedMacStartupMeasurement,
} from "../e2e-tauri/native-qualification";

if (process.platform !== "darwin") {
  throw new Error("macOS startup qualification must run on a real macOS host");
}

const sampleCount = Number(process.env.MAC_STARTUP_SAMPLES ?? "30");
const timeoutMs = Number(process.env.MAC_STARTUP_TIMEOUT_MS ?? "30000");
const warmSetting =
  process.env.MAC_STARTUP_WARM_MEASURE ??
  (process.env.MAC_STARTUP_INTERACTIVE_EVIDENCE ? "0" : "1");
if (warmSetting !== "0" && warmSetting !== "1") {
  throw new Error("MAC_STARTUP_WARM_MEASURE must be 0 or 1");
}
const measureWarm = warmSetting === "1";
const deadlineValue = process.env.MAC_STARTUP_HALF_BOUNCE_DEADLINE_MS;
const halfBounceDeadlineMs = deadlineValue === undefined ? null : Number(deadlineValue);
if (halfBounceDeadlineMs !== null && (!Number.isFinite(halfBounceDeadlineMs) || halfBounceDeadlineMs <= 0)) {
  throw new Error("MAC_STARTUP_HALF_BOUNCE_DEADLINE_MS must be a positive number");
}
if (!Number.isInteger(sampleCount) || sampleCount < 2) {
  throw new Error("MAC_STARTUP_SAMPLES must be an integer of at least 2");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("MAC_STARTUP_TIMEOUT_MS must be a positive number");
}

const build = readVerifiedNativeBuildManifest(
  path.resolve(
    process.env.NATIVE_BUILD_MANIFEST ??
      "qualification-results/native-build.json",
  ),
);
const binary = build.binary;
const qualificationRoot = path.resolve(
  process.env.NATIVE_QUALIFICATION_ROOT ?? "qualification-results",
);
const requestedOutputDir = path.resolve(
  process.env.MAC_STARTUP_OUTPUT_DIR ?? "qualification-results/macos-startup",
);
const outputDir = resolveQualificationArtifactPath(
  qualificationRoot,
  requestedOutputDir,
);
fs.mkdirSync(outputDir, { recursive: true });
const hardwareModel = execFileSync("/usr/sbin/sysctl", ["-n", "hw.model"], {
  encoding: "utf8",
}).trim();
const interactiveEvidencePath = process.env.MAC_STARTUP_INTERACTIVE_EVIDENCE ?? null;
if (interactiveEvidencePath && measureWarm) {
  throw new Error("interactive Launch Services evidence cannot be combined with the warm-window probe");
}
const sampleEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  RUST_LOG: "info",
  TAURI_EXPLORER_LOG_STDOUT: "1",
};
delete sampleEnvironment.WARM_MEASURE;
if (measureWarm) sampleEnvironment.WARM_MEASURE = "1";

async function runSample(
  index: number,
): Promise<AttributedMacStartupMeasurement & { log: string }> {
  const logPath = resolveQualificationArtifactPath(
    outputDir,
    `sample-${String(index).padStart(2, "0")}.log`,
  );
  let log = "";
  const child = spawn(binary, [], {
    env: sampleEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));

  try {
    await waitForMacStartupProcess(child, () => log, {
      timeoutMs,
      survivalMs: 5_000,
      measureWarm,
    });
    return {
      ...parseAttributedMacStartupLog(log, {
        firstFunctionalFrame: "not-observed",
        firstFunctionalFrameMs: null,
        inputOutcome: "not-verified",
        inputReadyMs: null,
        measureWarm,
      }),
      log: logPath,
    };
  } finally {
    try {
      await stopNativeStartupProcess(child);
    } finally {
      fs.writeFileSync(logPath, log);
    }
  }
}

const startedAt = new Date().toISOString();
const platform = {
  os: "macos",
  release: os.release(),
  arch: os.arch(),
  hardwareModel,
  cpu: os.cpus()[0]?.model ?? "unknown",
  memoryBytes: os.totalmem(),
} as const;

async function runDirectProcessScenario() {
  const samples: Array<AttributedMacStartupMeasurement & { log: string }> = [];
  const errors: string[] = [];
  for (let index = 1; index <= sampleCount; index += 1) {
    try {
      samples.push(await runSample(index));
    } catch (error) {
      errors.push(
        `sample ${index}: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }
  const artifacts = fs
    .readdirSync(outputDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => resolveQualificationArtifactPath(outputDir, name));
  return buildMacStartupQualificationReport({
    build,
    platform,
    scenario: {
      id: measureWarm ? "macos-cold-warm-startup" : "macos-foreground-startup",
      requestedSamples: sampleCount,
      timeoutMs,
      warmMeasure: measureWarm,
      launchMethod:
        "direct verified application binary (Launch Services and Dock unmeasured)",
      cachePolicy: "fresh process per sample; operating-system caches uncontrolled",
      focus: "foreground requested; focus outcome not independently observed",
      visibility:
        "native window configured visible; compositor presentation not observed",
      frameCriterion:
        "two browser animation-frame callbacks after required app work; not proof of presented pixels",
      inputCriterion:
        "external interactive input outcome; not exercised by this direct-process probe",
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    samples,
    artifacts,
    errors,
    halfBounceDeadlineMs,
  });
}

const report = interactiveEvidencePath
  ? buildInteractiveMacStartupQualificationReport({
      evidencePath: interactiveEvidencePath,
      qualificationRoot,
      build,
      platform,
      requestedSamples: sampleCount,
      timeoutMs,
      startedAt,
      finishedAt: new Date().toISOString(),
    })
  : await runDirectProcessScenario();

writeQualificationArtifact(
  resolveQualificationArtifactPath(outputDir, "report.json"),
  report,
);
if (!report.passed)
  throw new Error(report.errors.join("; ") || "macOS startup qualification failed");
