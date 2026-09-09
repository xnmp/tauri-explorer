import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildNativeQualificationReport,
  executeLoggedQualificationProcess,
  readVerifiedNativeBuildManifest,
  resolveSoakConfiguration,
  writeQualificationArtifact,
  type NativePlatform,
  type SoakConfiguration,
} from "../e2e-tauri/native-qualification";

function nativePlatform(): NativePlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

const startedAt = new Date().toISOString();
const manifestPath = path.resolve(
  process.env.NATIVE_BUILD_MANIFEST ??
    "qualification-results/native-build.json",
);
let configuration: SoakConfiguration;
try {
  configuration = resolveSoakConfiguration(process.env);
} catch (error) {
  const outputPath = path.resolve(
    "qualification-results",
    `${nativePlatform()}-configuration-error.json`,
  );
  writeQualificationArtifact(outputPath, {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: false,
    runErrors: [error instanceof Error ? error.message : String(error)],
  });
  throw error;
}

const reportPath = path.resolve(
  "qualification-results",
  `${nativePlatform()}-${configuration.seed}.json`,
);
const driverLogPath = path.resolve(
  "qualification-results",
  `${nativePlatform()}-${configuration.seed}-webdriver.log`,
);
fs.rmSync(reportPath, { force: true });
let build;
try {
  build = readVerifiedNativeBuildManifest(manifestPath);
} catch (error) {
  writeQualificationArtifact(reportPath, {
    schemaVersion: 1,
    configuration,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: false,
    runErrors: [
      `native build provenance unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ],
  });
  throw error;
}

const { exitCode, report } = await executeLoggedQualificationProcess({
  command: ["bunx", "wdio", "run", "e2e-tauri/wdio.soak.conf.ts"],
  env: {
    ...process.env,
    NATIVE_BUILD_MANIFEST: manifestPath,
  },
  reportPath,
  driverLogPath,
  createFallbackReport: (code) =>
    buildNativeQualificationReport({
      build,
      platform: {
        os: nativePlatform(),
        release: os.release(),
        arch: os.arch(),
        webview: "unavailable: WebDriver session did not start",
        displayScale: null,
      },
      configuration,
      startedAt,
      finishedAt: new Date().toISOString(),
      resources: [],
      scenarios: [],
      runErrors: [
        `WebDriver exited before the native report was emitted (code ${code})`,
      ],
    }),
});

if (exitCode !== 0) throw new Error(`native soak WebDriver exited ${exitCode}`);
if (!report.passed) throw new Error("native soak report did not pass");
