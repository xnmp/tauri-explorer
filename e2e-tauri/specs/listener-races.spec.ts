/**
 * Native delivery contracts: complete directory snapshots and first search
 * events. Browser mocks return results inline and cannot verify native IPC
 * delivery or its timing. Search listeners must receive events emitted before
 * their invocation resolves; directory snapshots must contain every entry.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domText } from "./helpers";

describe("dir-listing snapshot: complete and keyboard-usable", () => {
  // Cross the former transport boundary by a non-round count. A snapshot
  // must publish the exact total and make its final virtualized row usable.
  const FILE_COUNT = 10_003;
  const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-race-dir-"));

  before(() => {
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(path.join(scratchDir, `entry-${String(i).padStart(5, "0")}.txt`), "x\n");
    }
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("renders the full entry count of a large directory", async () => {
    // Drive the actual navigation UI without requiring a dev-only hook. WebKit
    // Element Clear blurs this transient editor, so set and submit its input
    // atomically; the final selection below uses real WebDriver key events.
    await $(".file-list").waitForExist();
    await browser.keys(["Control", "l"]);
    await $(".path-input").waitForDisplayed();
    await browser.execute((directory: string) => {
      const input = document.querySelector<HTMLInputElement>(".path-input")!;
      input.value = directory;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, scratchDir);

    // The status bar reports the pane's full (non-virtualized) entry count.
    // The count must include every entry, including rows outside the viewport.
    await browser.waitUntil(
      async () => (await domText(".status-bar")).includes(`${FILE_COUNT} items`),
      {
        timeoutMsg: `status bar never reported ${FILE_COUNT} items (snapshot incomplete?)`,
      },
    );

    await browser.keys(["Control", "End"]);
    await browser.waitUntil(
      async () => (await browser.execute(() =>
        document.querySelector(".explorer-pane .entry-item.selected")?.textContent ?? "",
      )).includes("entry-10002.txt"),
      { timeoutMsg: "the last entry was not keyboard-selectable" },
    );
    await expect($(".explorer-pane .entry-item.selected")).toBeDisplayed();
    if (process.env.TAURI_DIRECTORY_STREAM_SCREENSHOT) {
      await browser.saveScreenshot(process.env.TAURI_DIRECTORY_STREAM_SCREENSHOT);
    }
  });
});

describe("QuickOpen: first results event of a fast search is not lost", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-race-qo-"));

  before(() => {
    // A tiny corpus makes the backend search complete almost instantly, so
    // its FIRST (and only) `search-results` event fires while invoke() may
    // still be in flight — the sharpest form of the race.
    fs.writeFileSync(path.join(scratchDir, "needle-alpha.txt"), "x\n");
    fs.writeFileSync(path.join(scratchDir, "needle-beta.txt"), "x\n");
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("streams the first page of results for an immediate query", async () => {
    await navigateTo(scratchDir);

    await browser.keys(["Control", "p"]);
    const input = $(".quick-open-dialog .search-input");
    await input.waitForDisplayed();
    await input.setValue("needle");

    // The scratch files have never been opened, so frecency/recents cannot
    // produce these rows — only the backend's streamed results can. If the
    // single results event is lost, the name never appears.
    await browser.waitUntil(
      async () => {
        const rows = await $$(".quick-open-dialog .result-item").length;
        if (rows === 0) return false;
        const text = await domText(".quick-open-dialog");
        return text.includes("needle-alpha.txt") && text.includes("needle-beta.txt");
      },
      { timeoutMsg: "QuickOpen never rendered the streamed results (first event lost?)" },
    );

    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () => !(await $(".quick-open-dialog").isExisting()),
      { timeoutMsg: "QuickOpen never closed" },
    );
  });
});

describe("content search: single-event search is not lost", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-race-cs-"));

  before(() => {
    // Exactly one match in one file: the whole search fits in ONE
    // content-search-results event, so losing the first event means losing
    // everything — no later chunk can mask the race.
    fs.writeFileSync(path.join(scratchDir, "only.txt"), "solitary-marker here\n");
    fs.writeFileSync(path.join(scratchDir, "other.txt"), "nothing to see\n");
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("renders the single match from the only streamed event", async () => {
    await navigateTo(scratchDir);

    await browser.keys(["Control", "Shift", "f"]);
    const input = $(".content-search-dialog .search-input");
    await input.waitForDisplayed();
    await input.setValue("solitary-marker");

    await browser.waitUntil(
      async () => (await $$(".result-item").length) > 0,
      { timeoutMsg: "the single-event search rendered nothing (first event lost?)" },
    );

    const text = await domText(".content-search-dialog");
    expect(text).toContain("only.txt");
    expect(text).not.toContain("other.txt");

    // Footer totals come from the same event stream — they must agree.
    await browser.waitUntil(
      async () => {
        const stats = await domText(".footer .stats");
        return stats.includes("1 matches in 1 files") || stats.includes("1 match");
      },
      { timeoutMsg: "footer never reported the single match" },
    );

    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () => !(await $(".content-search-dialog").isExisting()),
      { timeoutMsg: "content-search dialog never closed" },
    );
  });
});
