import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "tauri-explorer.exe" : "tauri-explorer";
const application = path.resolve(
  here,
  "..",
  "src-tauri",
  "target",
  "debug",
  binaryName,
);

const tauriDriverBin = path.resolve(
  os.homedir(),
  ".cargo",
  "bin",
  isWindows ? "tauri-driver.exe" : "tauri-driver",
);

// On Windows, tauri-driver proxies WebDriver commands to msedgedriver.exe and
// needs an explicit path to it. GitHub windows runners preinstall it and
// export EDGEWEBDRIVER; locally, TAURI_NATIVE_DRIVER overrides.
const nativeDriver =
  process.env.TAURI_NATIVE_DRIVER ??
  (isWindows && process.env.EDGEWEBDRIVER
    ? path.join(process.env.EDGEWEBDRIVER, "msedgedriver.exe")
    : undefined);

const tauriDriverArgs = nativeDriver ? ["--native-driver", nativeDriver] : [];

let tauriDriver: ChildProcess | undefined;
let driverLog: WriteStream | undefined;

function recordDriverOutput(
  stream: NodeJS.ReadableStream,
  destination: NodeJS.WriteStream,
) {
  stream.on("data", (chunk: Buffer) => {
    destination.write(chunk);
    driverLog?.write(chunk);
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // No browserName: tauri-driver fills it in for the platform's native
      // driver. WDIO v9 defaults to WebDriver BiDi (webSocketUrl), which
      // WebKitWebDriver/msedgedriver reject with "Failed to match
      // capabilities" — enforce classic.
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application },
    } as WebdriverIO.Capabilities,
  ],
  // Keep the normal suite exhaustive. The Windows diagnostic run sets this to
  // stop after the first session-start failure, which makes the real timeout
  // and the driver transcript available instead of consuming the job cap.
  bail: process.env.TAURI_E2E_DIAGNOSTIC === "1" ? 1 : 0,
  logLevel: "info",
  outputDir: "./e2e-tauri/logs",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 3,
  hostname: "127.0.0.1",
  port: 4444,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: "./e2e-tauri/tsconfig.json" },
  },

  beforeSession: () => {
    mkdirSync(path.join(here, "logs"), { recursive: true });
    driverLog = createWriteStream(
      path.join(here, "logs", `driver-${process.pid}.log`),
    );
    console.info(`[tauri-e2e] spawning driver for ${application}`);
    tauriDriver = spawn(tauriDriverBin, tauriDriverArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (tauriDriver.stdout)
      recordDriverOutput(tauriDriver.stdout, process.stdout);
    if (tauriDriver.stderr)
      recordDriverOutput(tauriDriver.stderr, process.stderr);
    tauriDriver.once("error", (error) => {
      console.error(`[tauri-e2e] driver spawn failed: ${error.message}`);
      driverLog?.write(
        `[tauri-e2e] driver spawn failed: ${error.stack ?? error.message}\n`,
      );
    });
    tauriDriver.once("exit", (code, signal) => {
      const message = `[tauri-e2e] driver exited code=${code} signal=${signal}\n`;
      console.info(message.trim());
      driverLog?.end(message);
    });
  },

  afterSession: () => {
    console.info("[tauri-e2e] stopping driver after session teardown");
    tauriDriver?.kill();
  },
};
