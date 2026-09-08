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

export interface QualificationCase {
  id: string;
  risk: QualificationRisk;
  platforms: readonly NativePlatform[];
  scenario: string;
  userVisibleOutcome: string;
  proof: QualificationProof;
  required: boolean;
}

export interface SoakConfiguration {
  durationMs: number;
  maxCycles?: number;
  seed: string;
  scenarios: readonly string[];
}

export interface ResourceMeasurement {
  rssBytes: number;
  sampledAtMs: number;
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
  };
  platform: {
    os: NativePlatform;
    release: string;
    arch: string;
    webview: string;
  };
  configuration: SoakConfiguration;
  startedAt: string;
  finishedAt: string;
  resources: {
    baselineRssBytes: number;
    finalRssBytes: number;
    peakRssBytes: number;
  };
  timings: {
    sampleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  scenarios: readonly ScenarioMeasurement[];
  failureArtifacts: readonly string[];
  passed: boolean;
}
