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
import { domTexts, navigateTo } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";

const scratchDir = createNativeFixtureDirectory("tauri-explorer-e2e-config-");
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

/**
 * Replace `file`'s content the way a real external editor or dotfile manager
 * does: write to a sibling temp file, then rename it over the target. This is
 * atomic on every platform (`ReplaceFileW`/`MoveFileExW` semantics through
 * Node's `fs.renameSync` on Windows, `rename(2)` on POSIX) and never leaves a
 * truncated file for the watcher to observe mid-write. An in-place
 * `writeFileSync` would prove the watcher sees ordinary content changes but
 * not that it survives its watched target's identity (inode/handle) changing
 * out from under it, which real editors do routinely (#800).
 */
function atomicReplace(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

async function runPaletteCommand(query: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.setValue(query);
  await browser.keys(["Enter"]);
}

async function navigateToScratch(): Promise<void> {
  await navigateTo(scratchDir);
  await browser.waitUntil(
    async () => (await domTexts(".entry-name")).includes("external-config-proof.txt"),
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
  });

  it("shows a bookmark written outside the running app without a restart", async () => {
    await navigateToScratch();
    atomicReplace(bookmarksPath, JSON.stringify([
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

    atomicReplace(folderViewsPath, JSON.stringify({
      [scratchDir]: { thumbnailSize: "small" },
    }, null, 2));
    await browser.waitUntil(
      async () => {
        const width = (await tileIcon.getCSSProperty("width")).value;
        return width !== undefined && Math.abs(parseFloat(width) - 48) < 0.1;
      },
      { timeout: 25_000, timeoutMsg: "external small folder view never reached the tiles" },
    );
    await browser.saveScreenshot("evidence/ac-2-folder-view-live-external-edit.png");
  });
});
