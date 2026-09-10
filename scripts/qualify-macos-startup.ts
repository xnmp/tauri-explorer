import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readVerifiedNativeBuildManifest,
  stopNativeStartupProcess,
  summarizeDurations,
  waitForMacStartupProcess,
  writeQualificationArtifact,
  type MacStartupMeasurement,
} from "../e2e-tauri/native-qualification";

if (process.platform !== "darwin") {
  throw new Error("macOS startup qualification must run on a real macOS host");
}

const sampleCount = Number(process.env.MAC_STARTUP_SAMPLES ?? "30");
const timeoutMs = Number(process.env.MAC_STARTUP_TIMEOUT_MS ?? "30000");
const warmSetting = process.env.MAC_STARTUP_WARM_MEASURE ?? "1";
if (warmSetting !== "0" && warmSetting !== "1") {
  throw new Error("MAC_STARTUP_WARM_MEASURE must be 0 or 1");
}
const measureWarm = warmSetting === "1";
// Rust checks for presence, so WARM_MEASURE=0 would still create a probe window.
const sampleEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  RUST_LOG: "info",
  TAURI_EXPLORER_LOG_STDOUT: "1",
};
delete sampleEnvironment.WARM_MEASURE;
if (measureWarm) sampleEnvironment.WARM_MEASURE = "1";
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
const outputDir = path.resolve(
  process.env.MAC_STARTUP_OUTPUT_DIR ?? "qualification-results/macos-startup",
);
fs.mkdirSync(outputDir, { recursive: true });

async function runSample(
  index: number,
): Promise<MacStartupMeasurement & { log: string }> {
  const logPath = path.join(
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
    const measurement = await waitForMacStartupProcess(child, () => log, {
      timeoutMs,
      survivalMs: 5_000,
      measureWarm,
    });
    return { ...measurement, log: logPath };
  } finally {
    try {
      await stopNativeStartupProcess(child);
    } finally {
      fs.writeFileSync(logPath, log);
    }
  }
}

const startedAt = new Date().toISOString();
const samples: Array<MacStartupMeasurement & { log: string }> = [];
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

const report = {
  schemaVersion: 1,
  build,
  platform: { os: "macos", release: os.release(), arch: os.arch() },
  scenario: {
    id: measureWarm ? "macos-cold-warm-startup" : "macos-foreground-startup",
    requestedSamples: sampleCount,
    timeoutMs,
    warmMeasure: measureWarm,
    cachePolicy: "fresh process per sample; operating-system caches uncontrolled",
    coldMilestone: "native-ready: app-run-to-ready",
  },
  startedAt,
  finishedAt: new Date().toISOString(),
  coldStartup: summarizeDurations(
    samples.map(({ coldTotalMs }) => coldTotalMs),
  ),
  warmActivation: summarizeDurations(
    samples.flatMap(({ warmShowMs }) => warmShowMs === null ? [] : [warmShowMs]),
  ),
  samples,
  artifacts: fs
    .readdirSync(outputDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => path.join(outputDir, name)),
  failureArtifacts:
    errors.length > 0
      ? fs
          .readdirSync(outputDir)
          .filter((name) => name.endsWith(".log"))
          .map((name) => path.join(outputDir, name))
      : [],
  errors,
  passed: errors.length === 0 && samples.length === sampleCount,
};

writeQualificationArtifact(path.join(outputDir, "report.json"), report);
if (!report.passed)
  throw new Error(errors.join("; ") || "macOS startup qualification failed");
