/** Real native maximize/restore observation and post-transition window health. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domTexts, navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-window-chrome-"));

async function geometry() {
  const { width, height } = await browser.getWindowSize();
  return { width, height };
}

async function diagnose(reason: string): Promise<void> {
  console.error("[window-chrome-diagnostics]", JSON.stringify({
    reason,
    geometry: await geometry().catch(() => null),
    nativeMaximized: await browser.execute(async () => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__?: { invoke<T>(command: string, args: unknown): Promise<T> };
      }).__TAURI_INTERNALS__;
      const label = document.documentElement.dataset.e2eWindowLabel;
      return internals && label
        ? await internals.invoke<boolean>("plugin:window|is_maximized", { label })
        : null;
    }).catch((error) => `query failed: ${String(error)}`),
    controls: await browser.execute(() => [...document.querySelectorAll(".window-controls button")].map((button) => ({
      label: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
    }))).catch(() => null),
    statusPath: await $(".status-path").getAttribute("title").catch(() => null),
    entries: await domTexts(".entry-name").catch(() => []),
    activeElement: await browser.execute(() => document.activeElement
      ? { tag: document.activeElement.tagName, classes: document.activeElement.className }
      : null).catch(() => null),
    bodyText: await browser.execute(() => document.body?.textContent?.slice(0, 4_000) ?? null).catch(() => null),
  }));
  await browser.saveScreenshot(`/tmp/window-chrome-${reason}.png`).catch(() => {});
}

describe("native window chrome", () => {
  before(() => {
    fs.writeFileSync(path.join(scratch, "window-restored.txt"), "healthy");
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("observes native maximize and restore while preserving explorer navigation", async () => {
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
    await $(".file-list").waitForExist({ timeout: 15_000 });
    await navigateTo(scratch);
    const initial = await geometry();

    try {
      await $("button[aria-label='Maximize']").click();
      await $("button[aria-label='Restore']").waitForDisplayed({ timeout: 10_000 });
      await browser.waitUntil(async () => {
        const maximized = await geometry();
        return maximized.width !== initial.width || maximized.height !== initial.height;
      }, { timeout: 10_000, timeoutMsg: "native maximize did not change viewport geometry" });
      fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
      await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-window-maximized.png");

      await $("button[aria-label='Restore']").click();
      await $("button[aria-label='Maximize']").waitForDisplayed({ timeout: 10_000 });
      await browser.waitUntil(async () => {
        const restored = await geometry();
        return restored.width === initial.width && restored.height === initial.height;
      }, { timeout: 10_000, timeoutMsg: "native restore did not recover prior viewport geometry" });

      await browser.waitUntil(async () => (await domTexts(".entry-name")).includes("window-restored.txt"), {
        timeout: 15_000,
        timeoutMsg: "explorer listing did not remain functional after native restore",
      });
      await expect($("button[aria-label='Maximize']")).toBeDisplayed();
    } catch (error) {
      await diagnose("maximize-restore-failure");
      throw error;
    }
  });
});
