/** Outcome-level macOS UI qualification through XCTest/Appium Mac2 (W5.3). */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remote, type Browser } from "webdriverio";
import { prepareMacosPdfFixtures, qualifyMacosPdf } from "./macos-pdf-preview";

const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const OUTPUT = path.resolve("qualification-results/macos-native-ui", RUN_ID);
const APP = path.resolve("src-tauri/target/release/bundle/macos/tauri-explorer.app");
const BUNDLE_ID = "io.github.xnmp.tauri-explorer";

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(command: string): string {
  return execFileSync("git", command.split(" "), { encoding: "utf8" }).trim();
}

async function run(): Promise<void> {
  const binary = path.join(APP, "Contents/MacOS/tauri-explorer");
  const builtBinary = path.resolve("src-tauri/target/release/tauri-explorer");
  fs.mkdirSync(OUTPUT, { recursive: true });

  const report = {
    schemaVersion: 1,
    runId: RUN_ID,
    sourceCommit: null as string | null,
    binary,
    binarySha256: null as string | null,
    binaryBytes: null as number | null,
    platform: { os: process.platform, release: os.release(), arch: os.arch() },
    driver: {
      requested: { appium: "3.8.0", mac2: "4.2.0" },
      observedAppiumVersion: null as string | null,
      observedMac2Version: null as string | null,
      observedInstalledDrivers: null as string | null,
    },
    fixture: null as { child: string; childName: string; parentName: string } | null,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    initialChildVisible: false,
    navigatedParentVisible: false,
    childAbsentAfterNavigation: false,
    pdfPreviewPassed: false,
    screenshot: path.join(OUTPUT, "navigated-parent.png"),
    error: null as string | null,
    passed: false,
  };
  let browser: Browser | undefined;
  let fixture: string | undefined;
  try {
    if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" ||
      process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
      throw new Error("macOS UI qualification requires a disposable hosted Mac runner");
    }
    report.sourceCommit = git("rev-parse HEAD");
    if (git("status --porcelain")) throw new Error("macOS UI qualification requires clean source");
    if (!fs.existsSync(binary) || !fs.existsSync(builtBinary) || sha256(binary) !== sha256(builtBinary)) {
      throw new Error("bundled app does not contain the qualified release binary");
    }
    report.binarySha256 = sha256(binary);
    report.binaryBytes = fs.statSync(binary).size;
    report.driver.observedAppiumVersion = execFileSync("appium", ["--version"], { encoding: "utf8" }).trim();
    report.driver.observedInstalledDrivers = execFileSync("appium", ["driver", "list", "--installed", "--json"], { encoding: "utf8" }).trim();
    const installedDrivers = JSON.parse(report.driver.observedInstalledDrivers) as { mac2?: { version?: unknown } };
    report.driver.observedMac2Version = typeof installedDrivers.mac2?.version === "string"
      ? installedDrivers.mac2.version : null;
    if (report.driver.observedAppiumVersion !== report.driver.requested.appium ||
      report.driver.observedMac2Version !== report.driver.requested.mac2) {
      throw new Error("installed Appium/Mac2 versions differ from the qualified pins");
    }

    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-macos-ui-"));
    const child = path.join(fixture, "child");
    fs.mkdirSync(child);
    const token = randomUUID().slice(0, 8);
    const childName = `child-visible-${token}.txt`;
    const parentName = `parent-visible-${token}.txt`;
    fs.writeFileSync(path.join(child, childName), "child fixture\n");
    fs.writeFileSync(path.join(fixture, parentName), "parent fixture\n");
    // Seed PDF files before launch so initial listings contain the fixtures,
    // independently of filesystem watcher registration and event delivery.
    prepareMacosPdfFixtures(fixture);
    report.fixture = { child, childName, parentName };

    // These Mac2-specific capabilities are valid W3C extension keys, but WDIO's
    // generic Appium type list does not yet describe the desktop driver.
    const capabilities: WebdriverIO.Capabilities & {
      "appium:appPath": string;
      "appium:arguments": string[];
      "appium:showServerLogs": boolean;
    } = {
      platformName: "mac",
      "appium:automationName": "mac2",
      "appium:bundleId": BUNDLE_ID,
      "appium:appPath": APP,
      "appium:arguments": [child],
      "appium:showServerLogs": true,
    };
    browser = await remote({
      hostname: "127.0.0.1",
      port: 4723,
      path: "/",
      logLevel: "warn",
      capabilities,
    });
    // XCTest snapshots the bundled app's accessibility tree. Unique fixture
    // names tie the result to a real listing, rather than a mocked backend.
    await browser.waitUntil(async () => {
      const source = await browser!.getPageSource();
      return source.includes(childName) && !source.includes(parentName);
    }, {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: `native WKWebView did not show child-only fixture ${childName}`,
    });
    report.initialChildVisible = true;
    fs.writeFileSync(path.join(OUTPUT, "initial-page-source.xml"), await browser.getPageSource());

    const up = await browser.$("-ios predicate string:label == 'Go up one level'");
    await up.waitForDisplayed({ timeout: 15_000 });
    await up.click();
    await browser.waitUntil(async () => {
      const source = await browser!.getPageSource();
      return source.includes(parentName) && !source.includes(childName);
    }, {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: "native Up action did not show parent-only fixture",
    });
    report.navigatedParentVisible = true;
    report.childAbsentAfterNavigation = true;
    fs.writeFileSync(path.join(OUTPUT, "final-page-source.xml"), await browser.getPageSource());
    await browser.saveScreenshot(report.screenshot);
    if (fs.statSync(report.screenshot).size <= 1_000) throw new Error("native screenshot is empty");
    await qualifyMacosPdf(browser, fixture, OUTPUT);
    report.pdfPreviewPassed = true;
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    if (browser) {
      try { await browser.saveScreenshot(path.join(OUTPUT, "failure.png")); } catch { /* session may be gone */ }
      try { fs.writeFileSync(path.join(OUTPUT, "failure-page-source.xml"), await browser.getPageSource()); } catch { /* session may be gone */ }
    }
  } finally {
    if (browser) {
      try { await browser.deleteSession(); } catch (error) {
        report.error ??= `driver teardown failed: ${String(error)}`;
        report.passed = false;
      }
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUTPUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  }
  if (!report.passed) throw new Error(report.error ?? "macOS UI qualification failed");
}

await run();
