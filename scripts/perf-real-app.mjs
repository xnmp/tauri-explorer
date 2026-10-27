#!/usr/bin/env node
/**
 * End-to-end folder-load and navigation timings against a real binary (#983).
 *
 * Drives the app through WebKitWebDriver (Linux, --target mode) with the
 * fixtures from `scripts/perf-fixtures.mjs`, and prints/writes JSON with
 * n, median and p95 per scenario. Real filesystem, real Rust, real IPC and
 * the real WebKitGTK renderer; no mock backend and no dev server.
 *
 *   env -u WAYLAND_DISPLAY GDK_BACKEND=x11 \
 *     xvfb-run -a --server-args="-screen 0 1920x1080x24" dbus-run-session -- \
 *     node scripts/perf-real-app.mjs --fixtures DIR --binary PATH [--runs 20] [--out FILE]
 *
 * The binary is unmodified: the runner only sets TAURI_WEBVIEW_AUTOMATION
 * (so WebKitGTK accepts the automation session) and WEBKIT_INSPECTOR_SERVER
 * (the socket WebKitWebDriver attaches to). Use the release build with
 * `custom-protocol` (see docs/performance.md); a bare `cargo build` binary
 * would dial the dev server instead.
 *
 * What is timed (all on the renderer's `performance.now()` clock, inside the
 * page, so WebDriver round trips are excluded):
 *   t0        the input event (double-click / click) is dispatched into the page
 *   firstRows a row of the destination folder is in the DOM and the status bar
 *             path names it, plus two animation-frame callbacks (a paint
 *             opportunity; not proof the compositor presented the pixels)
 *   complete  the status bar reports the folder's full entry count, plus two
 *             animation-frame callbacks
 * Scroll: the Details viewport is scrolled by a fixed step every animation
 * frame and the frame-to-frame intervals are recorded.
 *
 * Each run uses fresh private XDG config/data/cache/state directories, so
 * settings, history and caches from the desktop profile cannot leak in.
 * PERF_VERBOSE=1 prints every measurement to stderr as it happens.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { remote } from "webdriverio";

function parseArgs(argv) {
  const options = { runs: 20, port: 4458, out: null, fixtures: null, binary: null, scrollFrames: 300, scrollStep: 120, probeTimeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--fixtures": options.fixtures = path.resolve(value); i++; break;
      case "--binary": options.binary = path.resolve(value); i++; break;
      case "--runs": options.runs = Number(value); i++; break;
      case "--port": options.port = Number(value); i++; break;
      case "--out": options.out = path.resolve(value); i++; break;
      case "--scroll-frames": options.scrollFrames = Number(value); i++; break;
      case "--scroll-step": options.scrollStep = Number(value); i++; break;
      case "--probe-timeout-ms": options.probeTimeoutMs = Number(value); i++; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!options.fixtures || !options.binary) throw new Error("--fixtures and --binary are required");
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  return options;
}

/** Nearest-rank percentile of an ascending copy. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(values) {
  return {
    n: values.length,
    median: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function waitForPort(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.end(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing listened on port ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Runs in the page: arm observers, dispatch the input, resolve with timings. */
function measureInPage(spec, done) {
  const shown = () => document.querySelector(".pane-tree:not(.retained)") ?? document;
  const firstRowPath = () => shown().querySelector(".entry-item[data-path]")?.getAttribute("data-path") ?? null;
  const statusPath = () => document.querySelector(".status-path")?.getAttribute("title") ?? null;
  const statusCount = () => {
    const text = document.querySelector(".status-bar .status-item")?.textContent ?? "";
    const match = /^\s*(\d+)\s+items?/.exec(text);
    return match ? Number(match[1]) : null;
  };
  // Folders sort first, so a sort change is detected on the first rows'
  // order, not on the first row alone.
  const leadingRows = () => [...shown().querySelectorAll(".entry-item[data-path]")].slice(0, 10).map((row) => row.getAttribute("data-path")).join("\n");
  const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  const before = leadingRows();

  const conditions = spec.kind === "sort"
    ? {
        firstRows: () => !!document.querySelector(`.column-header.${spec.column}-column.active`) && leadingRows() !== before,
        complete: () => !!document.querySelector(`.column-header.${spec.column}-column.active`) && leadingRows() !== before,
      }
    : {
        firstRows: () => statusPath() === spec.path && firstRowPath() !== null && parentOf(firstRowPath()) === spec.path,
        complete: () => statusPath() === spec.path && statusCount() === spec.count,
      };

  const result = { dom: {}, frame: {} };
  let t0 = 0;
  let finished = false;
  const finish = (extra) => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    clearTimeout(timer);
    done({ ...result, ...extra, t0 });
  };
  const check = () => {
    for (const [name, met] of Object.entries(conditions)) {
      if (result.dom[name] !== undefined || !met()) continue;
      result.dom[name] = performance.now() - t0;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        result.frame[name] = performance.now() - t0;
        if (Object.keys(result.frame).length === Object.keys(conditions).length) finish({});
      }));
    }
  };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => finish({
    failure: "timeout",
    state: { statusPath: statusPath(), statusCount: statusCount(), firstRow: firstRowPath() },
  }), spec.timeoutMs);

  const target = spec.trigger.type === "dblclick"
    ? [...shown().querySelectorAll(".entry-item[data-path]")].find((row) => row.getAttribute("data-path") === spec.trigger.path)
    : document.querySelector(spec.trigger.selector);
  if (!target) {
    finish({
      failure: `trigger target missing: ${JSON.stringify(spec.trigger)}`,
      state: { statusPath: statusPath(), rows: [...shown().querySelectorAll(".entry-item[data-path]")].slice(0, 8).map((row) => row.getAttribute("data-path")) },
    });
    return;
  }
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["title", "class", "data-path"],
  });
  t0 = performance.now();
  if (spec.trigger.type === "dblclick") {
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
  } else {
    target.click();
  }
}

/** Runs in the page: scroll the Details viewport one step per frame. */
function scrollInPage(frames, step, done) {
  const viewport = (document.querySelector(".pane-tree:not(.retained)") ?? document).querySelector(".virtual-viewport");
  if (!viewport) { done({ failure: "no virtual viewport" }); return; }
  viewport.scrollTop = 0;
  const stamps = [];
  const start = viewport.scrollTop;
  let i = 0;
  const tick = (ts) => {
    stamps.push(ts);
    if (i++ < frames) {
      viewport.scrollTop += step;
      requestAnimationFrame(tick);
    } else {
      const intervals = stamps.slice(1).map((t, k) => t - stamps[k]);
      done({
        intervals,
        scrolledPx: viewport.scrollTop - start,
        rowsMounted: viewport.querySelectorAll(".entry-item").length,
        viewportHeight: viewport.clientHeight,
      });
    }
  };
  requestAnimationFrame(tick);
}

/** The forked app process: our binary, carrying this run's private profile. */
function findProcess(binary, profile) {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readlinkSync(`/proc/${pid}/exe`) !== binary) continue;
      if (fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(`XDG_CONFIG_HOME=${path.join(profile, "config")}`)) return Number(pid);
    } catch {
      // Not ours or already gone.
    }
  }
  return null;
}

function memorySnapshot(binary, appPid) {
  // The app process plus its WebKit children (web/network processes).
  const procs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map((pid) => {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const field = (k) => (new RegExp(`^${k}:\\s+(.*)$`, "m").exec(status)?.[1] ?? "").trim();
      let exe = "";
      try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* not ours */ }
      return { pid: Number(pid), ppid: Number(field("PPid")), name: field("Name"), exe, rssKb: parseInt(field("VmRSS"), 10) || 0 };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const app = procs.find((p) => p.pid === appPid && p.exe === binary);
  if (!app) return null;
  const children = procs.filter((p) => p.ppid === app.pid);
  return {
    appRssMb: app.rssKb / 1024,
    children: children.map((c) => ({ name: c.name, rssMb: c.rssKb / 1024 })),
    totalRssMb: (app.rssKb + children.reduce((s, c) => s + c.rssKb, 0)) / 1024,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "linux") throw new Error("this runner drives WebKitGTK through WebKitWebDriver; Linux only");
  if (process.env.WAYLAND_DISPLAY) {
    throw new Error("WAYLAND_DISPLAY is set: run under `env -u WAYLAND_DISPLAY ... xvfb-run` so the window stays off your desktop");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(options.fixtures, "manifest.json"), "utf8"));
  const rootCount = fs.readdirSync(options.fixtures).length;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-explorer-perf-profile-"));
  const env = { ...process.env, GDK_BACKEND: "x11" };
  for (const dir of ["CONFIG", "DATA", "CACHE", "STATE"]) {
    env[`XDG_${dir}_HOME`] = path.join(profile, dir.toLowerCase());
    fs.mkdirSync(env[`XDG_${dir}_HOME`], { recursive: true });
  }

  // The release binary forks into the background on Linux (main.rs), so a
  // driver that launches it (tauri-driver) loses the process it started.
  // Launch it ourselves with WebKit's remote inspector enabled and attach
  // WebKitWebDriver in --target mode instead. TAURI_WEBVIEW_AUTOMATION only
  // lets the web context accept the automation session.
  const inspector = options.port + 1;
  const launcher = spawn(options.binary, [options.fixtures], {
    env: { ...env, TAURI_WEBVIEW_AUTOMATION: "true", WEBKIT_INSPECTOR_SERVER: `127.0.0.1:${inspector}` },
    stdio: "ignore",
  });
  launcher.on("error", (error) => console.error(error));
  let appPid = null;
  let driver = null;
  let driverLog = "";

  const samples = [];
  let browser;
  try {
    await waitForPort(inspector, 30_000);
    appPid = findProcess(options.binary, profile);
    if (!appPid) throw new Error("launched app process not found");
    driver = spawn("WebKitWebDriver", [`--port=${options.port}`, `--target=127.0.0.1:${inspector}`], {
      env, stdio: ["ignore", "ignore", "pipe"],
    });
    driver.stderr.on("data", (chunk) => { driverLog = (driverLog + chunk).slice(-8_000); });
    await waitForPort(options.port);
    browser = await remote({
      hostname: "127.0.0.1",
      port: options.port,
      logLevel: "error",
      // WebKitWebDriver rejects WDIO v9's default BiDi upgrade.
      capabilities: { "wdio:enforceWebDriverClassic": true },
    });
    // Attach to the visible main window, not a parked (hidden) warm window.
    let attached = false;
    for (let attempt = 0; attempt < 100 && !attached; attempt++) {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        attached = await browser.execute(
          (p) => document.visibilityState === "visible" && document.querySelector(".status-path")?.getAttribute("title") === p,
          options.fixtures,
        ).catch(() => false);
        if (attached) break;
      }
      if (!attached) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!attached) throw new Error("no visible window showing the fixture root");
    await browser.setTimeout({ script: 180_000 });

    const measure = async (scenario, size, spec, record = true) => {
      const loadavg = os.loadavg();
      const result = await browser.executeAsync(measureInPage, { timeoutMs: options.probeTimeoutMs, ...spec });
      if (result.failure) throw new Error(`${scenario} (${size}): ${result.failure} ${JSON.stringify(result.state ?? {})}`);
      if (record) samples.push({ scenario, size, loadavg1: loadavg[0], ...result });
      if (process.env.PERF_VERBOSE) console.error(scenario, size, JSON.stringify(result.frame));
      return result;
    };
    const up = { type: "click", selector: '.nav-btn[aria-label="Go up one level"]' };
    const back = { type: "click", selector: '.nav-btn[aria-label="Go back"]' };
    const forward = { type: "click", selector: '.nav-btn[aria-label="Go forward"]' };
    const root = options.fixtures;
    const rootSpec = { kind: "dir", path: root, count: rootCount };

    // Wait for the launch listing of the fixture root.
    await browser.waitUntil(async () => (await browser.execute(
      (p) => document.querySelector(".status-path")?.getAttribute("title") === p
        && !!document.querySelector(".pane-tree:not(.retained) .entry-item[data-path]"),
      root,
    )), { timeout: 60_000, interval: 200, timeoutMsg: "fixture root never listed at launch" });
    const meta = await browser.execute(() => ({
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));

    const memory = {};
    // 1. Large-folder reference: enter each fixture folder from the root.
    for (const [label, folder] of Object.entries(manifest.folders)) {
      const dirSpec = { kind: "dir", path: folder.path, count: folder.visibleEntries, trigger: { type: "dblclick", path: folder.path } };
      for (let run = 0; run <= options.runs; run++) {
        // Run 0 is a discarded warm-up (populates the page cache and JIT).
        await measure("open-folder", label, dirSpec, run > 0);
        if (run === options.runs) memory[label] = memorySnapshot(options.binary, appPid);
        await measure("go-up-to-root", label, { ...rootSpec, trigger: up }, false);
      }
      console.error(`open-folder ${label}: done`);
    }

    // 2. Navigation on the 100k folder (falls back to the largest <= 100k).
    const navLabel = manifest.folders["100k"] ? "100k" : Object.keys(manifest.folders).at(-1);
    const nav = manifest.folders[navLabel];
    const sub = path.join(nav.path, manifest.subdir);
    const navSpec = { kind: "dir", path: nav.path, count: nav.visibleEntries };
    const subSpec = { kind: "dir", path: sub, count: 2 };
    for (let run = 0; run <= options.runs; run++) {
      const record = run > 0;
      await measure("enter-folder", navLabel, { ...navSpec, trigger: { type: "dblclick", path: nav.path } }, record);
      await measure("enter-subfolder", navLabel, { ...subSpec, trigger: { type: "dblclick", path: sub } }, false);
      await measure("go-up", navLabel, { ...navSpec, trigger: up }, record);
      await measure("back-to-subfolder", navLabel, { ...subSpec, trigger: back }, false);
      await measure("back", navLabel, { ...navSpec, trigger: back }, record);
      await measure("forward-to-subfolder", navLabel, { ...subSpec, trigger: forward }, false);
      await measure("forward", navLabel, { ...navSpec, trigger: forward }, record);
      await measure("sort-by-size", navLabel, { kind: "sort", column: "size", trigger: { type: "click", selector: ".pane-tree:not(.retained) .column-header.size-column" } }, record);
      await measure("sort-by-name", navLabel, { kind: "sort", column: "name", trigger: { type: "click", selector: ".pane-tree:not(.retained) .column-header.name-column" } }, record);
      if (record) {
        const loadavg = os.loadavg();
        const scroll = await browser.executeAsync(scrollInPage, options.scrollFrames, options.scrollStep);
        if (scroll.failure) throw new Error(`scroll: ${scroll.failure}`);
        samples.push({ scenario: "scroll", size: navLabel, loadavg1: loadavg[0], ...scroll });
      }
      await measure("go-up-to-root", navLabel, { ...rootSpec, trigger: up }, false);
    }
    console.error("navigation: done");

    const report = buildReport(samples, { options, meta, memory, manifest });
    const json = JSON.stringify(report, null, 2);
    if (options.out) fs.writeFileSync(options.out, `${json}\n`);
    console.log(json);
  } catch (error) {
    console.error(driverLog);
    throw error;
  } finally {
    await browser?.deleteSession().catch(() => {});
    driver?.kill("SIGTERM");
    if (appPid) {
      try { process.kill(appPid, "SIGTERM"); } catch { /* already gone */ }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function buildReport(samples, { options, meta, memory, manifest }) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.scenario}|${sample.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const scenarios = [...groups.entries()].map(([key, group]) => {
    const [scenario, size] = key.split("|");
    const loadavg = summarize(group.map((s) => s.loadavg1));
    if (scenario === "scroll") {
      const intervals = group.flatMap((s) => s.intervals);
      return {
        scenario, size, runs: group.length,
        frameIntervalMs: summarize(intervals),
        framesOver16_7: intervals.filter((v) => v > 1000 / 60 + 1).length,
        framesOver33_3: intervals.filter((v) => v > 1000 / 30 + 1).length,
        scrolledPxPerRun: group[0].scrolledPx,
        rowsMounted: group[0].rowsMounted,
        loadavg1: loadavg,
      };
    }
    return {
      scenario, size,
      entries: manifest.folders[size]?.entries,
      visibleEntries: manifest.folders[size]?.visibleEntries,
      firstRowsMs: summarize(group.map((s) => s.frame.firstRows)),
      completeMs: summarize(group.map((s) => s.frame.complete)),
      domCompleteMs: summarize(group.map((s) => s.dom.complete)),
      loadavg1: loadavg,
    };
  });
  return {
    date: new Date().toISOString(),
    binary: options.binary,
    runsPerScenario: options.runs,
    webview: meta,
    memoryAfterOpen: memory,
    scenarios,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
