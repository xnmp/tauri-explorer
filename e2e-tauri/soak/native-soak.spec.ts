import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildNativeQualificationReport,
  type NativePlatform,
  type ResourceMeasurement,
  type ScenarioMeasurement,
  type SoakConfiguration,
} from "../native-qualification";
import { domText, entryNames, navigateTo } from "../specs/helpers";

const DEFAULT_DURATION_MS = 4 * 60 * 60 * 1_000;
const durationMs = Number.parseInt(
  process.env.SOAK_DURATION_MS ?? String(DEFAULT_DURATION_MS),
  10,
);
const maxCycles = process.env.SOAK_MAX_CYCLES
  ? Number.parseInt(process.env.SOAK_MAX_CYCLES, 10)
  : undefined;
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error("SOAK_DURATION_MS must be a positive integer");
}
if (
  maxCycles !== undefined &&
  (!Number.isFinite(maxCycles) || maxCycles <= 0)
) {
  throw new Error("SOAK_MAX_CYCLES must be a positive integer when provided");
}
const seed =
  process.env.SOAK_SEED ??
  `native-soak-${new Date().toISOString().slice(0, 10)}`;
const scenarios = [
  "window-workspace",
  "plugin-churn",
  "theme-accessibility-zoom",
  "preview-native-input",
] as const;
const configuration: SoakConfiguration = {
  durationMs,
  maxCycles,
  seed,
  scenarios,
};

const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "tauri-native-soak-"),
);
const workspaceA = path.join(scratchRoot, "workspace-a");
const workspaceB = path.join(scratchRoot, "workspace-b");
fs.mkdirSync(workspaceA);
fs.mkdirSync(workspaceB);
fs.writeFileSync(
  path.join(workspaceA, "qualification.md"),
  "# Native qualification\n\nreal backend",
);
fs.writeFileSync(
  path.join(workspaceB, "interruptions.txt"),
  "native interruption survived",
);

function nativePlatform(): NativePlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function scenarioOrder(cycle: number): readonly (typeof scenarios)[number][] {
  const offset = (hashSeed(seed) + cycle) % scenarios.length;
  return [...scenarios.slice(offset), ...scenarios.slice(0, offset)];
}

function processRows(): Array<{
  pid: number;
  parentPid: number;
  rssBytes: number;
  executable: string;
}> {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
      },
    );
    const parsed = JSON.parse(raw) as
      Record<string, unknown> | Array<Record<string, unknown>>;
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      rssBytes: Number(row.WorkingSetSize),
      executable: String(row.ExecutablePath ?? ""),
    }));
  }

  const raw = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,args="], {
    encoding: "utf8",
  });
  return raw
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([^\s]+)/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      executable: match[4],
    }));
}

function sampleNativeRss(sampledAtMs: number): ResourceMeasurement {
  const binaryName =
    process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer";
  const expectedBinary = path.resolve(
    "src-tauri",
    "target",
    "debug",
    binaryName,
  );
  const rows = processRows();
  const rootIds = new Set(
    rows
      .filter(
        ({ executable }) =>
          path.resolve(executable).toLowerCase() ===
          expectedBinary.toLowerCase(),
      )
      .map(({ pid }) => pid),
  );
  if (rootIds.size === 0)
    throw new Error(`native process not found at ${expectedBinary}`);

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (rootIds.has(row.parentPid) && !rootIds.has(row.pid)) {
        rootIds.add(row.pid);
        changed = true;
      }
    }
  }
  return {
    rssBytes: rows
      .filter(({ pid }) => rootIds.has(pid))
      .reduce((total, { rssBytes }) => total + rssBytes, 0),
    sampledAtMs,
  };
}

async function assertUsable(expectedPath: string): Promise<void> {
  await expect($(".file-list")).toBeDisplayed();
  await browser.waitUntil(
    async () =>
      (await $(".status-path").getAttribute("title")) === expectedPath,
    {
      timeoutMsg: `visible explorer path did not settle on ${expectedPath}`,
    },
  );
}

async function openPalette(query: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.setValue(query);
}

async function setDemoPluginEnabled(enabled: boolean): Promise<void> {
  await browser.keys(["Control", ","]);
  const dialog = $(".settings-dialog");
  await dialog.waitForDisplayed({ timeout: 5_000 });
  const row = $(
    "//div[contains(@class, 'setting-row')][.//*[contains(text(), 'Demo Plugin')]][1]",
  );
  await row.waitForExist();
  const checkbox = row.$('input[type="checkbox"]');
  if ((await checkbox.isSelected()) !== enabled)
    await row.$("label.toggle").click();
  await browser.waitUntil(
    async () => (await checkbox.isSelected()) === enabled,
  );
  await dialog.$(".close-btn").click();
  await dialog.waitForDisplayed({ reverse: true });
}

async function interruptSurface(cycle: number): Promise<void> {
  await browser.keys("Escape");
  if (cycle % 2 === 0) {
    await browser.keys("F5");
    await $(".file-list").waitForDisplayed();
  } else {
    await openPalette("no qualification command");
    await browser.keys("Escape");
    await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
  }
}

async function runWindowWorkspace(cycle: number): Promise<void> {
  const original = await browser.getWindowHandle();
  const before = new Set(await browser.getWindowHandles());
  await browser.keys(["Control", "n"]);
  await browser.waitUntil(
    async () =>
      (await browser.getWindowHandles()).some((handle) => !before.has(handle)),
    {
      timeout: 20_000,
      timeoutMsg: "native new-window command produced no WebDriver window",
    },
  );
  const created = (await browser.getWindowHandles()).find(
    (handle) => !before.has(handle),
  );
  if (!created) throw new Error("new native window handle disappeared");
  await browser.switchToWindow(created);
  await navigateTo(cycle % 2 === 0 ? workspaceA : workspaceB);
  await assertUsable(cycle % 2 === 0 ? workspaceA : workspaceB);
  await browser.closeWindow();
  await browser.switchToWindow(original);
  await navigateTo(cycle % 2 === 0 ? workspaceB : workspaceA);
  await assertUsable(cycle % 2 === 0 ? workspaceB : workspaceA);
}

async function runPluginChurn(): Promise<void> {
  await setDemoPluginEnabled(true);
  await openPalette("Demo: Hello");
  await $(
    "//li[contains(@class, 'command-item')][.//*[contains(text(), 'Demo: Hello')]]",
  ).click();
  await browser.waitUntil(
    async () =>
      (await domText(".toast")).includes("Hello from the demo plugin"),
    {
      timeoutMsg: "enabled demo plugin did not show its visible success toast",
    },
  );
  await setDemoPluginEnabled(false);
  await openPalette("Demo: Hello");
  expect(
    await $$(
      "//li[contains(@class, 'command-item')][.//*[contains(text(), 'Demo: Hello')]]",
    ),
  ).toHaveLength(0);
  await browser.keys("Escape");
}

async function runThemeAccessibilityZoom(): Promise<void> {
  const beforeTheme = await browser.execute(
    () => document.documentElement.dataset.theme ?? "",
  );
  await openPalette("Toggle Dark/Light Theme");
  expect(await $(".commands-list").getAttribute("role")).toBe("listbox");
  await browser.keys("Enter");
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => document.documentElement.dataset.theme ?? "",
      )) !== beforeTheme,
    {
      timeoutMsg:
        "first native keyboard theme toggle did not change the rendered theme",
    },
  );
  await browser.keys(["Control", "0"]);
  await browser.keys(["Control", "-"]);
  await browser.keys(["Control", "-"]);
  expect(
    Number.parseFloat(
      await browser.execute(() => document.documentElement.style.zoom),
    ),
  ).toBe(80);
  await browser.keys(["Control", "0"]);
  for (let step = 0; step < 5; step += 1) await browser.keys(["Control", "="]);
  expect(
    Number.parseFloat(
      await browser.execute(() => document.documentElement.style.zoom),
    ),
  ).toBe(150);
  await openPalette("Toggle Dark/Light Theme");
  await expect($(".command-palette-dialog")).toBeDisplayed();
  await browser.keys("Escape");
  await browser.keys(["Control", "0"]);
}

async function runPreviewNativeInput(cycle: number): Promise<void> {
  const workspace = cycle % 2 === 0 ? workspaceA : workspaceB;
  const filename = cycle % 2 === 0 ? "qualification.md" : "interruptions.txt";
  await navigateTo(workspace);
  await browser.waitUntil(async () => (await entryNames()).includes(filename));
  await browser.keys("Escape");
  await browser.keys(["Control", "Home"]);
  const entry = $(".entry-item.selected");
  await browser.waitUntil(
    async () => (await domText(".entry-item.selected")).includes(filename),
    {
      timeoutMsg: `native Ctrl+Home did not visibly select ${filename}`,
    },
  );
  if (filename.endsWith(".md")) {
    await browser.waitUntil(async () =>
      (await domText(".preview-markdown")).includes("Native qualification"),
    );
  } else {
    await browser.waitUntil(async () =>
      (await domText(".preview-text")).includes("native interruption survived"),
    );
  }
  expect(((await entry.getAttribute("class")) ?? "").includes("selected")).toBe(
    true,
  );
}

describe("extended real-native qualification soak", () => {
  it("keeps observable explorer workflows usable through deterministic churn", async () => {
    const startedAt = new Date();
    const started = Date.now();
    const measurements: ScenarioMeasurement[] = [];
    const resources: ResourceMeasurement[] = [];
    let failure: unknown;

    await $(".file-list").waitForDisplayed({ timeout: 15_000 });
    resources.push(sampleNativeRss(0));

    for (
      let cycle = 1;
      Date.now() - started < durationMs && (!maxCycles || cycle <= maxCycles);
      cycle += 1
    ) {
      for (const scenario of scenarioOrder(cycle)) {
        const scenarioStarted = Date.now();
        const failureArtifacts: string[] = [];
        try {
          await interruptSurface(cycle);
          if (scenario === "window-workspace") await runWindowWorkspace(cycle);
          if (scenario === "plugin-churn") await runPluginChurn();
          if (scenario === "theme-accessibility-zoom")
            await runThemeAccessibilityZoom();
          if (scenario === "preview-native-input")
            await runPreviewNativeInput(cycle);
          measurements.push({
            id: scenario,
            cycle,
            durationMs: Date.now() - scenarioStarted,
            outcome: "passed",
            failureArtifacts,
          });
        } catch (error) {
          const artifactDir = path.resolve(
            "qualification-results",
            `seed-${seed}`,
          );
          fs.mkdirSync(artifactDir, { recursive: true });
          const screenshot = path.join(
            artifactDir,
            `cycle-${cycle}-${scenario}.png`,
          );
          await browser.saveScreenshot(screenshot);
          failureArtifacts.push(screenshot);
          measurements.push({
            id: scenario,
            cycle,
            durationMs: Date.now() - scenarioStarted,
            outcome: "failed",
            failureArtifacts,
          });
          failure = error;
          break;
        }
        resources.push(sampleNativeRss(Date.now() - started));
      }
      if (failure) break;
    }

    resources.push(sampleNativeRss(Date.now() - started));
    const binaryName =
      process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer";
    const userAgent = await browser.execute(() => navigator.userAgent);
    const report = buildNativeQualificationReport({
      build: {
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        profile: "debug-custom-protocol-e2e-hooks",
        binary: path.resolve("src-tauri", "target", "debug", binaryName),
      },
      platform: {
        os: nativePlatform(),
        release: os.release(),
        arch: os.arch(),
        webview: userAgent,
        displayScale: await browser.execute(() => window.devicePixelRatio),
      },
      configuration,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      resources,
      scenarios: measurements,
    });
    fs.mkdirSync("qualification-results", { recursive: true });
    fs.writeFileSync(
      path.join("qualification-results", `${nativePlatform()}-${seed}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    if (failure) throw failure;
    expect(report.passed).toBe(true);
  });
});
