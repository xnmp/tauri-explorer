/**
 * Real-IPC file operation round-trip against the built Tauri binary:
 * navigate to a scratch directory, create a folder, rename it, trash it.
 * This is the only suite exercising the actual Rust backend end to end —
 * browser-mode Playwright runs against mock-invoke and cannot catch real
 * filesystem/IPC regressions.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Under $HOME (not /tmp) so trashing works on tmpfs-mounted /tmp setups —
// Freedesktop trash needs a Trash dir on the same mount or the home fallback.
const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-"));

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
  const names = await $$(".entry-item .entry-name").map((el) => el.getText());
  return names;
}

describe("file operations against the real backend", () => {
  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("creates a folder on the real filesystem", async () => {
    await navigateTo(scratchDir);

    await browser.keys(["Control", "Shift", "n"]);
    const input = $(".new-folder-input");
    await input.waitForDisplayed();
    await input.setValue("roundtrip");
    await browser.keys(["Enter"]);

    await browser.waitUntil(async () => (await entryNames()).includes("roundtrip"), {
      timeoutMsg: "created folder never appeared in the listing",
    });
    // The command must have hit the real filesystem
    expect(fs.existsSync(path.join(scratchDir, "roundtrip"))).toBe(true);
  });

  it("renames the folder via F2", async () => {
    const entry = $(".entry-item*=roundtrip");
    await entry.click();
    await browser.keys(["F2"]);

    const renameInput = $(".rename-input");
    await renameInput.waitForDisplayed();
    // Replace the whole name
    await browser.keys(["Control", "a"]);
    await renameInput.setValue("renamed-roundtrip");
    await browser.keys(["Enter"]);

    await browser.waitUntil(async () => (await entryNames()).includes("renamed-roundtrip"), {
      timeoutMsg: "renamed folder never appeared",
    });
    expect(fs.existsSync(path.join(scratchDir, "renamed-roundtrip"))).toBe(true);
    expect(fs.existsSync(path.join(scratchDir, "roundtrip"))).toBe(false);
  });

  it("moves the folder to trash via Delete", async () => {
    const entry = $(".entry-item*=renamed-roundtrip");
    await entry.click();
    await browser.keys(["Delete"]);

    const confirmBtn = $(".dialog .btn.danger");
    await confirmBtn.waitForDisplayed();
    await confirmBtn.click();

    await browser.waitUntil(
      async () => !(await entryNames()).includes("renamed-roundtrip"),
      { timeoutMsg: "trashed folder still listed" },
    );
    expect(fs.existsSync(path.join(scratchDir, "renamed-roundtrip"))).toBe(false);
  });
});
