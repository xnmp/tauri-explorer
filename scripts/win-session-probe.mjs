#!/usr/bin/env node
/**
 * #457 Windows session probe — one hypothesis per invocation.
 *
 * The Windows smoke leg fails at `POST /session`, so running a 15-minute suite
 * to learn that is pure waste. This asks the only question that matters —
 * "does a WebDriver session get created against the real binary?" — in a few
 * seconds, so many hypotheses can be tested concurrently in a matrix.
 *
 * Usage: node scripts/win-session-probe.mjs <variant>
 * Exit 0 = session created (hypothesis viable), 1 = it did not.
 *
 * Delete this together with the diagnostic workflow once #457 is closed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const variant = process.argv[2];
const repoRoot = path.resolve(import.meta.dirname, "..");
const app = path.join(
  repoRoot,
  "src-tauri",
  "target",
  "debug",
  "tauri-explorer.exe",
);
const logDir = path.join(repoRoot, "e2e-tauri", "logs");
mkdirSync(logDir, { recursive: true });

const edgeDriver = process.env.PROBE_MSEDGEDRIVER;
const tauriDriver = path.join(
  process.env.USERPROFILE ?? "",
  ".cargo",
  "bin",
  "tauri-driver.exe",
);
const PORT = 4444;
const DEBUG_PORT = 9222;

if (!existsSync(app)) {
  console.error(`[probe] missing app binary: ${app}`);
  process.exit(1);
}

/** Each variant: which driver to run, and what capabilities to send. */
const variants = {
  // Reproduce today's failure through tauri-driver. Control group.
  "baseline-tauri-driver": {
    driver: () => [tauriDriver, ["--native-driver", edgeDriver]],
    caps: {
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application: app },
    },
  },
  // Microsoft's documented "launch" shape, driver spoken to directly.
  "direct-webview2": {
    driver: () => [
      edgeDriver,
      [
        `--port=${PORT}`,
        "--verbose",
        `--log-path=${path.join(logDir, "msedgedriver.log")}`,
      ],
    ],
    caps: { browserName: "webview2", "ms:edgeOptions": { binary: app } },
  },
  // Same, but naming the app via args instead of binary — some driver builds
  // want the host app passed this way for non-Edge hosts.
  "direct-webview2-args": {
    driver: () => [
      edgeDriver,
      [
        `--port=${PORT}`,
        "--verbose",
        `--log-path=${path.join(logDir, "msedgedriver.log")}`,
      ],
    ],
    caps: {
      browserName: "webview2",
      "ms:edgeOptions": { binary: app, args: ["--remote-allow-origins=*"] },
    },
  },
  // Driver matched to the Edge *browser* on the runner rather than the
  // WebView2 runtime — tests whether the version-matching step picks wrong.
  "direct-edge-browser-driver": {
    driver: () => [
      path.join(process.env.EDGEWEBDRIVER ?? "", "msedgedriver.exe"),
      [
        `--port=${PORT}`,
        "--verbose",
        `--log-path=${path.join(logDir, "msedgedriver.log")}`,
      ],
    ],
    caps: { browserName: "webview2", "ms:edgeOptions": { binary: app } },
  },
  // The documented "attach" approach for apps that create multiple WebView2
  // instances: we launch the app with remote debugging on, driver attaches.
  "attach-debugger-address": {
    driver: () => [
      edgeDriver,
      [
        `--port=${PORT}`,
        "--verbose",
        `--log-path=${path.join(logDir, "msedgedriver.log")}`,
      ],
    ],
    caps: {
      browserName: "webview2",
      "ms:edgeOptions": { debuggerAddress: `127.0.0.1:${DEBUG_PORT}` },
    },
    preLaunchApp: true,
  },
  // Plain Edge automation as a sanity check: if even this hangs, the runner's
  // driver/runtime pairing is broken and nothing about our app is at fault.
  "sanity-plain-edge": {
    driver: () => [
      edgeDriver,
      [
        `--port=${PORT}`,
        "--verbose",
        `--log-path=${path.join(logDir, "msedgedriver.log")}`,
      ],
    ],
    caps: {
      browserName: "MicrosoftEdge",
      "ms:edgeOptions": { args: ["--headless=new"] },
    },
  },
};

const chosen = variants[variant];
if (!chosen) {
  console.error(
    `[probe] unknown variant "${variant}". Known: ${Object.keys(variants).join(", ")}`,
  );
  process.exit(1);
}

const waitForPort = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => (s.destroy(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const children = [];
const cleanup = () =>
  children.forEach((c) => {
    try {
      c.kill();
    } catch {}
  });

let appProc;
if (chosen.preLaunchApp) {
  console.log(
    `[probe] launching app with --remote-debugging-port=${DEBUG_PORT}`,
  );
  appProc = spawn(app, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
    },
  });
  children.push(appProc);
  const up = await waitForPort(DEBUG_PORT, 30_000);
  console.log(`[probe] remote debugging port reachable: ${up}`);
}

const [bin, args] = chosen.driver();
console.log(`[probe] variant=${variant}`);
console.log(`[probe] driver=${bin}`);
console.log(`[probe] args=${JSON.stringify(args)}`);
console.log(`[probe] caps=${JSON.stringify(chosen.caps)}`);

const driver = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
children.push(driver);
driver.on("error", (e) =>
  console.error(`[probe] driver spawn failed: ${e.message}`),
);

if (!(await waitForPort(PORT, 30_000))) {
  console.error("[probe] driver never listened on 4444");
  cleanup();
  process.exit(1);
}
console.log("[probe] driver listening; POST /session ...");

const started = Date.now();
let exitCode = 1;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capabilities: { alwaysMatch: chosen.caps, firstMatch: [{}] },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const elapsed = Date.now() - started;
  const text = await res.text();
  console.log(`[probe] RESULT status=${res.status} in ${elapsed}ms`);
  console.log(`[probe] body: ${text.slice(0, 1200)}`);
  if (res.ok) {
    exitCode = 0;
    try {
      const sessionId = JSON.parse(text)?.value?.sessionId;
      if (sessionId)
        await fetch(`http://127.0.0.1:${PORT}/session/${sessionId}`, {
          method: "DELETE",
        });
    } catch {}
  }
} catch (e) {
  console.error(
    `[probe] RESULT threw after ${Date.now() - started}ms: ${e?.name}: ${e?.message}`,
  );
}

cleanup();
console.log(
  `[probe] variant=${variant} verdict=${exitCode === 0 ? "SESSION CREATED" : "FAILED"}`,
);
process.exit(exitCode);
