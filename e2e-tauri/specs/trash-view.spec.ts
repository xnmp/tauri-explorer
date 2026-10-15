/**
 * In-app Trash against the real backend (#863): a disposable file deleted
 * through the app appears in the Trash opened from the sidebar with its
 * original location, and Restore returns the exact bytes to that path, drops
 * the Trash row and refreshes a pane still open on the destination folder.
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

/** The Trash row named `name`, or undefined while it is not listed. */
async function trashRow(name: string) {
  for (const row of await $$(".entry-item").getElements()) {
    const text = ((await row.$(".entry-name").getProperty("textContent")) as string | null)?.trim();
    if (text === name) return row;
  }
  return undefined;
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
  const name = `trash-view-863-${process.pid}-${Date.now()}.txt`;
  const original = path.join(directory, name);
  const bytes = Buffer.from("disposable trash-view bytes \u0000ÿ\n", "latin1");

  it("lists an item the app deleted, restores its exact bytes and refreshes the destination", async () => {
    fs.writeFileSync(original, bytes);
    await navigateTo(directory);
    await $(entryPathSelector(original)).waitForExist({ timeout: 15_000 });
    await browser.execute(
      (entryPath) => window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: { op: "delete", path: entryPath } })),
      original,
    );
    await browser.waitUntil(() => !fs.existsSync(original), {
      timeout: 25_000, timeoutMsg: "the app did not move the disposable file to the Trash",
    });
    await $(entryPathSelector(original)).waitForExist({ reverse: true, timeout: 15_000 });

    // Open the Trash from the sidebar in a second tab, so the first tab stays
    // open on the destination folder.
    const tabs = (await $$(".tab").getElements()).length;
    await $('button[title^="New Tab"]').click();
    await browser.waitUntil(async () => (await $$(".tab").getElements()).length === tabs + 1, {
      timeoutMsg: "New Tab did not open a second tab",
    });
    await $('button[aria-label="Open Recycle Bin"]').click();
    await browser.waitUntil(async () => (await $(".status-path").getAttribute("title")) === "trash://", {
      timeoutMsg: "the sidebar did not open the in-app Trash",
    });
    await browser.waitUntil(async () => (await trashRow(name)) !== undefined, {
      timeout: 20_000, timeoutMsg: "the deleted file is not listed in the Trash",
    });
    const row = (await trashRow(name))!;
    const location = ((await row.$(".type-cell").getProperty("textContent")) as string | null)?.trim() ?? "";
    expect(samePath(location, directory)).toBe(true);
    await browser.saveScreenshot("e2e-tauri/logs/863-trash-view-native.png");

    await row.click({ button: "right" });
    await clickMenuItem("Restore");
    await browser.waitUntil(() => fs.existsSync(original), {
      timeout: 25_000, timeoutMsg: "Restore did not return the file to its original path",
    });
    expect(fs.readFileSync(original).equals(bytes)).toBe(true);
    await browser.waitUntil(async () => (await trashRow(name)) === undefined, {
      timeout: 15_000, timeoutMsg: "the restored item is still listed in the Trash",
    });

    // The first tab never navigated; its listing shows the restored file.
    await (await $$(".tab").getElements())[0].click();
    await browser.waitUntil(async () => (await entryNames()).includes(name), {
      timeout: 15_000, timeoutMsg: "the destination pane did not show the restored file",
    });
    expect(await $(".status-path").getAttribute("title")).toBe(directory);
  });
});
