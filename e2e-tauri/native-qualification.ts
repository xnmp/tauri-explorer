import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
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
      env.SOAK_SEED?.trim() ||
      `native-soak-${new Date().toISOString().slice(0, 10)}`,
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
  T extends { passed?: boolean; failureArtifacts?: readonly string[] },
>(options: {
  command: readonly string[];
  env?: NodeJS.ProcessEnv;
  reportPath: string;
  driverLogPath: string;
  mirrorOutput?: boolean;
  createFallbackReport: (exitCode: number) => T;
}): Promise<{ exitCode: number; report: T }> {
  if (options.command.length === 0)
    throw new Error("qualification process command must not be empty");
  fs.mkdirSync(path.dirname(options.driverLogPath), { recursive: true });
  fs.rmSync(options.reportPath, { force: true });
  const logFile = fs.openSync(options.driverLogPath, "w");
  const mirrorOutput = options.mirrorOutput ?? true;
  let exitCode = 1;

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
        const message = `qualification process error: ${error.message}\n`;
        fs.writeSync(logFile, message);
        if (mirrorOutput) process.stderr.write(message);
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    exitCode = result.code ?? 1;
    if (result.signal) {
      const message = `qualification process terminated by ${result.signal}\n`;
      fs.writeSync(logFile, message);
      if (mirrorOutput) process.stderr.write(message);
    }
  } catch (error) {
    const message = `qualification process could not start: ${
      error instanceof Error ? error.message : String(error)
    }\n`;
    fs.writeSync(logFile, message);
    if (mirrorOutput) process.stderr.write(message);
  } finally {
    fs.closeSync(logFile);
  }

  let report = fs.existsSync(options.reportPath)
    ? (JSON.parse(fs.readFileSync(options.reportPath, "utf8")) as T)
    : options.createFallbackReport(exitCode);
  if (exitCode !== 0 || !report.passed) {
    report = addQualificationFailureArtifact(report, options.driverLogPath);
  }
  writeQualificationArtifact(options.reportPath, report);
  return { exitCode, report };
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
  warmShowMs: number;
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

export function parseMacStartupLog(log: string): MacStartupMeasurement {
  const duration = "([\\d.]+)(ns|us|µs|μs|ms|s)";
  const cold = log.match(new RegExp(`Startup:.*?total=${duration}`));
  const warm = log.match(
    new RegExp(`Startup\\(warm-activate\\):\\s*show=${duration}`),
  );
  if (!cold)
    throw new Error("cold Startup marker missing from macOS process log");
  if (!warm)
    throw new Error("warm-activate marker missing from macOS process log");
  return {
    coldTotalMs: durationToMilliseconds(cold[1], cold[2]),
    warmShowMs: durationToMilliseconds(warm[1], warm[2]),
  };
}

export function waitForMacStartupProcess(
  child: NativeStartupChild,
  readLog: () => string,
  options: { timeoutMs: number; survivalMs: number; pollMs?: number },
): Promise<MacStartupMeasurement> {
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
    const succeedAfterSurvival = (measurement: MacStartupMeasurement): void => {
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
        succeedAfterSurvival(parseMacStartupLog(readLog()));
      } catch {
        // Both native markers are required; keep collecting until the bound.
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

export async function stopNativeStartupProcess(
  child: NativeStartupChild,
  options: { gracefulTimeoutMs: number; forceTimeoutMs: number } = {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 2_000,
  },
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulAccepted = child.kill();
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
      `native startup process SIGKILL was rejected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!forceAccepted) {
    throw new Error("native startup process SIGKILL was rejected");
  }
  if (!(await waitForProcessExit(child, options.forceTimeoutMs))) {
    throw new Error(
      `native startup process remained alive after SIGKILL for ${options.forceTimeoutMs}ms`,
    );
  }
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
