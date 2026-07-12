/**
 * Emit-before-listen race coverage (#299).
 *
 * The backend streams results over Tauri events from a Rust thread that
 * starts the moment the command runs — often BEFORE the command's invoke()
 * promise resolves on the JS side. If the frontend attaches its listener too
 * late (or drops events that arrive before it learns the stream id), the
 * FIRST page of results is silently lost. That exact bug shipped three times
 * independently: QuickOpen results, the dir-listing stream, and content
 * search.
 *
 * Browser-mode Playwright cannot catch this family: the mock returns complete
 * results inline from invoke() and never exercises the event system. These
 * specs drive the real binary and assert the first event of each stream is
 * observed:
 *  - dir-listing: a >batch-size directory must render its FULL entry count
 *    (early chunks stream while invoke is still in flight);
 *  - QuickOpen: a fast-completing search's single results event must render;
 *  - content search: a single-match search's only event must render.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domText } from "./helpers";

describe("dir-listing stream: no lost early batches", () => {
  // 250 entries: the backend returns the first 100 inline and streams the
  // remaining 150 in chunks that start emitting immediately — the earliest
  // chunks routinely land before start_streaming_directory resolves.
  const FILE_COUNT = 250;
  const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-race-dir-"));

  before(() => {
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(path.join(scratchDir, `entry-${String(i).padStart(3, "0")}.txt`), "x\n");
    }
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("renders the full entry count of a large directory", async () => {
    await navigateTo(scratchDir);

    // The status bar reports the pane's full (non-virtualized) entry count.
    // If any streamed batch is dropped the count sticks at a multiple of the
    // batch size below the total, so this asserts every chunk arrived.
    await browser.waitUntil(
      async () => (await domText(".status-bar")).includes(`${FILE_COUNT} items`),
      {
        timeoutMsg: `status bar never reported ${FILE_COUNT} items (streamed batches lost?)`,
      },
    );
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
