import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type NativePlatform = "linux" | "windows" | "macos";

export type QualificationRisk =
  | "window-workspace-churn"
  | "plugin-churn"
  | "theme-accessibility"
  | "preview"
  | "dpi-zoom"
  | "native-input"
  | "recovery";

export type QualificationProof =
  | "native-webdriver"
  | "real-macos-process"
  | "browser-only"
  | "unsupported"
  | "not-implemented";

export const SOAK_SCENARIOS = [
  "window-workspace",
  "plugin-churn",
  "theme-accessibility-zoom",
  "preview-native-input",
] as const;

export type SoakScenario = (typeof SOAK_SCENARIOS)[number];

export interface QualificationCase {
  id: string;
  risk: QualificationRisk;
  platforms: readonly NativePlatform[];
  scenario: string;
  userVisibleOutcome: string;
  proof: QualificationProof;
  required: boolean;
  soakScenario?: SoakScenario;
}

export interface SoakConfiguration {
  durationMs: number;
  maxCycles?: number;
  seed: string;
  scenarios: readonly SoakScenario[];
  expectedDisplayScale: number;
}

export interface SoakArtifactPaths {
  seedComponent: string;
  report: string;
  driverLog: string;
  failureDirectory: string;
}

export interface ResourceMeasurement {
  rssBytes: number;
  sampledAtMs: number;
}

export interface NativeProcessRow {
  pid: number;
  parentPid: number;
  rssBytes: number;
  executable: string;
}

export interface ScenarioMeasurement {
  id: string;
  cycle: number;
  durationMs: number;
  outcome: "passed" | "failed";
  failureArtifacts: readonly string[];
}

export interface NativeQualificationReport {
  schemaVersion: 1;
  build: {
    commit: string;
    profile: string;
    binary: string;
    binarySha256: string;
    binaryBytes: number;
    binaryModifiedAt: string;
  };
  platform: {
    os: NativePlatform;
    release: string;
    arch: string;
    webview: string;
    displayScale: number | null;
  };
  configuration: SoakConfiguration;
  startedAt: string;
  finishedAt: string;
  resources: {
    sampleCount: number;
    baselineRssBytes: number | null;
    finalRssBytes: number | null;
    peakRssBytes: number | null;
  };
  timings: {
    sampleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  scenarios: readonly ScenarioMeasurement[];
  failureArtifacts: readonly string[];
  runErrors: readonly string[];
  passed: boolean;
}

export interface NativeQualificationReportInput {
  build: NativeQualificationReport["build"];
  platform: NativeQualificationReport["platform"];
  configuration: SoakConfiguration;
  startedAt: string;
  finishedAt: string;
  resources: readonly ResourceMeasurement[];
  scenarios: readonly ScenarioMeasurement[];
  runErrors?: readonly string[];
}

export interface NativeBuildManifest {
  schemaVersion: 1;
  sourceCommit: string;
  profile: string;
  buildCommand: readonly string[];
  startedAt: string;
  completedAt: string;
  binary: string;
  binarySha256: string;
  binaryBytes: number;
  binaryModifiedAt: string;
}

/**
 * Bounded pairwise coverage, not a Cartesian product. `required` means the row
 * is release acceptance; browser-only and unavailable recovery rows remain
 * visible so a report cannot accidentally present them as native proof.
 */
export const NATIVE_QUALIFICATION_MATRIX: readonly QualificationCase[] = [
  {
    id: "linux-window-workspace-churn",
    risk: "window-workspace-churn",
    platforms: ["linux"],
    scenario:
      "Create and close native WebKitGTK windows while alternating two real scratch workspaces.",
    userVisibleOutcome:
      "Every surviving window renders the requested workspace path and a usable file listing.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "window-workspace",
  },
  {
    id: "windows-window-workspace-churn",
    risk: "window-workspace-churn",
    platforms: ["windows"],
    scenario:
      "Create and close native WebView2 windows while alternating two real scratch workspaces.",
    userVisibleOutcome:
      "Every surviving window renders the requested workspace path and a usable file listing.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "window-workspace",
  },
  {
    id: "native-plugin-churn",
    risk: "plugin-churn",
    platforms: ["linux", "windows"],
    scenario:
      "Enable, invoke, and disable the bundled demo plugin around interrupted palette sessions.",
    userVisibleOutcome:
      "The demo command appears when enabled, shows its success toast, and disappears when disabled.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "plugin-churn",
  },
  {
    id: "linux-theme-accessibility",
    risk: "theme-accessibility",
    platforms: ["linux"],
    scenario:
      "Toggle theme through the keyboard-only command palette under WebKitGTK.",
    userVisibleOutcome:
      "The first keyboard invocation changes the rendered theme and the labelled palette remains operable.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "theme-accessibility-zoom",
  },
  {
    id: "windows-theme-accessibility",
    risk: "theme-accessibility",
    platforms: ["windows"],
    scenario:
      "Toggle theme through the keyboard-only command palette under WebView2.",
    userVisibleOutcome:
      "The first keyboard invocation changes the rendered theme and the labelled palette remains operable.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "theme-accessibility-zoom",
  },
  {
    id: "native-preview-pair",
    risk: "preview",
    platforms: ["linux", "windows"],
    scenario:
      "Alternate real Markdown and plain-text files while workspace and plugin state churns.",
    userVisibleOutcome:
      "Markdown headings and exact plain-text content render in the native preview pane after selection.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "preview-native-input",
  },
  {
    id: "native-zoom-pair",
    risk: "dpi-zoom",
    platforms: ["linux", "windows"],
    scenario:
      "Exercise 80, 100, and 150 percent application zoom while recording the runner display scale.",
    userVisibleOutcome:
      "The visible explorer and keyboard palette remain inside the viewport and usable at each zoom level.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "theme-accessibility-zoom",
  },
  {
    id: "native-keyboard-input",
    risk: "native-input",
    platforms: ["linux", "windows"],
    scenario:
      "Interrupt navigation with Escape and refresh, then select a real file using native key events.",
    userVisibleOutcome:
      "The active file row visibly receives selection and the explorer remains responsive to shortcuts.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "preview-native-input",
  },
  {
    id: "macos-startup-measurement",
    risk: "window-workspace-churn",
    platforms: ["macos"],
    scenario:
      "Measure cold startup and warm activation from the built application on a real macOS runner.",
    userVisibleOutcome:
      "The native process reaches its startup markers, remains alive, and records cold and warm timing samples.",
    proof: "real-macos-process",
    required: true,
  },
  {
    id: "expanded-browser-combinations",
    risk: "theme-accessibility",
    platforms: ["linux", "windows", "macos"],
    scenario:
      "Exercise additional theme, reduced-motion, preview, and viewport combinations in browser Playwright.",
    userVisibleOutcome:
      "Selected combinations render their expected labels, previews, focus state, and viewport containment.",
    proof: "browser-only",
    required: false,
  },
  {
    id: "platform-recovery-adapters",
    risk: "recovery",
    platforms: ["linux", "windows", "macos"],
    scenario:
      "Qualify each platform recovery adapter only after that recovery capability is implemented.",
    userVisibleOutcome:
      "Implemented recovery restores a usable explorer without presenting unimplemented behavior as required.",
    proof: "not-implemented",
    required: false,
  },
] as const;

function nearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

function positiveNumber(
  name: string,
  value: string | undefined,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

export function resolveSoakConfiguration(
  env: Record<string, string | undefined>,
): SoakConfiguration {
  const resolved: SoakConfiguration = {
    durationMs: positiveNumber(
      "SOAK_DURATION_MS",
      env.SOAK_DURATION_MS,
      14_400_000,
    ),
    seed:
      env.SOAK_SEED !== undefined && env.SOAK_SEED.length > 0
        ? env.SOAK_SEED
        : `native-soak-${new Date().toISOString().slice(0, 10)}`,
    scenarios: SOAK_SCENARIOS,
    expectedDisplayScale: positiveNumber(
      "SOAK_EXPECTED_DISPLAY_SCALE",
      env.SOAK_EXPECTED_DISPLAY_SCALE,
    ),
  };
  if (env.SOAK_MAX_CYCLES !== undefined) {
    resolved.maxCycles = positiveNumber("SOAK_MAX_CYCLES", env.SOAK_MAX_CYCLES);
  }
  return resolved;
}

export function resolveQualificationArtifactPath(
  root: string,
  ...components: readonly string[]
): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...components);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `artifact path resolves outside qualification root: ${resolved}`,
    );
  }
  return resolved;
}

export function resolveSoakArtifactPaths(
  root: string,
  platform: NativePlatform,
  seed: string,
): SoakArtifactPaths {
  const readable = seed
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  const seedComponent = `${readable || "seed"}-${digest}`;
  return {
    seedComponent,
    report: resolveQualificationArtifactPath(
      root,
      `${platform}-${seedComponent}.json`,
    ),
    driverLog: resolveQualificationArtifactPath(
      root,
      `${platform}-${seedComponent}-webdriver.log`,
    ),
    failureDirectory: resolveQualificationArtifactPath(
      root,
      `seed-${seedComponent}`,
    ),
  };
}

export function buildNativeQualificationReport(
  input: NativeQualificationReportInput,
): NativeQualificationReport {
  if (!input.configuration.seed || input.configuration.durationMs <= 0) {
    throw new Error(
      "native qualification requires a seed and a positive duration",
    );
  }
  const durations = input.scenarios.map(({ durationMs }) => durationMs);
  const runErrors = [...(input.runErrors ?? [])];
  const failureArtifacts = [
    ...new Set(
      input.scenarios.flatMap(({ failureArtifacts }) => failureArtifacts),
    ),
  ];

  return {
    schemaVersion: 1,
    build: input.build,
    platform: input.platform,
    configuration: input.configuration,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    resources: {
      sampleCount: input.resources.length,
      baselineRssBytes: input.resources[0]?.rssBytes ?? null,
      finalRssBytes: input.resources.at(-1)?.rssBytes ?? null,
      peakRssBytes:
        input.resources.length > 0
          ? Math.max(...input.resources.map(({ rssBytes }) => rssBytes))
          : null,
    },
    timings: {
      sampleCount: durations.length,
      p50Ms: nearestRank(durations, 0.5),
      p95Ms: nearestRank(durations, 0.95),
    },
    scenarios: input.scenarios,
    failureArtifacts,
    runErrors,
    passed:
      input.scenarios.length > 0 &&
      runErrors.length === 0 &&
      input.scenarios.every(({ outcome }) => outcome === "passed"),
  };
}

export function writeNativeQualificationReport(
  outputPath: string,
  report: NativeQualificationReport,
): void {
  writeQualificationArtifact(outputPath, report);
}

export function writeQualificationArtifact(
  outputPath: string,
  report: unknown,
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporaryPath, outputPath);
}

export function readVerifiedNativeBuildManifest(
  manifestPath: string,
): NativeQualificationReport["build"] {
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as NativeBuildManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.sourceCommit ||
    !manifest.profile ||
    !Array.isArray(manifest.buildCommand) ||
    !manifest.startedAt ||
    !manifest.completedAt
  ) {
    throw new Error(`native build manifest is incomplete: ${manifestPath}`);
  }
  const binary = path.resolve(manifest.binary);
  const stat = fs.statSync(binary);
  const actualSha256 = createHash("sha256")
    .update(fs.readFileSync(binary))
    .digest("hex");
  if (
    actualSha256 !== manifest.binarySha256 ||
    stat.size !== manifest.binaryBytes
  ) {
    throw new Error(
      `native binary does not match its build manifest: ${binary}`,
    );
  }
  return {
    commit: manifest.sourceCommit,
    profile: manifest.profile,
    binary,
    binarySha256: actualSha256,
    binaryBytes: stat.size,
    binaryModifiedAt: manifest.binaryModifiedAt,
  };
}

export function resolveNativeApplication(
  defaultApplication: string,
  env: Record<string, string | undefined>,
): string {
  return env.NATIVE_BUILD_MANIFEST
    ? readVerifiedNativeBuildManifest(env.NATIVE_BUILD_MANIFEST).binary
    : defaultApplication;
}

export function measureProcessTreeRss(
  rows: readonly NativeProcessRow[],
  expectedBinary: string,
  sampledAtMs: number,
): ResourceMeasurement {
  const normalizedBinary = path.resolve(expectedBinary).toLowerCase();
  const processIds = new Set(
    rows
      .filter(
        ({ executable }) =>
          path.resolve(executable).toLowerCase() === normalizedBinary,
      )
      .map(({ pid }) => pid),
  );
  if (processIds.size === 0)
    throw new Error(`native process not found at ${expectedBinary}`);

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (processIds.has(row.parentPid) && !processIds.has(row.pid)) {
        processIds.add(row.pid);
        changed = true;
      }
    }
  }

  return {
    rssBytes: rows
      .filter(({ pid }) => processIds.has(pid))
      .reduce((total, { rssBytes }) => total + rssBytes, 0),
    sampledAtMs,
  };
}

export function addQualificationFailureArtifact<
  T extends { failureArtifacts?: readonly string[] },
>(report: T, artifact: string): T & { failureArtifacts: string[] } {
  return {
    ...report,
    failureArtifacts: [
      ...new Set([...(report.failureArtifacts ?? []), artifact]),
    ],
  };
}

export async function executeLoggedQualificationProcess<
  T extends {
    passed?: boolean;
    failureArtifacts?: readonly string[];
    runErrors?: readonly string[];
  },
>(options: {
  command: readonly string[];
  env?: NodeJS.ProcessEnv;
  reportPath: string;
  driverLogPath: string;
  mirrorOutput?: boolean;
  createFallbackReport: (exitCode: number) => T;
}): Promise<{
  exitCode: number;
  signalCode: NodeJS.Signals | null;
  report: T;
}> {
  if (options.command.length === 0)
    throw new Error("qualification process command must not be empty");
  fs.mkdirSync(path.dirname(options.driverLogPath), { recursive: true });
  fs.rmSync(options.reportPath, { force: true });
  const logFile = fs.openSync(options.driverLogPath, "w");
  const mirrorOutput = options.mirrorOutput ?? true;
  let exitCode = 1;
  let signalCode: NodeJS.Signals | null = null;
  let processFailure: string | undefined;

  try {
    const child = spawn(options.command[0], [...options.command.slice(1)], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = (chunk: Buffer, destination: NodeJS.WriteStream): void => {
      fs.writeSync(logFile, chunk);
      if (mirrorOutput) destination.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => relay(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => relay(chunk, process.stderr));

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("error", (error) => {
        const message = `qualification process error: ${error.message}`;
        processFailure = message;
        fs.writeSync(logFile, `${message}\n`);
        if (mirrorOutput) process.stderr.write(`${message}\n`);
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    exitCode = result.code ?? 1;
    signalCode = result.signal;
    if ((result.code ?? 1) !== 0 || result.signal !== null) {
      processFailure ??=
        `qualification process exited with code ${result.code ?? "null"} ` +
        `(signal ${result.signal ?? "none"})`;
    }
    if (result.signal) {
      const message = `qualification process terminated by ${result.signal}\n`;
      fs.writeSync(logFile, message);
      if (mirrorOutput) process.stderr.write(message);
    }
  } catch (error) {
    const message = `qualification process could not start: ${
      error instanceof Error ? error.message : String(error)
    }`;
    processFailure = message;
    fs.writeSync(logFile, `${message}\n`);
    if (mirrorOutput) process.stderr.write(`${message}\n`);
  } finally {
    fs.closeSync(logFile);
  }

  let report = fs.existsSync(options.reportPath)
    ? (JSON.parse(fs.readFileSync(options.reportPath, "utf8")) as T)
    : options.createFallbackReport(exitCode);
  if (processFailure) {
    report = {
      ...report,
      passed: false,
      runErrors: [...new Set([...(report.runErrors ?? []), processFailure])],
    };
  }
  if (exitCode !== 0 || !report.passed) {
    report = addQualificationFailureArtifact(report, options.driverLogPath);
  }
  writeQualificationArtifact(options.reportPath, report);
  return { exitCode, signalCode, report };
}

export async function executeQualificationRun<T>(options: {
  outputPath: string;
  execute: (runErrors: string[]) => Promise<void>;
  createReport: (runErrors: readonly string[]) => T;
}): Promise<T> {
  const runErrors: string[] = [];
  let failure: unknown;
  try {
    await options.execute(runErrors);
  } catch (error) {
    failure = error;
    runErrors.push(error instanceof Error ? error.message : String(error));
  }

  let report: T;
  try {
    report = options.createReport(runErrors);
  } catch (error) {
    failure ??= error;
    runErrors.push(
      `report construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeQualificationArtifact(options.outputPath, {
      passed: false,
      runErrors,
    });
    throw failure;
  }
  writeQualificationArtifact(options.outputPath, report);
  if (failure) throw failure;
  return report;
}

export interface MacStartupMeasurement {
  coldTotalMs: number;
  warmShowMs: number | null;
}

/** Observable phase attribution emitted by the macOS startup qualifier. */
export interface MacStartupPhases {
  processEntryMs: number;
  nativeWindowMs: number;
  frameworkNavigationMs: number;
  documentBootMs: number;
  requiredAppWorkMs: number;
  frameSchedulingMs: number;
  readinessIpcMs: number;
  unattributedMs: number;
}

export interface AttributedMacStartupMeasurement
  extends MacStartupMeasurement {
  readinessTotalMs: number;
  /** process-entry through readiness IPC receipt: the whole in-process window. */
  launchTotalMs: number;
  phases: MacStartupPhases;
  firstFunctionalFrame: "observed" | "not-observed";
  firstFunctionalFrameMs: number | null;
  inputOutcome: "verified" | "not-verified";
  inputReadyMs: number | null;
}

export interface MacStartupQualificationConditions {
  launchMethod: string;
  cachePolicy: string;
  focus: string;
  visibility: string;
}

export interface HalfBounceQualification {
  status: "qualified" | "unqualified" | "missed";
  deadlineMs: number | null;
  reason: string;
}

/** The subset of a native build manifest verified against the binary on disk. */
export type VerifiedNativeBuild = NativeQualificationReport["build"];

export interface InteractiveMacStartupEvidence {
  buildSha256: string;
  hardwareModel: string;
  launchMethod: "launch-services-normal-application-launch";
  cachePolicy: string;
  focus: string;
  visibility: string;
  halfBounceDeadlineMs: number;
  samples: Array<{
    log: string;
    firstFunctionalFrameMs: number;
    inputReadyMs: number;
    launchRecording: string;
    nativeTrace: string;
  }>;
}

/**
 * Resolve an evidence-supplied path inside the retained qualification root.
 * Symlinks are followed first, so a link inside the root cannot smuggle in a
 * reference to a recording or trace that the run does not retain.
 */
function resolveEvidencePath(
  realRoot: string,
  candidate: unknown,
  label: string,
): string {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`interactive evidence requires a ${label} path`);
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`interactive evidence ${label} does not exist: ${candidate}`);
  }
  return resolveQualificationArtifactPath(realRoot, real);
}

function requiredCondition(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`interactive evidence requires a non-empty ${field}`);
  }
  return value;
}

function requiredOutcomeMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`interactive evidence ${label} must be a non-negative number`);
  }
  return value;
}

/** Load externally captured, same-run interactive evidence without trusting paths or provenance. */
export function loadInteractiveMacStartupEvidence(
  evidencePath: string,
  qualificationRoot: string,
  build: VerifiedNativeBuild,
  hardwareModel: string,
  requestedSamples: number,
): InteractiveMacStartupEvidence {
  const realRoot = fs.realpathSync(qualificationRoot);
  const safeEvidencePath = resolveEvidencePath(realRoot, evidencePath, "evidence file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(safeEvidencePath, "utf8"));
  } catch {
    throw new Error(`interactive evidence is not valid JSON: ${safeEvidencePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("interactive evidence must be a JSON object");
  }
  const evidence = parsed as Partial<InteractiveMacStartupEvidence>;
  if (evidence.buildSha256 !== build.binarySha256) {
    throw new Error("interactive evidence build SHA-256 does not match the verified binary");
  }
  if (evidence.hardwareModel !== hardwareModel) {
    throw new Error("interactive evidence hardware model does not match this Mac");
  }
  if (evidence.launchMethod !== "launch-services-normal-application-launch") {
    throw new Error("interactive evidence must use the normal Launch Services application path");
  }
  const cachePolicy = requiredCondition(evidence.cachePolicy, "cachePolicy");
  const focus = requiredCondition(evidence.focus, "focus");
  const visibility = requiredCondition(evidence.visibility, "visibility");
  const halfBounceDeadlineMs = evidence.halfBounceDeadlineMs;
  if (
    typeof halfBounceDeadlineMs !== "number" ||
    !Number.isFinite(halfBounceDeadlineMs) ||
    halfBounceDeadlineMs <= 0
  ) {
    throw new Error("interactive evidence requires a positive measured half-bounce deadline");
  }
  if (
    !Array.isArray(evidence.samples) ||
    evidence.samples.length !== requestedSamples
  ) {
    throw new Error(`interactive evidence requires exactly ${requestedSamples} samples`);
  }
  const samples = evidence.samples.map((sample, index) => {
    if (typeof sample !== "object" || sample === null) {
      throw new Error(`interactive evidence sample ${index + 1} is not an object`);
    }
    const position = `sample ${index + 1}`;
    const resolveArtifact = (candidate: unknown, label: string): string => {
      const resolved = resolveEvidencePath(realRoot, candidate, `${position} ${label}`);
      if (!fs.statSync(resolved).isFile()) {
        throw new Error(`interactive evidence ${position} ${label} is not a file: ${resolved}`);
      }
      return resolved;
    };
    return {
      firstFunctionalFrameMs: requiredOutcomeMs(
        sample.firstFunctionalFrameMs,
        `${position} firstFunctionalFrameMs`,
      ),
      inputReadyMs: requiredOutcomeMs(sample.inputReadyMs, `${position} inputReadyMs`),
      log: resolveArtifact(sample.log, "startup log"),
      launchRecording: resolveArtifact(sample.launchRecording, "launch recording"),
      nativeTrace: resolveArtifact(sample.nativeTrace, "native trace"),
    };
  });
  return {
    buildSha256: build.binarySha256,
    hardwareModel,
    launchMethod: "launch-services-normal-application-launch",
    cachePolicy,
    focus,
    visibility,
    halfBounceDeadlineMs,
    samples,
  };
}

export function buildInteractiveMacStartupQualificationReport(input: {
  evidencePath: string;
  qualificationRoot: string;
  build: VerifiedNativeBuild;
  platform: MacStartupQualificationReportInput["platform"];
  requestedSamples: number;
  timeoutMs: number;
  startedAt: string;
  finishedAt: string;
}) {
  const evidence = loadInteractiveMacStartupEvidence(
    input.evidencePath,
    input.qualificationRoot,
    input.build,
    input.platform.hardwareModel,
    input.requestedSamples,
  );
  const samples = evidence.samples.map((sample) => ({
    ...parseAttributedMacStartupLog(fs.readFileSync(sample.log, "utf8"), {
      firstFunctionalFrame: "observed",
      firstFunctionalFrameMs: sample.firstFunctionalFrameMs,
      inputOutcome: "verified",
      inputReadyMs: sample.inputReadyMs,
      measureWarm: false,
    }),
    log: sample.log,
  }));
  const artifacts = evidence.samples.flatMap((sample) => [
    sample.log,
    sample.launchRecording,
    sample.nativeTrace,
  ]);
  return buildMacStartupQualificationReport({
    build: input.build,
    platform: input.platform,
    scenario: {
      id: "macos-interactive-startup",
      requestedSamples: input.requestedSamples,
      timeoutMs: input.timeoutMs,
      warmMeasure: false,
      launchMethod: evidence.launchMethod,
      cachePolicy: evidence.cachePolicy,
      focus: evidence.focus,
      visibility: evidence.visibility,
      frameCriterion:
        "externally timed first presented functional frame with per-sample launch recording",
      inputCriterion:
        "externally timed successful real-input outcome with per-sample native trace",
    },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    samples,
    artifacts,
    errors: [],
    halfBounceDeadlineMs: evidence.halfBounceDeadlineMs,
  });
}

export interface MacStartupQualificationReportInput {
  build: VerifiedNativeBuild;
  platform: {
    os: "macos";
    release: string;
    arch: string;
    hardwareModel: string;
    cpu: string;
    memoryBytes: number;
  };
  scenario: MacStartupQualificationConditions & {
    id: string;
    requestedSamples: number;
    timeoutMs: number;
    warmMeasure: boolean;
    frameCriterion: string;
    inputCriterion: string;
  };
  startedAt: string;
  finishedAt: string;
  samples: readonly (AttributedMacStartupMeasurement & { log: string })[];
  artifacts: readonly string[];
  errors: readonly string[];
  halfBounceDeadlineMs: number | null;
}

export function buildMacStartupQualificationReport(
  input: MacStartupQualificationReportInput,
) {
  const samples = [...input.samples];
  const errors = [...input.errors];
  const halfBounce = qualifyHalfBounce(samples, input.halfBounceDeadlineMs);
  // An explicitly measured deadline that the evidence misses is a failed run,
  // not a green one with a footnote. `unqualified` (no deadline, or incomplete
  // interactive evidence) stays non-fatal: it claims nothing either way.
  if (halfBounce.status === "missed") errors.push(halfBounce.reason);
  return {
    schemaVersion: 2 as const,
    build: input.build,
    platform: input.platform,
    scenario: input.scenario,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    coldStartup: summarizeDurations(samples.map(({ coldTotalMs }) => coldTotalMs)),
    warmActivation: summarizeDurations(
      samples.flatMap(({ warmShowMs }) =>
        warmShowMs === null ? [] : [warmShowMs],
      ),
    ),
    phaseAttribution: summarizeMacStartupPhases(samples),
    halfBounce,
    samples,
    artifacts: [...input.artifacts],
    failureArtifacts: errors.length > 0 ? [...input.artifacts] : [],
    errors,
    passed: errors.length === 0 && samples.length === input.scenario.requestedSamples,
  };
}

export interface NativeStartupChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once: EventEmitter["once"];
  removeListener: EventEmitter["removeListener"];
  kill(signal?: NodeJS.Signals): boolean;
}

function durationToMilliseconds(value: string, unit: string): number {
  const duration = Number(value);
  switch (unit) {
    case "ns":
      return duration / 1_000_000;
    case "us":
    case "µs":
    case "μs":
      return duration / 1_000;
    case "ms":
      return duration;
    case "s":
      return duration * 1_000;
    default:
      throw new Error(`unsupported startup duration unit: ${unit}`);
  }
}

/**
 * How far the two wall-clock-correlated boundaries may disagree with the native
 * monotonic total before the sample is rejected. Ordinary scheduling jitter
 * between the two clocks is sub-millisecond; anything beyond this is a clock
 * step or a log that does not describe a single run.
 */
const CORRELATION_TOLERANCE_MS = 5;

function requiredNumber(
  match: RegExpMatchArray | null,
  index: number,
  marker: string,
): number {
  if (!match) throw new Error(`${marker} marker missing from macOS process log`);
  const value = Number(match[index]);
  if (!Number.isFinite(value)) throw new Error(`${marker} marker is not finite`);
  return value;
}

/**
 * Parse correlated native and webview markers into user-facing phase evidence.
 * Wall-clock correlation is used only at the two cross-runtime boundaries;
 * any disagreement with the native monotonic total remains unattributed.
 */
export function parseAttributedMacStartupLog(
  log: string,
  outcomes: Pick<
    AttributedMacStartupMeasurement,
    | "firstFunctionalFrame"
    | "firstFunctionalFrameMs"
    | "inputOutcome"
    | "inputReadyMs"
  > & { measureWarm?: boolean } = {
    firstFunctionalFrame: "not-observed",
    firstFunctionalFrameMs: null,
    inputOutcome: "not-verified",
    inputReadyMs: null,
  },
): AttributedMacStartupMeasurement {
  const duration = "([\\d.]+)(ns|us|µs|μs|ms|s)";
  const nativeWindow = log.match(
    new RegExp(
      `Startup\\(native-window\\):\\s*window=main\\s+app-run-epoch-ms=([\\d.]+)` +
        `\\s+process-entry-to-run=${duration}\\s+window-built=${duration}`,
    ),
  );
  const webviewLine =
    log.match(/Startup\(webview\):\s*window=main\s+[^\n]*/)?.[0] ?? null;
  const ready = log.match(
    new RegExp(
      `Startup\\(native-ready\\):\\s*window=main\\s+app-run-to-ready=${duration}\\s+receipt-epoch-ms=([\\d.]+)`,
    ),
  );
  const warm = log.match(
    new RegExp(`Startup\\(warm-activate\\):\\s*show=${duration}`),
  );

  if (!nativeWindow) throw new Error("native-window marker missing from macOS process log");
  const appRunEpochMs = requiredNumber(nativeWindow, 1, "native-window");
  const processEntryMs = durationToMilliseconds(nativeWindow[2], nativeWindow[3]);
  const windowBuiltMs = durationToMilliseconds(nativeWindow[4], nativeWindow[5]);
  const webviewMarker = (name: string): number => {
    const occurrences =
      webviewLine?.match(new RegExp(`(?<![\\w-])${name}=([\\d.]+)ms`, "g")) ?? [];
    if (occurrences.length > 1) {
      // The first occurrence wins, so a duplicate would silently move time out
      // of one phase and into the next with a zero residual to show for it.
      throw new Error(`${name} marker is recorded more than once`);
    }
    return requiredNumber(
      webviewLine?.match(new RegExp(`(?<![\\w-])${name}=([\\d.]+)ms`)) ?? null,
      1,
      name,
    );
  };
  const bootEpochMs = requiredNumber(
    webviewLine?.match(/boot-epoch-ms=([\d.]+)/) ?? null,
    1,
    "boot-epoch-ms",
  );
  const bundleExecMs = webviewMarker("bundle-exec");
  const listReadyMs = webviewMarker("list-ready");
  const settingsReadyMs = webviewMarker("settings-ready");
  const commandsReadyMs = webviewMarker("commands-ready");
  const appReadyMs = webviewMarker("app-ready");
  const uiReadyMs = webviewMarker("ui-ready");
  const webviewTotalMs = webviewMarker("total");
  if (!ready) throw new Error("native-ready marker missing from macOS process log");
  const readinessTotalMs = durationToMilliseconds(ready[1], ready[2]);
  const receiptEpochMs = requiredNumber(ready, 3, "receipt-epoch-ms");
  if (outcomes.measureWarm !== false && !warm) {
    throw new Error("warm-activate marker missing from macOS process log");
  }
  const warmShowMs = outcomes.measureWarm !== false && warm
    ? durationToMilliseconds(warm[1], warm[2])
    : null;

  if (
    listReadyMs < bundleExecMs ||
    settingsReadyMs < bundleExecMs ||
    commandsReadyMs < bundleExecMs ||
    appReadyMs < Math.max(listReadyMs, settingsReadyMs, commandsReadyMs) ||
    uiReadyMs < appReadyMs ||
    webviewTotalMs !== uiReadyMs
  ) {
    throw new Error("webview startup markers are not ordered");
  }
  const windowBuiltEpochMs = appRunEpochMs + windowBuiltMs;
  if (bootEpochMs < windowBuiltEpochMs) {
    throw new Error("document boot precedes the native window-built marker");
  }
  const uiReadyEpochMs = bootEpochMs + uiReadyMs;
  if (receiptEpochMs < uiReadyEpochMs) {
    throw new Error("readiness receipt precedes the ui-ready marker");
  }

  const phases: MacStartupPhases = {
    processEntryMs,
    nativeWindowMs: windowBuiltMs,
    frameworkNavigationMs: bootEpochMs - windowBuiltEpochMs,
    documentBootMs: bundleExecMs,
    requiredAppWorkMs: appReadyMs - bundleExecMs,
    frameSchedulingMs: uiReadyMs - appReadyMs,
    readinessIpcMs: receiptEpochMs - uiReadyEpochMs,
    unattributedMs: 0,
  };
  const attributedMs =
    phases.processEntryMs +
    phases.frameworkNavigationMs +
    phases.nativeWindowMs +
    phases.documentBootMs +
    phases.requiredAppWorkMs +
    phases.frameSchedulingMs +
    phases.readinessIpcMs;
  // The residual is measured against the full in-process window, so the
  // pre-`run` phase never inflates or deflates it. It stays a reported phase in
  // its own right and is never redistributed across the attributed phases.
  const launchTotalMs = Number((processEntryMs + readinessTotalMs).toFixed(3));
  phases.unattributedMs = Number((launchTotalMs - attributedMs).toFixed(3));
  // The residual is the whole point of this decomposition, so it must not be a
  // place for correlation failures to hide. The two epoch-correlated phases are
  // the only ones a wall-clock step (or a log holding two runs) can inflate;
  // when that happens the residual goes sharply negative instead of the phases
  // looking wrong. Reject the sample rather than publish a plausible fiction.
  if (phases.unattributedMs < -CORRELATION_TOLERANCE_MS) {
    throw new Error(
      "correlated startup clocks disagree with the native monotonic total: " +
        `residual ${phases.unattributedMs.toFixed(3)}ms`,
    );
  }

  return {
    coldTotalMs: readinessTotalMs,
    readinessTotalMs,
    launchTotalMs,
    warmShowMs,
    phases,
    firstFunctionalFrame: outcomes.firstFunctionalFrame,
    firstFunctionalFrameMs: outcomes.firstFunctionalFrameMs,
    inputOutcome: outcomes.inputOutcome,
    inputReadyMs: outcomes.inputReadyMs,
  };
}

type CompactDurationSummary = {
  sampleCount: number;
  p50: number | null;
  p95: number | null;
};

function compactSummary(values: readonly number[]): CompactDurationSummary {
  const summary = summarizeDurations(values);
  return {
    sampleCount: summary.sampleCount,
    p50: summary.p50Ms,
    p95: summary.p95Ms,
  };
}

export function summarizeMacStartupPhases(
  samples: readonly AttributedMacStartupMeasurement[],
): Record<
  keyof MacStartupPhases | "readinessTotalMs" | "launchTotalMs",
  CompactDurationSummary
> {
  const phase = (key: keyof MacStartupPhases): number[] =>
    samples.map((sample) => sample.phases[key]);
  return {
    readinessTotalMs: compactSummary(samples.map((sample) => sample.readinessTotalMs)),
    launchTotalMs: compactSummary(samples.map((sample) => sample.launchTotalMs)),
    processEntryMs: compactSummary(phase("processEntryMs")),
    nativeWindowMs: compactSummary(phase("nativeWindowMs")),
    frameworkNavigationMs: compactSummary(phase("frameworkNavigationMs")),
    documentBootMs: compactSummary(phase("documentBootMs")),
    requiredAppWorkMs: compactSummary(phase("requiredAppWorkMs")),
    frameSchedulingMs: compactSummary(phase("frameSchedulingMs")),
    readinessIpcMs: compactSummary(phase("readinessIpcMs")),
    unattributedMs: compactSummary(phase("unattributedMs")),
  };
}

export function qualifyHalfBounce(
  samples: readonly AttributedMacStartupMeasurement[],
  deadlineMs: number | null,
): HalfBounceQualification {
  if (deadlineMs === null) {
    return {
      status: "unqualified",
      deadlineMs,
      reason: "no measured half-bounce deadline was supplied",
    };
  }
  if (
    samples.length === 0 ||
    samples.some(
      (sample) =>
        sample.firstFunctionalFrame !== "observed" ||
        sample.firstFunctionalFrameMs === null ||
        sample.inputOutcome !== "verified" ||
        sample.inputReadyMs === null,
    )
  ) {
    return {
      status: "unqualified",
      deadlineMs,
      reason: "visible functional-frame and verified-input evidence is incomplete",
    };
  }
  const p95 = summarizeDurations(
    samples.map((sample) =>
      Math.max(sample.firstFunctionalFrameMs!, sample.inputReadyMs!),
    ),
  ).p95Ms!;
  return p95 <= deadlineMs
    ? {
        status: "qualified",
        deadlineMs,
        reason: `visible-and-input-functional p95 ${p95.toFixed(1)}ms met the measured ${deadlineMs.toFixed(1)}ms deadline`,
      }
    : {
        status: "missed",
        deadlineMs,
        reason: `visible-and-input-functional p95 ${p95.toFixed(1)}ms exceeded the measured ${deadlineMs.toFixed(1)}ms deadline`,
      };
}

/**
 * The direct-process qualifier's readiness predicate. It deliberately uses the
 * SAME parser the report is built from: an independent "is it ready yet" regex
 * drifted from the emitted log format once already (#696) and, because the
 * runner only re-parsed afterwards, the drift was invisible until a Mac run.
 * Requiring the full attributed marker set also removes the race where
 * readiness was declared before the webview line had flushed.
 */
function parseDirectProcessStartupLog(
  log: string,
  options: { measureWarm?: boolean } = {},
): AttributedMacStartupMeasurement {
  return parseAttributedMacStartupLog(log, {
    firstFunctionalFrame: "not-observed",
    firstFunctionalFrameMs: null,
    inputOutcome: "not-verified",
    inputReadyMs: null,
    measureWarm: options.measureWarm,
  });
}

export function waitForMacStartupProcess(
  child: NativeStartupChild,
  readLog: () => string,
  options: {
    timeoutMs: number;
    survivalMs: number;
    pollMs?: number;
    measureWarm?: boolean;
  },
): Promise<AttributedMacStartupMeasurement> {
  return new Promise((resolve, reject) => {
    let completed = false;
    let survivalTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      clearInterval(pollTimer);
      if (survivalTimer) clearTimeout(survivalTimer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const fail = (error: Error): void => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      fail(
        new Error(
          `application exited before startup qualification completed (code ${code}, signal ${signal ?? "none"})`,
        ),
      );
    };
    const onError = (error: Error): void => {
      fail(new Error(`application process error: ${error.message}`));
    };
    const succeedAfterSurvival = (
      measurement: AttributedMacStartupMeasurement,
    ): void => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      survivalTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode, child.signalCode);
          return;
        }
        if (completed) return;
        completed = true;
        cleanup();
        resolve(measurement);
      }, options.survivalMs);
    };
    const inspectLog = (): void => {
      if (survivalTimer || completed) return;
      try {
        succeedAfterSurvival(parseDirectProcessStartupLog(readLog(), options));
      } catch {
        // Keep collecting the scenario's required native markers until the bound.
      }
    };

    const timeoutTimer = setTimeout(
      () =>
        fail(new Error(`startup markers missing after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    const pollTimer = setInterval(inspectLog, options.pollMs ?? 25);
    child.once("exit", onExit);
    child.once("error", onError);
    inspectLog();
  });
}

async function waitForProcessExit(
  child: NativeStartupChild,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

export interface NativeQualificationProcess {
  label: string;
  child: NativeStartupChild | undefined;
}

export interface NativeProcessStopOptions {
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
}

async function stopNativeQualificationProcess(
  child: NativeStartupChild,
  label: string,
  options: NativeProcessStopOptions,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let gracefulAccepted = false;
  try {
    gracefulAccepted = child.kill();
  } catch {
    // A rejected graceful signal still requires a forced cleanup attempt.
  }
  if (
    gracefulAccepted &&
    (await waitForProcessExit(child, options.gracefulTimeoutMs))
  ) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;

  let forceAccepted: boolean;
  try {
    forceAccepted = child.kill("SIGKILL");
  } catch (error) {
    throw new Error(
      `${label} SIGKILL was rejected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!forceAccepted) {
    throw new Error(`${label} SIGKILL was rejected`);
  }
  if (!(await waitForProcessExit(child, options.forceTimeoutMs))) {
    throw new Error(
      `${label} remained alive after SIGKILL for ${options.forceTimeoutMs}ms`,
    );
  }
}

export async function stopNativeQualificationProcesses(
  processes: readonly NativeQualificationProcess[],
  options: NativeProcessStopOptions = {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 2_000,
  },
): Promise<void> {
  const results = await Promise.allSettled(
    processes
      .filter(
        (process): process is { label: string; child: NativeStartupChild } =>
          process.child !== undefined,
      )
      .map(({ label, child }) =>
        stopNativeQualificationProcess(child, label, options),
      ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `native qualification cleanup failed: ${failures.join("; ")}`,
    );
  }
}

export function createNativeProcessCleanupHooks(options: {
  environment: NodeJS.ProcessEnv;
  stateEnvironmentKey: string;
  stop: () => Promise<void>;
  temporaryRoot?: string;
}): {
  prepare: () => void;
  cleanup: () => Promise<void>;
  complete: () => void;
} {
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  const directoryPrefix = "tauri-native-cleanup-";
  let preparedDirectory: string | undefined;

  const assertMarkerDirectory = (candidate: string): string => {
    const resolved = path.resolve(candidate);
    const relative = path.relative(temporaryRoot, resolved);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      !path.basename(resolved).startsWith(directoryPrefix)
    ) {
      throw new Error(`invalid native cleanup state directory: ${resolved}`);
    }
    return resolved;
  };

  return {
    prepare: () => {
      preparedDirectory = fs.mkdtempSync(
        path.join(temporaryRoot, directoryPrefix),
      );
      options.environment[options.stateEnvironmentKey] = preparedDirectory;
    },
    cleanup: async () => {
      try {
        await options.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const configuredDirectory =
          options.environment[options.stateEnvironmentKey];
        if (!configuredDirectory) {
          throw new Error(
            `native cleanup state directory unavailable: ${message}`,
          );
        }
        const markerDirectory = assertMarkerDirectory(configuredDirectory);
        writeQualificationArtifact(
          path.join(markerDirectory, `${process.pid}-${randomUUID()}.json`),
          { message },
        );
        throw error;
      }
    },
    complete: () => {
      delete options.environment[options.stateEnvironmentKey];
      if (!preparedDirectory) return;
      const markerDirectory = preparedDirectory;
      preparedDirectory = undefined;
      let failures: string[] = [];
      try {
        failures = fs
          .readdirSync(markerDirectory)
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => {
            const marker = JSON.parse(
              fs.readFileSync(path.join(markerDirectory, entry), "utf8"),
            ) as { message?: unknown };
            return typeof marker.message === "string"
              ? marker.message
              : `invalid cleanup marker ${entry}`;
          });
      } finally {
        fs.rmSync(markerDirectory, { recursive: true, force: true });
      }
      if (failures.length > 0) {
        throw new Error(
          `native qualification cleanup failed: ${failures.join("; ")}`,
        );
      }
    },
  };
}

export async function stopNativeStartupProcess(
  child: NativeStartupChild,
  options: NativeProcessStopOptions = {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 2_000,
  },
): Promise<void> {
  await stopNativeQualificationProcess(
    child,
    "native startup process",
    options,
  );
}

export function summarizeDurations(values: readonly number[]): {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
} {
  return {
    sampleCount: values.length,
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
  };
}
