/**
 * Config-file autoreload through the real Rust notify watcher (#605).
 *
 * Browser Playwright cannot prove this path: its IPC backend is a mock and no
 * OS watcher exists. These tests edit the real config files from Node while
 * the Tauri binary is running, then assert the rendered store consumers.
 */
import { browser, $ } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domTexts } from "./helpers";

const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-config-"));
const configDir = process.platform === "win32"
  ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "tauri-explorer")
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "tauri-explorer");
const bookmarksPath = path.join(configDir, "bookmarks.json");
const folderViewsPath = path.join(configDir, "folder-views.json");

type Backup = { existed: boolean; content: string };

function backup(file: string): Backup {
  return fs.existsSync(file)
    ? { existed: true, content: fs.readFileSync(file, "utf8") }
    : { existed: false, content: "" };
}

function restore(file: string, saved: Backup): void {
  if (saved.existed) fs.writeFileSync(file, saved.content);
  else fs.rmSync(file, { force: true });
}

async function runPaletteCommand(query: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.setValue(query);
  await browser.keys(["Enter"]);
}

async function navigateToScratch(): Promise<void> {
  await browser.execute((target) => {
    window.dispatchEvent(new CustomEvent("e2e-navigate", { detail: target }));
  }, scratchDir);
  await browser.waitUntil(
    async () => (await $(".file-list").getText()).includes("TXT"),
    { timeout: 10_000, timeoutMsg: "scratch directory never rendered" },
  );
}

describe("live external config edits", () => {
  const savedBookmarks = backup(bookmarksPath);
  const savedFolderViews = backup(folderViewsPath);

  before(() => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "external-config-proof.txt"), "proof\n");
  });

  after(() => {
    restore(bookmarksPath, savedBookmarks);
    restore(folderViewsPath, savedFolderViews);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("shows a bookmark written outside the running app without a restart", async () => {
    await navigateToScratch();
    fs.writeFileSync(bookmarksPath, JSON.stringify([
      { name: "External edit 605", path: scratchDir, icon: "folder" },
    ], null, 2));

    await browser.waitUntil(
      async () => (await domTexts(".user-bookmark")).some((text) => text.includes("External edit 605")),
      { timeout: 25_000, timeoutMsg: "external bookmarks.json edit never reached the sidebar" },
    );
    await browser.saveScreenshot("evidence/ac-1-bookmarks-live-external-edit.png");
  });

  it("applies an externally changed folder view to the current rendered tiles", async () => {
    await navigateToScratch();
    await runPaletteCommand("Tiles View");
    await $(".tiles-view").waitForDisplayed({ timeout: 5_000 });
    const tileIcon = $(".tile-icon");
    await tileIcon.waitForExist({ timeout: 10_000 });

    fs.writeFileSync(folderViewsPath, JSON.stringify({
      [scratchDir]: { thumbnailSize: "small" },
    }, null, 2));
    await browser.waitUntil(
      async () => Math.abs(parseFloat((await tileIcon.getCSSProperty("width")).value) - 48) < 0.1,
      { timeout: 25_000, timeoutMsg: "external small folder view never reached the tiles" },
    );
    await browser.saveScreenshot("evidence/ac-2-folder-view-live-external-edit.png");
  });
});
