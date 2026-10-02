import type { EventEmitter } from "node:events";

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

export interface NativeWindowVisibility {
  handle: string;
  visible: boolean;
}

export interface NativeWindowState {
  label: string;
  visible: boolean;
}

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
  diagnosticWindowMode?: "warm" | "fresh";
  diagnosticMainOnly?: boolean;
}

export interface SoakArtifactPaths {
  seedComponent: string;
  report: string;
  driverLog: string;
  failureDirectory: string;
  workerLogDirectory: string;
}

export interface ResourceMeasurement {
  rssBytes: number;
  sampledAtMs: number;
  webKitSharedMemoryFds?: number;
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
  windowMode?: "warm" | "fresh";
}

export interface NativeQualificationReport {
  schemaVersion: 1;
  harnessCommit?: string;
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
    samples: readonly ResourceMeasurement[];
    lateMedianGrowthBytes: number | null;
    maxAllowedLateGrowthBytes: number;
    baselineWebKitSharedMemoryFds: number | null;
    peakWebKitSharedMemoryFds: number | null;
    lateMedianWebKitSharedMemoryFdGrowth: number | null;
    maxAllowedWebKitSharedMemoryFdGrowth: number;
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
  harnessCommit?: string;
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

export interface MacStartupQualificationReportInput {
  build: VerifiedNativeBuild;
  platform: {
    os: "macos";
    release: string;
    arch: string;
    hardwareModel: string;
    cpu: string;
    memoryBytes: number;
    /** `sw_vers`; the Darwin `release` alone does not name the macOS build. */
    osProductVersion?: string | null;
    osBuildVersion?: string | null;
    /** System WebKit.framework CFBundleVersion, which crash reports cite (#942). */
    webKitVersion?: string | null;
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
  /** Samples that lost a renderer; never measurements (#942). */
  rendererLosses?: readonly RendererLossRecord[];
}

export interface RendererLossRecord {
  /** 1-based launch attempt; a recovered loss is replaced by a later attempt. */
  sample: number;
  recovered: boolean;
  description: string;
  log: string;
  /** Evidence directory, when one was captured. */
  evidence: string | null;
}

export interface NativeStartupChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once: EventEmitter["once"];
  removeListener: EventEmitter["removeListener"];
  kill(signal?: NodeJS.Signals): boolean;
}

export interface NativeQualificationProcess {
  label: string;
  child: NativeStartupChild | undefined;
}

export interface NativeProcessStopOptions {
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
}
