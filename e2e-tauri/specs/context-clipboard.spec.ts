/**
 * Real context-menu + clipboard round-trip against the built binary (#193).
 *
 * Copy via the right-click menu, paste via the background menu, assert the
 * duplicate exists ON DISK. This exercises the platform clipboard backend
 * end to end — on Windows that is the CF_HDROP/PowerShell path, exactly the
 * code browser-mode Playwright (mock invoke) can never touch.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, entryNames, domTexts } from "./helpers";

const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-clip-"));

/** Click the context-menu item whose label contains `label`. */
async function clickMenuItem(label: string): Promise<void> {
  const menu = $(".context-menu");
  await menu.waitForDisplayed({ timeout: 5000 });
  const items = $$(".context-menu .menu-item");
  for (const item of await items.getElements()) {
    const text = ((await item.getProperty("textContent")) as string | null) ?? "";
    if (text.includes(label)) {
      await item.click();
      return;
    }
  }
  throw new Error(`context-menu item "${label}" not found`);
}

describe("context-menu clipboard round-trip on the real backend", () => {
  before(() => {
    fs.writeFileSync(path.join(scratchDir, "original.txt"), "clipboard payload\n");
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("right-click opens the app context menu on an entry", async () => {
    await navigateTo(scratchDir);

    const entry = $(".entry-item");
    await entry.waitForDisplayed({ timeout: 10_000 });
    await entry.click({ button: "right" });

    await $(".context-menu").waitForDisplayed({ timeout: 5000 });
    const labels = await domTexts(".context-menu .menu-item");
    expect(labels.join(" ")).toContain("Copy");
  });

  it("copy + background paste duplicates the file on disk", async () => {
    await clickMenuItem("Copy");

    // Background right-click (below the single entry row) → Paste.
    const content = $(".file-list .content");
    await content.click({ button: "right", x: 40, y: 200 });
    await clickMenuItem("Paste");

    // The paste lands as a real file (name may be suffixed on collision —
    // here there is none, but assert on disk contents, not just the UI).
    await browser.waitUntil(
      async () => (await entryNames()).filter((n) => n.includes("original")).length >= 2,
      { timeoutMsg: "pasted copy never appeared in the listing" },
    );
    const copies = fs
      .readdirSync(scratchDir)
      .filter((n) => n.includes("original") && n.endsWith(".txt"));
    expect(copies.length).toBeGreaterThanOrEqual(2);
    for (const name of copies) {
      expect(fs.readFileSync(path.join(scratchDir, name), "utf8")).toBe("clipboard payload\n");
    }
  });
});
