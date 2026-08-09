import { spawn, type ChildProcess } from "node:child_process";
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

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  // warm-window.spec asserts the parked second webview exists, so it cannot run
  // against a build whose priming is suppressed. The Windows leg sets
  // VITE_E2E_NO_WARM_PRIME because msedgedriver cannot create a session while a
  // second WebView2 appears mid-attach (#457); Linux keeps the coverage.
  exclude:
    process.env.VITE_E2E_NO_WARM_PRIME === "1"
      ? ["./specs/warm-window.spec.ts"]
      : [],
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
    tauriDriver = spawn(tauriDriverBin, tauriDriverArgs, {
      stdio: [null, process.stdout, process.stderr],
    });
  },

  afterSession: () => {
    tauriDriver?.kill();
  },
};
