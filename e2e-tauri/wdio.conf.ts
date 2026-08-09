import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
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

// On Windows, drive msedgedriver directly instead of proxying through
// tauri-driver (#457). Two reasons:
//   1. tauri-driver spawns msedgedriver with fixed arguments, so there is no
//      way to get `--verbose --log-path` out of it — and the Windows session
//      failure is *inside* msedgedriver's attach, which is precisely the part
//      no current log covers.
//   2. It lets us send the capabilities Microsoft documents for automating a
//      WebView2 host app (`browserName: "webview2"` + `ms:edgeOptions.binary`)
//      rather than whatever tauri-driver synthesises.
// Linux keeps tauri-driver: WebKitWebDriver works today and there is no reason
// to disturb a green leg.
const driveEdgeDirectly = isWindows && !!nativeDriver;

const driverLogPath = path.join(here, "logs", "msedgedriver.log");

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    // WDIO v9 defaults to WebDriver BiDi (webSocketUrl), which
    // WebKitWebDriver/msedgedriver reject with "Failed to match capabilities"
    // — enforce classic in both shapes below.
    (driveEdgeDirectly
      ? {
          // Microsoft's documented shape for automating a WebView2 host app:
          // msedgedriver launches `binary` and attaches to the first WebView2
          // instance it creates. (Selenium's EdgeOptions.UseWebView = true is
          // exactly this browserName.)
          browserName: "webview2",
          "ms:edgeOptions": { binary: application },
          "wdio:enforceWebDriverClassic": true,
        }
      : {
          // No browserName: tauri-driver fills it in for the platform's
          // native driver.
          "wdio:enforceWebDriverClassic": true,
          "tauri:options": { application },
        }) as WebdriverIO.Capabilities,
  ],
  logLevel: "info",
  bail: 0,
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
    if (driveEdgeDirectly) {
      mkdirSync(path.dirname(driverLogPath), { recursive: true });
      // --verbose + --log-path is the whole point of bypassing tauri-driver:
      // it is the only way to see what msedgedriver is waiting on during the
      // attach that currently times out (#457). --allowed-ips= (empty) keeps
      // it bound to loopback.
      tauriDriver = spawn(
        nativeDriver as string,
        [
          `--port=${4444}`,
          "--verbose",
          `--log-path=${driverLogPath}`,
          "--allowed-ips=",
        ],
        { stdio: [null, process.stdout, process.stderr] },
      );
    } else {
      tauriDriver = spawn(tauriDriverBin, tauriDriverArgs, {
        stdio: [null, process.stdout, process.stderr],
      });
    }
  },

  afterSession: () => {
    tauriDriver?.kill();
  },
};
