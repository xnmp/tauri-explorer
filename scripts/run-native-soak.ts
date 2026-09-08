import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addQualificationFailureArtifact,
  buildNativeQualificationReport,
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
fs.mkdirSync(path.dirname(driverLogPath), { recursive: true });
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

const driverLog = fs.createWriteStream(driverLogPath, { flags: "w" });
const child = Bun.spawn(
  ["bunx", "wdio", "run", "e2e-tauri/wdio.soak.conf.ts"],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NATIVE_BUILD_MANIFEST: manifestPath,
    },
  },
);

async function relayOutput(
  stream: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    destination.write(value);
    driverLog.write(value);
  }
}

const output = Promise.all([
  relayOutput(child.stdout, process.stdout),
  relayOutput(child.stderr, process.stderr),
]);
const exitCode = await child.exited;
await output;
await new Promise<void>((resolve, reject) => {
  driverLog.once("error", reject);
  driverLog.end(resolve);
});

let report: Record<string, unknown>;
if (!fs.existsSync(reportPath)) {
  const message = `WebDriver exited before the native report was emitted (code ${exitCode})`;
  report = buildNativeQualificationReport({
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
    runErrors: [message],
  });
} else {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<
    string,
    unknown
  >;
}

if (exitCode !== 0 || !report.passed) {
  report = addQualificationFailureArtifact(report, driverLogPath);
}
writeQualificationArtifact(reportPath, report);

if (exitCode !== 0) throw new Error(`native soak WebDriver exited ${exitCode}`);
if (!report.passed) throw new Error("native soak report did not pass");
