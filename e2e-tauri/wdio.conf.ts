import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
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

const driverPort = 4444;
const driverLogPath = path.join(here, "logs", "msedgedriver.log");

let driverProcess: ChildProcess | undefined;
let applicationProcess: ChildProcess | undefined;

const waitForPort = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const reservePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a WebView2 debug port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const stopProcesses = (): void => {
  driverProcess?.kill();
  applicationProcess?.kill();
  driverProcess = undefined;
  applicationProcess = undefined;
};

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  exclude:
    process.env.VITE_E2E_NO_WARM_PRIME === "1"
      ? ["./specs/warm-window.spec.ts"]
      : [],
  maxInstances: 1,
  capabilities: [
    (isWindows
      ? {
          browserName: "webview2",
          "ms:edgeOptions": { debuggerAddress: "127.0.0.1:0" },
          "wdio:enforceWebDriverClassic": true,
        }
      : {
          // No browserName: tauri-driver fills it in for the platform's native
          // driver. WDIO v9 defaults to WebDriver BiDi (webSocketUrl), which
          // WebKitWebDriver rejects with "Failed to match capabilities" —
          // enforce classic.
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
  port: driverPort,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: "./e2e-tauri/tsconfig.json" },
  },

  beforeSession: async (_config, capabilities) => {
    if (!isWindows) {
      driverProcess = spawn(tauriDriverBin, tauriDriverArgs, {
        stdio: [null, process.stdout, process.stderr],
      });
      return;
    }

    if (!nativeDriver) {
      throw new Error("TAURI_NATIVE_DRIVER must point to msedgedriver.exe on Windows");
    }

    const debugPort = await reservePort();
    const edgeOptions = (
      capabilities as unknown as {
        "ms:edgeOptions": Record<string, unknown>;
      }
    )["ms:edgeOptions"];
    edgeOptions.debuggerAddress = `127.0.0.1:${debugPort}`;

    applicationProcess = spawn(application, [], {
      stdio: ["ignore", process.stdout, process.stderr],
      env: {
        ...process.env,
        TAURI_E2E_WEBVIEW2_DEBUG_PORT: String(debugPort),
      },
    });
    if (!(await waitForPort(debugPort, 30_000))) {
      stopProcesses();
      throw new Error(`WebView2 debug port ${debugPort} did not become reachable`);
    }

    mkdirSync(path.dirname(driverLogPath), { recursive: true });
    driverProcess = spawn(
      nativeDriver,
      [
        `--port=${driverPort}`,
        "--verbose",
        `--log-path=${driverLogPath}`,
        "--allowed-ips=",
      ],
      { stdio: ["ignore", process.stdout, process.stderr] },
    );
    if (!(await waitForPort(driverPort, 10_000))) {
      stopProcesses();
      throw new Error("msedgedriver did not start listening");
    }
  },

  afterSession: stopProcesses,
};
