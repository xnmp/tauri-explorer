import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveQualificationArtifactPath } from "./artifacts";
import { SOAK_SCENARIOS } from "./types";
import type { NativePlatform, SoakArtifactPaths, SoakConfiguration, SoakScenario } from "./types";

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
  const diagnosticScenario = env.SOAK_DIAGNOSTIC_SCENARIO;
  if (diagnosticScenario !== undefined &&
      !SOAK_SCENARIOS.some((scenario) => scenario === diagnosticScenario)) {
    throw new Error("SOAK_DIAGNOSTIC_SCENARIO must name a soak scenario");
  }
  if (diagnosticScenario !== undefined && env.SOAK_MAX_CYCLES === undefined) {
    throw new Error("SOAK_DIAGNOSTIC_SCENARIO requires SOAK_MAX_CYCLES");
  }
  const diagnosticWindowMode = env.SOAK_DIAGNOSTIC_WINDOW_MODE;
  if (diagnosticWindowMode !== undefined &&
      (diagnosticScenario !== "window-workspace" ||
        (diagnosticWindowMode !== "warm" && diagnosticWindowMode !== "fresh"))) {
    throw new Error("SOAK_DIAGNOSTIC_WINDOW_MODE requires a window-workspace diagnostic and must be warm or fresh");
  }
  const diagnosticMainOnly = env.SOAK_DIAGNOSTIC_MAIN_ONLY;
  if (diagnosticMainOnly !== undefined &&
      (diagnosticMainOnly !== "1" || diagnosticScenario !== "window-workspace" ||
        diagnosticWindowMode !== "fresh")) {
    throw new Error("SOAK_DIAGNOSTIC_MAIN_ONLY=1 requires a fresh window-workspace diagnostic");
  }
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
    scenarios: diagnosticScenario
      ? [diagnosticScenario as SoakScenario]
      : SOAK_SCENARIOS,
    expectedDisplayScale: positiveNumber(
      "SOAK_EXPECTED_DISPLAY_SCALE",
      env.SOAK_EXPECTED_DISPLAY_SCALE,
    ),
    ...(diagnosticWindowMode ? { diagnosticWindowMode } : {}),
    ...(diagnosticMainOnly ? { diagnosticMainOnly: true } : {}),
  };
  if (env.SOAK_MAX_CYCLES !== undefined) {
    resolved.maxCycles = positiveNumber("SOAK_MAX_CYCLES", env.SOAK_MAX_CYCLES);
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
    workerLogDirectory: resolveQualificationArtifactPath(
      root,
      `wdio-${seedComponent}`,
    ),
  };
}

export function resetSoakWorkerLogDirectory(
  root: string,
  workerLogDirectory: string,
): void {
  const resolvedRoot = path.resolve(root);
  if (path.dirname(workerLogDirectory) !== resolvedRoot) {
    throw new Error("soak worker logs must be directly under qualification root");
  }
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("qualification root must be a real directory");
  }
  // Same-seed reruns must not attach an earlier run's worker log. rmSync
  // removes a symlink itself rather than following it to its target.
  fs.rmSync(workerLogDirectory, { recursive: true, force: true });
  fs.mkdirSync(workerLogDirectory);
}
