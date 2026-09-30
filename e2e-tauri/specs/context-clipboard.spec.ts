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
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { navigateTo, entryNames, domTexts } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";
import { captureDiagnostics } from "../diagnostics/window-transfer";
import {
  waitForListingEntry,
  type ListingWaitRequest,
  type RendererWaitResult,
} from "../window-transfer-waits";

const scratchDir = createNativeFixtureDirectory("tauri-explorer-e2e-clip-");

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

  it("right-click opens the app context menu on an entry", async () => {
    await navigateTo(scratchDir);

    const entry = $(".entry-item");
    await entry.waitForDisplayed({ timeout: 10_000 });
    await entry.click({ button: "right" });

    await $(".context-menu").waitForDisplayed({ timeout: 5000 });
    const labels = await domTexts(".context-menu .menu-item");
    expect(labels.join(" ")).toContain("Copy");
    const selected = await domTexts('.entry-item[aria-selected="true"] .entry-name');
    expect(selected).toContain("original.txt");
  });

  it("copy + background paste duplicates the file on disk", async () => {
    console.info(`[clipboard-smoke] copy click ${new Date().toISOString()}`);
    await clickMenuItem("Copy");
    console.info(`[clipboard-smoke] copy click returned ${new Date().toISOString()}`);

    // Background right-click (below the single entry row) → Paste.
    const content = $(".file-list .content");
    await content.click({ button: "right", x: 40, y: 200 });
    console.info(`[clipboard-smoke] paste click ${new Date().toISOString()}`);
    await clickMenuItem("Paste");
    console.info(`[clipboard-smoke] paste click returned ${new Date().toISOString()}`);

    // The paste lands as a real file (name may be suffixed on collision —
    // here there is none, but assert on disk contents, not just the UI).
    const observed = await browser.executeAsync<
      RendererWaitResult<true>,
      [ListingWaitRequest]
    >(waitForListingEntry, {
      name: "original",
      match: "contains",
      minCount: 2,
      timeoutMs: 15_000,
    });
    if (!observed.ok) {
      const diskEntries = fs.readdirSync(scratchDir);
      const renderedEntries = await entryNames();
      console.info(`[clipboard-smoke] listing timeout ${new Date().toISOString()}`);
      await captureDiagnostics("clipboard-paste-listing", { diskEntries, renderedEntries });
      throw new Error(observed.reason);
    }
    const copies = fs
      .readdirSync(scratchDir)
      .filter((n) => n.includes("original") && n.endsWith(".txt"));
    expect(copies.length).toBeGreaterThanOrEqual(2);
    for (const name of copies) {
      expect(fs.readFileSync(path.join(scratchDir, name), "utf8")).toBe("clipboard payload\n");
    }
    if (process.platform === "win32") {
      fs.mkdirSync("e2e-tauri/logs", { recursive: true });
      await browser.saveScreenshot("e2e-tauri/logs/context-clipboard-paste-success.png")
        .catch((error) => console.warn(`[clipboard-smoke] success screenshot unavailable: ${error}`));
    }
  });

  it("external Copy of the same path overrides app Cut and duplicates the file", async function () {
    if (process.platform !== "linux" || process.env.WAYLAND_DISPLAY) this.skip();
    await navigateTo(scratchDir);
    const source = path.join(scratchDir, "original.txt");
    const before = fs.readdirSync(scratchDir).filter((name) => name.includes("original") && name.endsWith(".txt"));
    const rows = await $$(".entry-item").getElements();
    let selected = false;
    for (const row of rows) {
      const name = ((await row.$(".entry-name").getProperty("textContent")) as string | null)?.trim();
      if (name === "original.txt") {
        await row.click({ button: "right" });
        selected = true;
        break;
      }
    }
    expect(selected).toBe(true);
    await clickMenuItem("Cut");

    // New X11 owner, identical URI, no app token. The native snapshot must
    // demote this selection to Copy despite matching the previous Cut paths.
    execFileSync("xclip", ["-selection", "clipboard", "-t", "x-special/gnome-copied-files", "-i"], {
      input: `copy\n${pathToFileURL(source).href}\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const content = $(".file-list .content");
    await content.click({ button: "right", x: 40, y: 200 });
    await clickMenuItem("Paste");

    const observed = await browser.executeAsync<RendererWaitResult<true>, [ListingWaitRequest]>(
      waitForListingEntry,
      { name: "original", match: "contains", minCount: before.length + 1, timeoutMs: 15_000 },
    );
    if (!observed.ok) throw new Error(observed.reason);
    const after = fs.readdirSync(scratchDir).filter((name) => name.includes("original") && name.endsWith(".txt"));
    expect(after.length).toBe(before.length + 1);
    expect(fs.readFileSync(source, "utf8")).toBe("clipboard payload\n");
    for (const name of after) {
      expect(fs.readFileSync(path.join(scratchDir, name), "utf8")).toBe("clipboard payload\n");
    }
    await browser.keys("Escape");
    await $(".context-menu").waitForDisplayed({ reverse: true, timeout: 5_000 });
    await $(".toast.clipboard").waitForDisplayed({ reverse: true, timeout: 6_000 });
    fs.mkdirSync("screenshots/fix/clipboard-cross-window-order", { recursive: true });
    await browser.saveScreenshot("screenshots/fix/clipboard-cross-window-order/native-same-path-external-copy.png");
  });
});
