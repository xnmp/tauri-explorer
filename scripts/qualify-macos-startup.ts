import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseMacStartupLog,
  readVerifiedNativeBuildManifest,
  summarizeDurations,
  writeQualificationArtifact,
  type MacStartupMeasurement,
} from "../e2e-tauri/native-qualification";

if (process.platform !== "darwin") {
  throw new Error("macOS startup qualification must run on a real macOS host");
}

const sampleCount = Number(process.env.MAC_STARTUP_SAMPLES ?? "30");
const timeoutMs = Number(process.env.MAC_STARTUP_TIMEOUT_MS ?? "30000");
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
    env: { ...process.env, RUST_LOG: "info", WARM_MEASURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));

  try {
    const measurement = await new Promise<MacStartupMeasurement>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(new Error(`startup markers missing after ${timeoutMs}ms`)),
          timeoutMs,
        );
        const poll = setInterval(() => {
          try {
            const parsed = parseMacStartupLog(log);
            clearInterval(poll);
            clearTimeout(timeout);
            resolve(parsed);
          } catch {
            // Both native markers are required; keep collecting until the bound.
          }
        }, 25);
        child.once("exit", (code) => {
          clearInterval(poll);
          clearTimeout(timeout);
          reject(
            new Error(
              `application exited before both startup markers (code ${code})`,
            ),
          );
        });
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (child.exitCode !== null) {
      throw new Error(
        "application exited during the post-startup survival check",
      );
    }
    return { ...measurement, log: logPath };
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    fs.writeFileSync(logPath, log);
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
    id: "macos-cold-warm-startup",
    requestedSamples: sampleCount,
    timeoutMs,
    warmMeasure: true,
  },
  startedAt,
  finishedAt: new Date().toISOString(),
  coldStartup: summarizeDurations(
    samples.map(({ coldTotalMs }) => coldTotalMs),
  ),
  warmActivation: summarizeDurations(
    samples.map(({ warmShowMs }) => warmShowMs),
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
