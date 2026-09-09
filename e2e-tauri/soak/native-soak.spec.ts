import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SOAK_SCENARIOS,
  buildNativeQualificationReport,
  executeQualificationRun,
  measureProcessTreeRss,
  readVerifiedNativeBuildManifest,
  resolveSoakArtifactPaths,
  resolveSoakConfiguration,
  type NativeQualificationReport,
  type NativePlatform,
  type ResourceMeasurement,
  type ScenarioMeasurement,
  type SoakScenario,
} from "../native-qualification";
import { domText, entryNames, navigateTo } from "../specs/helpers";

const configuration = resolveSoakConfiguration(process.env);
const { durationMs, maxCycles, seed } = configuration;
const scenarios = SOAK_SCENARIOS;

let scratchRoot = "";
let workspaceA = "";
let workspaceB = "";

function initializeScratchWorkspaces(): void {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-native-soak-"));
  workspaceA = path.join(scratchRoot, "workspace-a");
  workspaceB = path.join(scratchRoot, "workspace-b");
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
}

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

function sampleNativeRss(
  sampledAtMs: number,
  expectedBinary: string,
): ResourceMeasurement {
  const rows = processRows();
  return measureProcessTreeRss(rows, expectedBinary, sampledAtMs);
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

async function assertExplorerUsable(): Promise<void> {
  await expect($(".file-list")).toBeDisplayed();
  await browser.waitUntil(
    async () =>
      ((await $(".status-path").getAttribute("title")) ?? "").length > 0,
    {
      timeoutMsg: "visible explorer lost its active path after a soak scenario",
    },
  );
}

async function assertInsideViewport(selector: string): Promise<void> {
  const contained = await browser.execute((target: string) => {
    const element = document.querySelector(target);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= window.innerWidth + 1 &&
      rect.bottom <= window.innerHeight + 1
    );
  }, selector);
  expect(contained).toBe(true);
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
  expect(await $(".command-palette-overlay").getAttribute("role")).toBe(
    "dialog",
  );
  expect(
    await $(".command-palette-overlay").getAttribute("aria-label"),
  ).toBe("Command palette");
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
  expect(
    Number.parseFloat(
      await browser.execute(() => document.documentElement.style.zoom),
    ),
  ).toBe(100);
  await assertExplorerUsable();
  await assertInsideViewport(".file-list");

  await openPalette("Toggle Dark/Light Theme");
  await assertInsideViewport(".command-palette-dialog");
  await browser.keys("Escape");

  await browser.keys(["Control", "-"]);
  await browser.keys(["Control", "-"]);
  expect(
    Number.parseFloat(
      await browser.execute(() => document.documentElement.style.zoom),
    ),
  ).toBe(80);
  await assertExplorerUsable();
  await assertInsideViewport(".file-list");
  await openPalette("Toggle Dark/Light Theme");
  await assertInsideViewport(".command-palette-dialog");
  await browser.keys("Escape");

  await browser.keys(["Control", "0"]);
  for (let step = 0; step < 5; step += 1) await browser.keys(["Control", "="]);
  expect(
    Number.parseFloat(
      await browser.execute(() => document.documentElement.style.zoom),
    ),
  ).toBe(150);
  await assertExplorerUsable();
  await assertInsideViewport(".file-list");
  await openPalette("Toggle Dark/Light Theme");
  await assertInsideViewport(".command-palette-dialog");
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const scenarioActions: Record<SoakScenario, (cycle: number) => Promise<void>> =
  {
    "window-workspace": runWindowWorkspace,
    "plugin-churn": async () => runPluginChurn(),
    "theme-accessibility-zoom": async () => runThemeAccessibilityZoom(),
    "preview-native-input": runPreviewNativeInput,
  };

describe("extended real-native qualification soak", () => {
  it("keeps observable explorer workflows usable through deterministic churn", async () => {
    const startedAt = new Date();
    const started = Date.now();
    const measurements: ScenarioMeasurement[] = [];
    const resources: ResourceMeasurement[] = [];
    const binaryName =
      process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer";
    let build: NativeQualificationReport["build"] = {
      commit: "unavailable",
      profile: "unavailable",
      binary: path.resolve("src-tauri", "target", "debug", binaryName),
      binarySha256: "unavailable",
      binaryBytes: 0,
      binaryModifiedAt: new Date(0).toISOString(),
    };
    const platform: NativeQualificationReport["platform"] = {
      os: nativePlatform(),
      release: os.release(),
      arch: os.arch(),
      webview: "unavailable",
      displayScale: null,
    };
    const artifactPaths = resolveSoakArtifactPaths(
      path.resolve("qualification-results"),
      nativePlatform(),
      seed,
    );
    const reportPath = artifactPaths.report;

    const report = await executeQualificationRun<NativeQualificationReport>({
      outputPath: reportPath,
      execute: async (runErrors) => {
        const sampleResource = (stage: string): void => {
          try {
            resources.push(
              sampleNativeRss(Date.now() - started, build.binary),
            );
          } catch (error) {
            runErrors.push(`${stage} RSS unavailable: ${errorText(error)}`);
          }
        };

        try {
          try {
            build = readVerifiedNativeBuildManifest(
              path.resolve(
                process.env.NATIVE_BUILD_MANIFEST ??
                  "qualification-results/native-build.json",
              ),
            );
          } catch (error) {
            runErrors.push(`build provenance unavailable: ${errorText(error)}`);
          }
          initializeScratchWorkspaces();
          await $(".file-list").waitForDisplayed({ timeout: 15_000 });
          platform.webview = await browser.execute(() => navigator.userAgent);
          platform.displayScale = await browser.execute(
            () => window.devicePixelRatio,
          );
          if (
            Math.abs(
              platform.displayScale - configuration.expectedDisplayScale,
            ) > 0.01
          ) {
            throw new Error(
              `native display scale ${platform.displayScale} did not match required ${configuration.expectedDisplayScale}`,
            );
          }
          sampleResource("baseline");

          for (
            let cycle = 1;
            Date.now() - started < durationMs &&
            (!maxCycles || cycle <= maxCycles);
            cycle += 1
          ) {
            for (const scenario of scenarioOrder(cycle)) {
              const scenarioStarted = Date.now();
              const failureArtifacts: string[] = [];
              try {
                await interruptSurface(cycle);
                await scenarioActions[scenario](cycle);
                await assertExplorerUsable();
                sampleResource(`cycle ${cycle} ${scenario}`);
                measurements.push({
                  id: scenario,
                  cycle,
                  durationMs: Date.now() - scenarioStarted,
                  outcome: "passed",
                  failureArtifacts,
                });
              } catch (error) {
                const artifactDir = artifactPaths.failureDirectory;
                try {
                  fs.mkdirSync(artifactDir, { recursive: true });
                  const screenshot = path.join(
                    artifactDir,
                    `cycle-${cycle}-${scenario}.png`,
                  );
                  await browser.saveScreenshot(screenshot);
                  failureArtifacts.push(screenshot);
                } catch (screenshotError) {
                  runErrors.push(
                    `failure screenshot unavailable: ${errorText(screenshotError)}`,
                  );
                }
                for (const logPath of [
                  path.resolve("e2e-tauri", "logs", "msedgedriver.log"),
                  path.resolve("logs"),
                ]) {
                  if (fs.existsSync(logPath)) failureArtifacts.push(logPath);
                }
                measurements.push({
                  id: scenario,
                  cycle,
                  durationMs: Date.now() - scenarioStarted,
                  outcome: "failed",
                  failureArtifacts,
                });
                throw error;
              }
            }
          }
        } finally {
          sampleResource("final");
          if (scratchRoot)
            fs.rmSync(scratchRoot, { recursive: true, force: true });
        }
      },
      createReport: (runErrors) =>
        buildNativeQualificationReport({
          build,
          platform,
          configuration,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          resources,
          scenarios: measurements,
          runErrors,
        }),
    });
    if (!report.passed) throw new Error(report.runErrors.join("; "));
  });
});
