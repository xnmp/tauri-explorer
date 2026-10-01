import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readVerifiedNativeBuildManifest,
  buildInteractiveMacStartupQualificationReport,
  buildMacStartupQualificationReport,
  MacRendererLossError,
  MacStartupTimeoutError,
  MAX_RECOVERED_RENDERER_LOSSES,
  resolveQualificationArtifactPath,
  stopNativeStartupProcess,
  waitForMacStartupProcess,
  writeQualificationArtifact,
  type AttributedMacStartupMeasurement,
  type RendererLossRecord,
} from "../e2e-tauri/native-qualification";
import {
  captureMacStartupStallEvidence,
  withStallEvidence,
} from "../e2e-tauri/native-qualification/stall-evidence";

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

const sampleName = (index: number): string => `sample-${String(index).padStart(2, "0")}`;

async function runSample(
  index: number,
): Promise<AttributedMacStartupMeasurement & { log: string }> {
  const logPath = resolveQualificationArtifactPath(outputDir, `${sampleName(index)}.log`);
  let log = "";
  const sampleStartedAtMs = Date.now();
  const child = spawn(binary, [], {
    env: sampleEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));

  try {
    // The wait already parses the full attributed marker set; re-parsing here
    // would be a second place for the log format to drift out of agreement.
    const measurement = await waitForMacStartupProcess(child, () => log, {
      timeoutMs,
      survivalMs: 5_000,
      measureWarm,
    });
    return { ...measurement, log: logPath };
  } catch (error) {
    // The sample's process is still owned and alive: record what the operating
    // system can show before cleanup stops it. A stall profiles the live
    // processes (#936); a renderer loss collects the dead page's crash report
    // and identity, even when the app has already reloaded it (#942).
    const reason =
      error instanceof MacStartupTimeoutError ? "stall"
        : error instanceof MacRendererLossError ? "renderer-loss"
        : null;
    if (reason) {
      throw await withStallEvidence(error as Error, outputDir, () =>
        captureMacStartupStallEvidence({
          pid: child.pid,
          binary,
          outputDir,
          directoryName: `${sampleName(index)}-${reason}`,
          sampleStartedAtMs,
          reason,
        }),
      );
    }
    throw error;
  } finally {
    try {
      await stopNativeStartupProcess(child);
    } finally {
      fs.writeFileSync(logPath, log);
    }
  }
}

/** Provenance only: a tool that is missing or fails records null, never fails the run. */
function readVersion(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim() || null;
  } catch {
    return null;
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
  osProductVersion: readVersion("/usr/bin/sw_vers", ["-productVersion"]),
  osBuildVersion: readVersion("/usr/bin/sw_vers", ["-buildVersion"]),
  // The same build string WebContent crash reports carry as `build_version`.
  webKitVersion: readVersion("/usr/bin/plutil", [
    "-extract", "CFBundleVersion", "raw", "-o", "-",
    "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist",
  ]),
} as const;

async function runDirectProcessScenario() {
  const samples: Array<AttributedMacStartupMeasurement & { log: string }> = [];
  const errors: string[] = [];
  const rendererLosses: RendererLossRecord[] = [];
  // A recovered renderer loss is recorded and replaced by another launch; the
  // report fails an unrecovered loss or more than the allowed number (#942).
  for (let index = 1; samples.length < sampleCount; index += 1) {
    try {
      samples.push(await runSample(index));
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      const loss = error instanceof Error ? error.cause : undefined;
      if (loss instanceof MacRendererLossError) {
        rendererLosses.push({
          sample: index,
          recovered: loss.recovered,
          description,
          log: resolveQualificationArtifactPath(outputDir, `${sampleName(index)}.log`),
          evidence: resolveQualificationArtifactPath(outputDir, `${sampleName(index)}-renderer-loss`),
        });
        console.log(`::warning title=Renderer loss::sample ${index}: ${description}`);
        const recovered = rendererLosses.filter((record) => record.recovered).length;
        if (loss.recovered && recovered <= MAX_RECOVERED_RENDERER_LOSSES) continue;
        break;
      }
      errors.push(`sample ${index}: ${description}`);
      break;
    }
  }
  const recovered = rendererLosses.filter((record) => record.recovered).length;
  console.log(`renderer losses: ${rendererLosses.length} (${recovered} recovered and replaced)`);
  const artifacts = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isFile() && entry.name.endsWith(".log")) return [entry.name];
      // Each failed sample's evidence directory is indexed by its summary.
      const summary = path.join(entry.name, "evidence.json");
      return entry.isDirectory() && /-(stall|renderer-loss)$/.test(entry.name) &&
        fs.existsSync(path.join(outputDir, summary))
        ? [summary]
        : [];
    })
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
    rendererLosses,
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
