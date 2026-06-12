/**
 * Filesystem-watcher-driven refresh against the built binary: files created
 * and deleted OUTSIDE the app (plain fs calls) must appear/disappear in the
 * listing without any UI action.
 *
 * This path is unreachable from browser-mode Playwright — the notify-based
 * watcher only exists in the Rust backend, and it is also what drives
 * automatic cross-pane refresh in dual-pane mode.
 */
import { browser, $, $$ } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-watch-"));

async function navigateTo(dir: string): Promise<void> {
  await $(".breadcrumbs-container").click();
  const pathInput = $(".path-input");
  await pathInput.waitForDisplayed();
  await pathInput.setValue(dir);
  await browser.keys(["Enter"]);
  await browser.waitUntil(
    async () => (await $(".breadcrumbs-container").getText()).includes(path.basename(dir)),
    { timeoutMsg: `breadcrumbs never showed ${dir}` },
  );
}

async function entryNames(): Promise<string[]> {
  return await $$(".entry-item .entry-name").map((el) => el.getText());
}

describe("filesystem watcher refresh", () => {
  before(() => {
    fs.writeFileSync(path.join(scratchDir, "existing.txt"), "hello\n");
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("a file created outside the app appears without any UI action", async () => {
    await navigateTo(scratchDir);
    await browser.waitUntil(async () => (await entryNames()).includes("existing.txt"), {
      timeoutMsg: "initial listing never loaded",
    });

    fs.writeFileSync(path.join(scratchDir, "external.txt"), "created externally\n");

    // No refresh, no keypress — the backend watcher must push the change.
    await browser.waitUntil(async () => (await entryNames()).includes("external.txt"), {
      timeout: 10_000,
      timeoutMsg: "watcher never surfaced the externally created file",
    });
  });

  it("a file deleted outside the app disappears without any UI action", async () => {
    fs.rmSync(path.join(scratchDir, "external.txt"));

    await browser.waitUntil(async () => !(await entryNames()).includes("external.txt"), {
      timeout: 10_000,
      timeoutMsg: "watcher never removed the externally deleted file",
    });
  });
});
