/**
 * Real-IPC file operation round-trip against the built Tauri binary:
 * navigate to a scratch directory, create a folder, rename it, trash it.
 * This is the only suite exercising the actual Rust backend end to end —
 * browser-mode Playwright runs against mock-invoke and cannot catch real
 * filesystem/IPC regressions.
 */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, entryNames } from "./helpers";

// Under $HOME (not /tmp) so trashing works on tmpfs-mounted /tmp setups —
// Freedesktop trash needs a Trash dir on the same mount or the home fallback.
const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-"));

/** Run a command-palette action by name. More robust headless than raw
 *  shortcuts: some Ctrl+Shift+<key> combos are swallowed by wry/the WM. */
async function runCommand(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label);
  // Top match is auto-selected; Enter runs it.
  await $(".command-item").waitForDisplayed();
  await browser.keys(["Enter"]);
}

describe("file operations against the real backend", () => {
  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("creates a folder on the real filesystem", async () => {
    await navigateTo(scratchDir);

    await runCommand("New Folder");
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
    // Select by data-path (text selectors hit the same getText clipping).
    const entry = $(`.entry-item[data-path="${path.join(scratchDir, "roundtrip")}"]`);
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
    const entry = $(`.entry-item[data-path="${path.join(scratchDir, "renamed-roundtrip")}"]`);
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
