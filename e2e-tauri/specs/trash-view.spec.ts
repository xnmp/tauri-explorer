/**
 * In-app Trash against the real backend (#863, #1208): disposable .txt and
 * .txt.txt files deleted through the app appear with their complete names and
 * original locations. Restore returns each exact payload to its original path,
 * drops its Trash row and refreshes the destination pane.
 *
 * This covers the real chain browser Playwright cannot: the `list_trash` IPC
 * and its serde shape, the Trash-scoped context-menu action, the
 * `restore_trash_items` mutation and destination publication.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { entryNames, entryPathSelector, navigateTo } from "./helpers";

const isWindows = process.platform === "win32";
// The Windows Shell may spell the original folder with different case.
const samePath = (left: string, right: string) =>
  isWindows ? left.toLowerCase() === right.toLowerCase() : left === right;

// Retained hidden tabs (#1173) keep their rows mounted; read the shown tab only.
const SHOWN_ROWS = ".pane-tree:not(.retained) .entry-item";

/**
 * The opaque `trash://` path of the shown row named `name`, or null while it is
 * not listed. One atomic DOM snapshot: a Restore refreshes the listing, so
 * WebDriver row handles enumerated before that refresh can name removed rows
 * (#1228). The path is built from the native entry ID, so it stays valid for
 * the next action across refreshes.
 */
async function trashRowPath(name: string): Promise<string | null> {
  return browser.execute((rows: string, wanted: string) => {
    for (const row of Array.from(document.querySelectorAll(rows))) {
      if (row.querySelector(".entry-name")?.textContent?.trim() === wanted) return row.getAttribute("data-path");
    }
    return null;
  }, SHOWN_ROWS, name);
}

/** The listed row named `name`, re-resolved by its stable identity at each action. */
async function trashRow(name: string) {
  const entryPath = await browser.waitUntil(() => trashRowPath(name), {
    timeout: 20_000, timeoutMsg: "the deleted file is not listed in the Trash",
  });
  return $(entryPathSelector(entryPath, SHOWN_ROWS));
}

async function clickMenuItem(label: string): Promise<void> {
  await $(".context-menu").waitForDisplayed({ timeout: 5000 });
  for (const item of await $$(".context-menu .menu-item").getElements()) {
    const text = ((await item.getProperty("textContent")) as string | null) ?? "";
    if (text.trim() === label) {
      await item.click();
      return;
    }
  }
  throw new Error(`context-menu item "${label}" not found`);
}

(process.platform === "darwin" ? describe.skip : describe)("in-app Trash against the real backend (#863)", () => {
  // Under $HOME so the item and its Trash share a device on Linux.
  const directory = createNativeFixtureDirectory("tauri-explorer-trash-view-");
  // Short names keep both complete extensions legible in native evidence.
  const fixtures = [".txt", ".txt.txt"].map((suffix) => {
    const name = `trash-${process.pid}${suffix}`;
    return {
      name,
      original: path.join(directory, name),
      bytes: Buffer.from(`disposable ${suffix} bytes \u0000ÿ\n`, "latin1"),
    };
  });

  it("lists complete filenames the app deleted, restores their exact bytes and refreshes the destination", async () => {
    for (const { original, bytes } of fixtures) fs.writeFileSync(original, bytes);
    await navigateTo(directory);
    for (const { original } of fixtures) {
      await $(entryPathSelector(original)).waitForExist({ timeout: 15_000 });
      await browser.execute(
        (entryPath) => window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: { op: "delete", path: entryPath } })),
        original,
      );
      await browser.waitUntil(() => !fs.existsSync(original), {
        timeout: 25_000, timeoutMsg: "the app did not move the disposable file to the Trash",
      });
      await $(entryPathSelector(original)).waitForExist({ reverse: true, timeout: 15_000 });
    }

    // Open the Trash from the sidebar in a second tab, so the first tab stays
    // open on the destination folder.
    // Sessions restore earlier specs' tabs, so remember this one by identity.
    const destinationTab = await $(".tab.active").getAttribute("data-tab-id");
    expect(destinationTab).not.toBeNull();
    const tabs = (await $$(".tab").getElements()).length;
    await $('button[title^="New Tab"]').click();
    await browser.waitUntil(async () => (await $$(".tab").getElements()).length === tabs + 1, {
      timeoutMsg: "New Tab did not open a second tab",
    });
    await $('button[aria-label="Open Recycle Bin"]').click();
    await browser.waitUntil(async () => (await $(".status-path").getAttribute("title")) === "trash://", {
      timeoutMsg: "the sidebar did not open the in-app Trash",
    });
    for (const { name } of fixtures) {
      const row = await trashRow(name);
      const location = ((await row.$(".type-cell").getProperty("textContent")) as string | null)?.trim() ?? "";
      expect(samePath(location, directory)).toBe(true);
      // A matching textContent alone can still produce a clipped screenshot.
      const label = await row.$(".name-text");
      const width = Number(await label.getProperty("clientWidth"));
      expect(width).toBeGreaterThan(0);
      expect(Number(await label.getProperty("scrollWidth"))).toBeLessThanOrEqual(width);
      await expect(row).toBeDisplayed();
    }
    await browser.saveScreenshot("e2e-tauri/logs/863-trash-view-native.png");
    if (isWindows) {
      await browser.saveScreenshot("e2e-tauri/logs/1208-trash-filenames-native-windows.png");
      fs.writeFileSync("e2e-tauri/logs/1208-trash-filenames-native-windows.json", JSON.stringify({
        platform: process.platform,
        sourceCommit: process.env.GITHUB_SHA ?? null,
        capturedAt: new Date().toISOString(),
        names: fixtures.map(({ name }) => name),
        originalDirectory: directory,
      }, null, 2));
    }

    for (const { name, original, bytes } of fixtures) {
      await (await trashRow(name)).click({ button: "right" });
      await clickMenuItem("Restore");
      await browser.waitUntil(() => fs.existsSync(original), {
        timeout: 25_000, timeoutMsg: "Restore did not return the file to its original path",
      });
      expect(fs.readFileSync(original).equals(bytes)).toBe(true);
      await browser.waitUntil(async () => (await trashRowPath(name)) === null, {
        timeout: 15_000, timeoutMsg: "the restored item is still listed in the Trash",
      });
    }

    // The destination tab never navigated; its listing shows the restored file.
    await $(`.tab[data-tab-id="${destinationTab}"]`).click();
    await browser.waitUntil(async () => (await $(".tab.active").getAttribute("data-tab-id")) === destinationTab, {
      timeoutMsg: "the destination tab did not become active",
    });
    for (const { name } of fixtures) {
      await browser.waitUntil(async () => (await entryNames()).includes(name), {
        timeout: 15_000, timeoutMsg: "the destination pane did not show the restored file",
      });
    }
    expect(await $(".status-path").getAttribute("title")).toBe(directory);
  });
});
